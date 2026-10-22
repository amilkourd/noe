// Snapshot builder for GET /api/state (everything a surface needs on load / reconnect).
import type {
  AgentLog, DoveCall, Exposure, Forecast, Insight, Mission, NoeState, Observation, Rescuer, Resident, Site, Station, StatusReport,
} from "./types";
import { one, query } from "./db";
import { PERIMETER, getClock, getFlood, getRuntime, isPerimeterActive } from "./replay";

/** Best forecast: the one the pipeline picked (in memory), else the most confident of the latest sim_time. */
export async function latestBestForecast(): Promise<Forecast | null> {
  const rt = getRuntime();
  if (rt.bestForecastId != null) {
    const f = await one<Forecast>("select * from forecasts where id = $1", [rt.bestForecastId]);
    if (f) return f;
  }
  return one<Forecast>(
    "select * from forecasts where sim_time = (select max(sim_time) from forecasts) order by confidence desc, id desc limit 1",
  );
}

export async function buildState(): Promise<NoeState> {
  const clock = getClock();
  const [stations, observations, forecastsDesc, latestForecast, sites, residents, rescuers, missions, statuses, insights, logsDesc, doveCalls, perimeterActive] =
    await Promise.all([
      query<Station>("select code, name, river, role, lat, lon, threshold_m, threshold_label from stations order by code"),
      query<Observation>("select station_code, ts, h_m, source from observations where ts <= $1 order by station_code, ts", [clock.simTime]),
      query<Forecast>("select * from forecasts order by id desc limit 12"),
      latestBestForecast(),
      query<Site>("select id, kind, name, capacity, lat, lon, elevation_m, source from sites order by id"),
      query<Resident>("select id, name, age, language, mobility, floor, address, lat, lon, elevation_m, persona from residents order by id"),
      query<Rescuer>("select * from rescuers order by id"),
      query<Mission>("select * from missions order by id"),
      query<StatusReport>("select distinct on (resident_id) * from status_reports order by resident_id, created_at desc, id desc"),
      query<Insight>("select * from insights where status = 'open' order by priority asc nulls last, id desc"),
      query<AgentLog>("select * from agent_log order by id desc limit 50"),
      query<DoveCall>("select * from dove_calls order by id"),
      isPerimeterActive(),
    ]);
  const exposures = latestForecast
    ? await query<Exposure>("select * from exposures where forecast_id = $1 order by priority desc", [latestForecast.id])
    : [];
  return {
    clock,
    stations,
    observations,
    latestForecast,
    forecasts: forecastsDesc.reverse(), // oldest -> newest
    exposures,
    flood: getFlood(),
    sites,
    residents,
    rescuers,
    missions,
    statuses,
    insights,
    logs: logsDesc.reverse(), // oldest -> newest
    doveCalls,
    perimeter: { active: perimeterActive, center: PERIMETER.center, radiusKm: PERIMETER.radiusKm },
  };
}

// ---------------------------------------------------------------- route helpers
import type { z } from "zod";

export function jsonError(status: number, error: string, extra?: Record<string, unknown>): Response {
  return Response.json({ error, ...(extra ?? {}) }, { status });
}

/** Parse + validate a JSON body. Returns the data or a 400 Response. */
export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S> | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, "Body must be JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    return jsonError(400, "Invalid body", { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  return r.data;
}

/** Wrap a handler: missing DB credentials -> 503, other errors -> 500 (JSON). */
export async function guard(fn: () => Promise<Response>): Promise<Response> {
  if (!process.env.DATABASE_URL) return jsonError(503, "Database not configured (DATABASE_URL missing)");
  try {
    return await fn();
  } catch (err: any) {
    console.error("[api]", err);
    return jsonError(500, String(err?.message ?? err));
  }
}

// ---------------------------------------------------------------- targets + water (same rule as lib/dispatcher.ts)
import type { Mobility } from "./types";
import { cellOf } from "./terrain";
import { floodGrid } from "./exposure";
import { safeTerrain } from "./replay";

const WET_M = 0.05;

export interface TargetInfo {
  type: "site" | "resident"; id: string; name: string; lat: number; lon: number; persona: boolean;
  age: number | null; language: string | null; mobility: Mobility | null; address: string | null; kind: string | null;
}

export async function loadTarget(type: "site" | "resident", id: string): Promise<TargetInfo | null> {
  if (type === "site") {
    const s = await one<Site>("select id, kind, name, capacity, lat, lon, elevation_m, source from sites where id = $1", [id]);
    if (!s) return null;
    return { type, id: s.id, name: s.name, lat: s.lat, lon: s.lon, persona: false, age: null, language: null, mobility: null, address: null, kind: s.kind };
  }
  const r = await one<Resident>("select * from residents where id = $1", [id]);
  if (!r) return null;
  return {
    type, id: r.id, name: r.name, lat: r.lat, lon: r.lon, persona: r.persona, age: r.age, language: r.language,
    mobility: r.mobility, address: r.address, kind: null,
  };
}

/** Latest gauge levels at the current sim time, from the DB (used when the engine has none in memory, e.g. after a restart). */
export async function hNowFromDb(): Promise<Record<string, number>> {
  const rows = await query<{ station_code: string; h_m: number }>(
    "select distinct on (station_code) station_code, h_m from observations where ts <= $1 order by station_code, ts desc",
    [getClock().simTime],
  );
  return Object.fromEntries(rows.map((r) => [r.station_code, r.h_m]));
}

/** Water at a point: now (current gauges), peak and first wet time over the latest projection. Null when no model yet. */
export function waterAt(
  lat: number, lon: number, hNowOverride?: Record<string, number>,
): { nowM: number | null; peakM: number | null; eta: string | null; hasWater: boolean } {
  const grid = safeTerrain();
  const rt = getRuntime();
  const hNow = hNowOverride && Object.keys(hNowOverride).length ? hNowOverride : rt.hNow;
  if (!grid || !Object.keys(hNow).length) return { nowM: null, peakM: null, eta: null, hasWater: false };
  const cell = cellOf(grid, lat, lon);
  if (cell < 0) return { nowM: 0, peakM: 0, eta: null, hasWater: false };
  const now = floodGrid(grid, hNow)[cell] ?? 0;
  let peak = now;
  let eta: string | null = null;
  for (const p of rt.projection) {
    if (Date.parse(p.t) <= rt.simMs) continue;
    const d = floodGrid(grid, p.h)[cell] ?? 0;
    if (d > peak) peak = d;
    if (!eta && now <= WET_M && d > WET_M) eta = p.t;
  }
  const r2 = (x: number) => Math.round(Math.max(0, x) * 100) / 100;
  return { nowM: r2(now), peakM: r2(peak), eta, hasWater: now > WET_M };
}
