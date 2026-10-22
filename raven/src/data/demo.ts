// Scripted in-memory NOÉ for EXPO_PUBLIC_RAVEN_DEMO=1. Same rules as GET /api/raven/[rescuerId],
// PATCH /api/rescuers/:id and PATCH /api/missions/:id, driven by a replay clock (×60) that starts on first use.
// No React Native imports, so it also runs under node.
import type { Mission, MissionStatus, RavenView, Rescuer } from "./types";
import type { RavenClient } from "./client";

const MIN = 60_000;
const SPEED = 60;
const SIM_START = Date.parse("2026-10-19T19:30:00Z");
const SIM_END = Date.parse("2026-10-20T12:00:00Z"); // end of the server's replay window
const ALERT_AFTER_MS = 6_000; // real time after first use
const DISPATCH_AFTER_MS = 4_000; // real time after the rescuer is available during the alert
const OVERFLOW_ETA = new Date(SIM_START + 100 * MIN).toISOString();
const CONFIDENCE = 0.82;
const PERIMETER = { center: { lat: 43.784, lon: 4.089 }, radiusKm: 15 }; // lib/sim.ts
const WET_M = 0.05; // lib/state.ts, same as mission.ts (not imported: this file has only type imports so plain node runs it)
// water at the target: starts shortly after dispatch (so "Water in" shows first), then 0 -> 1.1 m over 90 sim min
const WATER_DELAY = 10 * MIN;
const WATER_RISE = 90 * MIN;
const WATER_MAX_M = 1.1;
const WATER_PEAK_M = 1.4;
const ROUTE_NOTE = "Avenue Emile Jamais is cut, go in via the Rue de la Taillade";
const STATUSES: MissionStatus[] = ["sent", "accepted", "en_route", "on_site", "done", "backup"];

// 3.2 km SW of the perimeter centre; the target is 2.4 km NE of the rescuer (0.8 km SW of the centre)
const HOME = { lat: 43.763647, lon: 4.060823 };
const TARGET = {
  type: "resident" as const, id: "res-garcia", name: "Señora García", age: 84, language: "es", mobility: "reduced" as const,
  canClimbStairs: false, address: "4 rue du Pont, Sommières", lat: 43.778907, lon: 4.081961, persona: true,
};

function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// lib/dispatcher.ts
function etaMinutes(distanceM: number): number {
  return Math.round((distanceM * 1.4) / 500 + 3);
}

const iso = (ms: number) => new Date(ms).toISOString();
const r2 = (x: number) => Math.round(Math.max(0, x) * 100) / 100;

function abortError(): Error {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

export function createDemoClient(opts: { now?: () => number; latencyMs?: number } = {}): RavenClient {
  const now = opts.now ?? Date.now;
  const latencyMs = opts.latencyMs ?? 150;
  let t0: number | null = null; // real ms of the first request
  let availableSince: number | null = null;
  let mission: Mission | null = null; // kept once done, like the row in the database
  let missionSimMs = 0;
  const rescuer: Rescuer = {
    id: "rb-karim", name: "Karim Becker", org: "DLRG", country: "DE", tier: "T3", available: false,
    lat: HOME.lat, lon: HOME.lon, home_lat: HOME.lat, home_lon: HOME.lon, updated_at: iso(now()), persona: true,
  };

  const start = () => (t0 ??= now());
  const simAt = (real: number) => Math.min(SIM_END, SIM_START + (real - start()) * SPEED);
  const alertAt = () => start() + ALERT_AFTER_MS;

  // Materialize everything the script has scheduled up to `real` (idempotent).
  function advanceTo(real: number) {
    if (mission || availableSince === null) return;
    const due = Math.max(availableSince, alertAt()) + DISPATCH_AFTER_MS;
    if (real < due) return;
    missionSimMs = simAt(due);
    mission = {
      id: 7, created_at: iso(due), rescuer_id: rescuer.id, target_type: "resident", target_id: TARGET.id,
      route_note: ROUTE_NOTE, required_tier: "T3", insight_id: null, status: "sent",
    };
  }

  function waterAt(simMs: number) {
    const wetFrom = missionSimMs + WATER_DELAY;
    const nowM = WATER_MAX_M * Math.min(1, Math.max(0, (simMs - wetFrom) / WATER_RISE));
    return {
      nowM: r2(nowM),
      peakM: r2(Math.max(WATER_PEAK_M, nowM)),
      eta: nowM <= WET_M ? iso(wetFrom + (WET_M / WATER_MAX_M) * WATER_RISE) : null,
      hasWater: nowM > WET_M,
    };
  }

  function view(real: number): RavenView {
    advanceTo(real);
    const simMs = simAt(real);
    const pos = rescuer.lat != null && rescuer.lon != null
      ? { lat: rescuer.lat, lon: rescuer.lon }
      : rescuer.home_lat != null && rescuer.home_lon != null ? { lat: rescuer.home_lat, lon: rescuer.home_lon } : null;

    let alert: RavenView["alert"] = null;
    if (real >= alertAt() && pos) {
      const distanceKm = haversineM(pos, PERIMETER.center) / 1000;
      if (distanceKm <= PERIMETER.radiusKm) {
        alert = { title: "Flood emergency · Vidourle", distanceKm: Math.round(distanceKm * 10) / 10, overflowEta: OVERFLOW_ETA, confidence: CONFIDENCE };
      }
    }

    let m: RavenView["mission"] = null;
    if (mission && mission.status !== "done") {
      const water = waterAt(simMs);
      const distanceM = pos ? Math.round(haversineM(pos, TARGET)) : 0;
      m = {
        mission: { ...mission },
        number: String(mission.id).padStart(2, "0"),
        target: { ...TARGET },
        waterNowM: water.nowM,
        waterPeakM: water.peakM,
        waterEta: water.eta,
        routeNote: mission.route_note,
        distanceM,
        etaMin: etaMinutes(distanceM),
        hazards: [...(water.hasWater ? ["Moving water"] : []), "Debris", "Power lines"],
      };
    }
    // fresh objects every time: the app patches views optimistically
    return {
      clock: { simTime: iso(simMs), speed: SPEED, running: simMs < SIM_END, start: iso(SIM_START), end: iso(SIM_END), mode: "REPLAY" },
      rescuer: { ...rescuer },
      alert,
      mission: m,
    };
  }

  return {
    async getView(signal) {
      start();
      await wait(latencyMs, signal);
      return view(now());
    },
    async setAvailable(available) {
      start();
      await wait(latencyMs);
      const real = now();
      advanceTo(real);
      // the persona keeps its seeded position (the route ignores a demo phone's GPS)
      if (available && !rescuer.available) availableSince = real;
      if (!available) availableSince = null;
      rescuer.available = available;
      rescuer.updated_at = iso(real);
    },
    async setMissionStatus(missionId, status) {
      start();
      await wait(latencyMs);
      advanceTo(now());
      if (!STATUSES.includes(status)) throw new Error("Invalid body");
      if (!mission || mission.id !== missionId) throw new Error(`Mission ${missionId} not found`);
      mission.status = status;
    },
  };
}

export const demoClient: RavenClient = createDemoClient();
