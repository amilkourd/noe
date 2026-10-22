// RAVEN state: polls NOÉ for this rescuer's view and runs the duty / mission actions optimistically.
import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import * as Location from "expo-location";
import type { MissionStatus, RavenView } from "./types";
import { client, type RavenClient } from "./client";
import { SEND_GPS } from "./config";
import { canRequestBackup } from "./mission";

export type Phase = "connecting" | "calm" | "alert" | "standby" | "mission";

export interface Raven {
  phase: Phase;
  view: RavenView | null;
  online: boolean;
  error: string | null;
  busy: boolean;
  completed: { number: string; key: number } | null;
  setAvailable(next: boolean): Promise<void>;
  advance(): Promise<void>;
  requestBackup(): Promise<void>;
  retry(): void;
}

const OFFLINE_AFTER = 3; // consecutive failed polls
const GPS_TIMEOUT_MS = 5000;

function phaseOf(v: RavenView | null): Phase {
  if (!v) return "connecting";
  if (v.mission) return "mission";
  if (v.alert) return v.rescuer.available ? "standby" : "alert";
  return "calm";
}

function pollDelay(v: RavenView | null, online: boolean): number {
  if (!v || !online) return 2000;
  return phaseOf(v) === "calm" ? 4000 : 1000;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withStatus(v: RavenView, status: MissionStatus): RavenView {
  return v.mission ? { ...v, mission: { ...v.mission, mission: { ...v.mission.mission, status } } } : v;
}

type Pos = { lat: number; lon: number };
type MissionView = NonNullable<RavenView["mission"]>;

/** Best effort: null when permission is refused or no fix arrives in time. */
async function currentPosition(): Promise<Pos | null> {
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== "granted") return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), GPS_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    const last = fix ?? (await Location.getLastKnownPositionAsync().catch(() => null));
    return last ? { lat: last.coords.latitude, lon: last.coords.longitude } : null;
  } catch {
    return null;
  }
}

interface Sink {
  view(v: RavenView | null): void;
  online(on: boolean): void;
  error(e: string | null): void;
  busy(b: boolean): void;
  completed(c: { number: string; key: number }): void;
}

/**
 * The polling / action state machine, without React. Polls are a setTimeout chain with at most one request in
 * flight. Every action bumps `version` and aborts the poll in flight, and no poll starts while an action runs,
 * so a response fetched before the action can never overwrite its optimistic view.
 */
