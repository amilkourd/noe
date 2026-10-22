"use client";

// ARK data: GET /api/state snapshot + the full SSE stream (/api/stream) folded into it.
// The stream opens first; events are buffered while a snapshot is loading and replayed on top of it,
// so nothing committed between the snapshot queries and the subscription is lost. Every (re)connect
// and every reset triggers a fresh snapshot.
import { useEffect, useReducer, useRef, useState } from "react";
import type {
  AgentLog, DoveCall, Exposure, Forecast, Insight, Mission, NoeEvent, NoeState, Observation, Rescuer, StatusReport,
} from "@/lib/types";

export type Conn = "connecting" | "live" | "offline" | "no_db";

type Action = { type: "snapshot"; state: NoeState; buffered: NoeEvent[] } | { type: "event"; e: NoeEvent };

const MAX_LOGS = 80;

function upsert<T extends { id: number }>(list: T[], row: T): T[] {
  const i = list.findIndex((x) => x.id === row.id);
  if (i < 0) return [...list, row];
  const next = list.slice();
  next[i] = row;
  return next;
}

function sortInsights(list: Insight[]): Insight[] {
  return list.slice().sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || b.id - a.id);
}

/** Point latestForecast at the forecast the pipeline picked, and keep only that forecast's exposures. */
function pickForecast(s: NoeState, id: number): NoeState {
  const f = s.forecasts.find((x) => x.id === id);
  if (!f || s.latestForecast?.id === id) return s;
  return { ...s, latestForecast: f, exposures: s.exposures.filter((x) => x.forecast_id === id) };
}

function apply(s: NoeState, e: NoeEvent): NoeState {
  switch (e.table) {
    case "clock":
      return { ...s, clock: e.row };
    case "flood":
      return { ...s, flood: e.row };
    case "observations": {
      const row = e.row as Observation;
      if (s.observations.some((o) => o.station_code === row.station_code && Date.parse(o.ts) === Date.parse(row.ts))) return s;
      return { ...s, observations: [...s.observations, row] };
    }
    case "forecasts": {
      // The pipeline's pick arrives with the forecaster log (agent_log data.forecastId); until then keep the current one.
      const forecasts = upsert(s.forecasts, e.row as Forecast).slice(-12);
      return { ...s, forecasts, latestForecast: s.latestForecast ?? (e.row as Forecast) };
    }
    case "exposures": {
      // Exposures are only written for the pipeline's best forecast, so a row for another forecast means it changed.
      const row = e.row as Exposure;
      const current = s.exposures[0]?.forecast_id ?? s.latestForecast?.id ?? -1;
      if (row.forecast_id < current) return s;
      const next = row.forecast_id === current ? s : pickForecast(s, row.forecast_id);
      const base = next.exposures.filter((x) => x.forecast_id === row.forecast_id);
      return { ...next, exposures: upsert(base, row) };
    }
    case "status_reports": {
      const row = e.row as StatusReport;
      const prev = s.statuses.find((x) => x.resident_id === row.resident_id);
      if (prev) {
        const a = Date.parse(prev.created_at), b = Date.parse(row.created_at);
        if (a > b || (a === b && prev.id > row.id)) return s;
      }
      return { ...s, statuses: [...s.statuses.filter((x) => x.resident_id !== row.resident_id), row] };
    }
    case "insights": {
      const row = e.row as Insight;
      const rest = s.insights.filter((x) => x.id !== row.id);
      return { ...s, insights: row.status === "open" ? sortInsights([...rest, row]) : rest };
    }
    case "missions":
      return { ...s, missions: upsert(s.missions, e.row as Mission) };
    case "rescuers": {
      const row = e.row as Rescuer;
      const i = s.rescuers.findIndex((x) => x.id === row.id);
      const rescuers = s.rescuers.slice();
      if (i < 0) rescuers.push(row); else rescuers[i] = row;
      return { ...s, rescuers };
    }
    case "dove_calls":
      return { ...s, doveCalls: upsert(s.doveCalls, e.row as DoveCall) };
    case "agent_log": {
      const row = e.row as AgentLog;
      const data = row.data as { perimeter?: boolean; forecastId?: number } | null;
      let next: NoeState = { ...s, logs: upsert(s.logs, row).slice(-MAX_LOGS) };
      if (data?.perimeter) next = { ...next, perimeter: { ...next.perimeter, active: true } };
      if (row.agent === "forecaster" && typeof data?.forecastId === "number") next = pickForecast(next, data.forecastId);
      return next;
    }
    default:
      return s;
  }
}