export function createRavenEngine(api: RavenClient, sink: Sink, locate: (() => Promise<Pos | null>) | null) {
  let view: RavenView | null = null;
  let alive = false;
  let active = true;
  let busy = false;
  let failures = 0;
  let version = 0;
  let completedKey = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;
  const announced = new Set<number>();

  function commit(v: RavenView | null) {
    view = v;
    if (alive) sink.view(v);
  }

  function announce(m: MissionView) {
    if (announced.has(m.mission.id)) return;
    announced.add(m.mission.id);
    completedKey += 1;
    if (alive) sink.completed({ number: m.number, key: completedKey });
  }

  function applyPolled(next: RavenView) {
    // A replay reset rewinds the clock and deletes the missions (ids restart at 1): nothing was completed.
    const rewound = view != null && Date.parse(next.clock.simTime) < Date.parse(view.clock.simTime);
    if (rewound) announced.clear();
    const prev = rewound ? null : view?.mission;
    const cur = next.mission;
    // a mission we were on that is gone from the view was closed (by us or by dispatch)
    if (prev && cur?.mission.id !== prev.mission.id) announce(prev);
    if (cur?.mission.status === "done") announce(cur);
    else if (cur) announced.delete(cur.mission.id); // live again (e.g. replay reset): may complete again later
    commit(next);
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function abortPoll() {
    inflight?.abort();
    inflight = null;
  }

  function schedule(ms: number) {
    clearTimer();
    if (alive && active) timer = setTimeout(poll, ms);
  }

  async function poll(): Promise<void> {
    clearTimer();
    if (!alive || !active || busy || inflight) return; // a running action polls when it ends
    const ctrl = new AbortController();
    inflight = ctrl;
    const started = version;
    try {
      const next = await api.getView(ctrl.signal);
      if (ctrl.signal.aborted || started !== version) return;
      failures = 0;
      sink.online(true);
      sink.error(null);
      applyPolled(next);
    } catch (err) {
      if (ctrl.signal.aborted || started !== version) return;
      failures += 1;
      sink.error(message(err));
      if (failures >= OFFLINE_AFTER) sink.online(false);
    } finally {
      // aborted polls were detached by whoever aborted them, and that party restarts the chain
      if (inflight === ctrl) {
        inflight = null;
        schedule(pollDelay(view, failures < OFFLINE_AFTER));
      }
    }
  }

  /**
   * Apply `optimistic` at once, run `exec`, then poll. On failure the view goes back to `fallback` (the view
   * before the action, moved forward by `confirm` for steps the server already accepted) and the error is rethrown.
   * A second action while one runs is ignored.
   */
  async function act(
    optimistic: (v: RavenView) => RavenView,
    exec: (confirm: (step: (v: RavenView) => RavenView) => void) => Promise<void>,
    onSuccess?: () => void,
  ): Promise<void> {
    const before = view;
    if (busy || !before) return;
    busy = true;
    version += 1;
    clearTimer();
    abortPoll();
    if (alive) sink.busy(true);
    let fallback = before;
    commit(optimistic(before));
    try {
      await exec((step) => { fallback = step(fallback); });
      onSuccess?.();
    } catch (err) {
      commit(fallback);
      throw err;
    } finally {
      busy = false;
      if (alive) sink.busy(false);
      void poll();
    }
  }

  function setAvailable(next: boolean): Promise<void> {
    return act(
      (v) => ({ ...v, rescuer: { ...v.rescuer, available: next } }),
      async () => {
        const pos = next && locate ? await locate() : null;
        await api.setAvailable(next, pos);
      },
    );
  }

  function advance(): Promise<void> {
    const m = view?.mission;
    if (!m || busy) return Promise.resolve();
    const id = m.mission.id;
    switch (m.mission.status) {
      case "sent":
        // "Accept" also sets off; two PATCHes so NOÉ logs both steps
        return act((v) => withStatus(v, "en_route"), async (confirm) => {
          await api.setMissionStatus(id, "accepted");
          confirm((v) => withStatus(v, "accepted"));
          await api.setMissionStatus(id, "en_route");
        });
      case "accepted":
        return act((v) => withStatus(v, "en_route"), () => api.setMissionStatus(id, "en_route"));
      case "en_route":
        return act((v) => withStatus(v, "on_site"), () => api.setMissionStatus(id, "on_site"));
      case "on_site":
      case "backup":
        return act((v) => ({ ...v, mission: null }), () => api.setMissionStatus(id, "done"), () => announce(m));
      default:
        return Promise.resolve();
    }
  }

  function requestBackup(): Promise<void> {
    const m = view?.mission;
    if (!m || busy || !canRequestBackup(m.mission.status)) return Promise.resolve();
    return act((v) => withStatus(v, "backup"), () => api.setMissionStatus(m.mission.id, "backup"));
  }

  function retry(): void {
    void poll();
  }

  /** Pause polling while the app is not in the foreground; poll at once when it comes back. */
  function setActive(next: boolean): void {
    if (next === active) return;
    active = next;
    if (active) void poll();
    else {
      clearTimer();
      abortPoll();
    }
  }

  /** Start polling; returns the stop function (safe to start again, e.g. under StrictMode). */
  function start(initiallyActive: boolean): () => void {
    alive = true;
    active = initiallyActive;
    void poll();
    return () => {
      alive = false;
      clearTimer();
      abortPoll();
    };
  }

  return { start, setActive, setAvailable, advance, requestBackup, retry };
}

export function useRaven(): Raven {
  const [view, setView] = useState<RavenView | null>(null);
  const [online, setOnline] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<Raven["completed"]>(null);
  const [engine] = useState(() =>
    createRavenEngine(
      client,
      { view: setView, online: setOnline, error: setError, busy: setBusy, completed: setCompleted },
      SEND_GPS ? currentPosition : null,
    ),
  );

  useEffect(() => {
    // currentState can be null/"unknown" right at launch: treat that as foreground
    const s = AppState.currentState;
    const stop = engine.start(s !== "background" && s !== "inactive");
    const sub = AppState.addEventListener("change", (next) => engine.setActive(next === "active"));
    return () => {
      sub.remove();
      stop();
    };
  }, [engine]);

  const phase = phaseOf(view);
  return useMemo(
    () => ({
      phase, view, online, error, busy, completed,
      setAvailable: engine.setAvailable, advance: engine.advance, requestBackup: engine.requestBackup, retry: engine.retry,
    }),
    [phase, view, online, error, busy, completed, engine],
  );
}