function reduce(s: NoeState | null, a: Action): NoeState | null {
  if (a.type === "snapshot") return a.buffered.reduce(apply, a.state);
  return s ? apply(s, a.e) : s;
}

export function useNoe() {
  const [state, dispatch] = useReducer(reduce, null);
  const [conn, setConn] = useState<Conn>("connecting");
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);                     // bumps on every snapshot request; stale responses are dropped
  const buffer = useRef<NoeEvent[] | null>([]); // non-null while a snapshot is loading
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000;

    const load = async (): Promise<void> => {
      if (closed) return;
      const my = ++gen.current;
      buffer.current = []; // the new snapshot covers everything before this point
      if (retry.current) { clearTimeout(retry.current); retry.current = null; }
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        if (my !== gen.current) return;
        if (r.status === 503) {
          setConn("no_db");
          setError("Database not configured (DATABASE_URL)");
          retry.current = setTimeout(() => { void load(); }, 15_000);
          return;
        }
        if (!r.ok) throw new Error(`Snapshot failed (${r.status})`);
        const snap = (await r.json()) as NoeState;
        if (my !== gen.current) return;
        const buffered = buffer.current ?? [];
        buffer.current = null;
        dispatch({ type: "snapshot", state: snap, buffered });
        failures.current = 0;
        setError(null);
        setConn((c) => (c === "offline" ? c : "live"));
      } catch (err) {
        if (my !== gen.current) return;
        setError(String((err as Error)?.message ?? err));
        const delay = Math.min(15_000, 1000 * 2 ** failures.current++);
        retry.current = setTimeout(() => { void load(); }, delay);
      }
    };

    const connect = () => {
      es = new EventSource("/api/stream");
      es.onopen = () => {
        backoff = 1000;
        setConn((c) => (c === "no_db" ? c : "live"));
        void load(); // first open and every reconnect: resync from a snapshot taken after the subscription
      };
      es.onerror = () => {
        if (closed) return;
        setConn((c) => (c === "no_db" ? c : "offline"));
        // The browser retries on its own unless the response was not an event stream (proxy 502, restart...).
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          reconnect = setTimeout(connect, backoff);
          backoff = Math.min(30_000, backoff * 2);
        }
      };
      es.onmessage = (m) => {
        let e: NoeEvent;
        try { e = JSON.parse(m.data) as NoeEvent; } catch { return; }
        if (e.table === "reset" || e.table === "resync") { void load(); return; }
        if (buffer.current) {
          buffer.current.push(e);
          if (buffer.current.length > 5000) void load(); // snapshot is taking too long: start over with a fresh one
        }
        else dispatch({ type: "event", e });
      };
    };
    connect();

    return () => {
      closed = true;
      es?.close();
      if (reconnect) clearTimeout(reconnect);
      if (retry.current) clearTimeout(retry.current);
    };
  }, []);

  return { state, conn, error };
}

// ---------------------------------------------------------------- operator actions

export interface ActionResult { ok: boolean; message?: string; code?: string }

async function call(url: string, method: string, body: unknown): Promise<ActionResult> {
  try {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return { ok: true };
    const j = (await r.json().catch(() => null)) as { error?: string; code?: string } | null;
    return { ok: false, message: j?.error ?? `Request failed (${r.status})`, code: j?.code };
  } catch (err) {
    return { ok: false, message: String((err as Error)?.message ?? err) };
  }
}

export function sendMission(i: Insight): Promise<ActionResult> {
  const p = i.action.payload;
  return call("/api/missions", "POST", {
    rescuerId: p.rescuerId, targetType: p.targetType, targetId: p.targetId,
    routeNote: p.routeNote ?? null, requiredTier: p.requiredTier ?? "T1", insightId: i.id,
  });
}

/** Manual order from ARK (no Copilot suggestion): the server still enforces the T3 water rule. */
export function sendRescuer(rescuerId: string, targetType: "site" | "resident", targetId: string, requiredTier: "T1" | "T3"): Promise<ActionResult> {
  return call("/api/missions", "POST", { rescuerId, targetType, targetId, requiredTier, routeNote: null, insightId: null });
}

export function setInsight(id: number, status: "accepted" | "dismissed"): Promise<ActionResult> {
  return call(`/api/insights/${id}`, "PATCH", { status });
}

export function replay(action: "start" | "pause" | "reset" | "speed", speed?: number): Promise<ActionResult> {
  return call("/api/replay", "POST", speed == null ? { action } : { action, speed });
}
