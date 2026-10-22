// Simulated demo personas: resident call outcomes and rescuer availability.
// Deterministic per id (seeded PRNG), scheduled in SIM time and executed by the replay tick.
import type { AgentName, Rescuer, Resident, Tier } from "./types";
import { query, one } from "./db";

export const REAL_PHONE_RESIDENT = "res-garcia"; // answered on the DOVE page
export const REAL_PHONE_RESCUER = "rb-karim"; // becomes available from the RAVEN phone
export const PERIMETER_CENTER = { lat: 43.784, lon: 4.089 }; // Sommières centre
export const PERIMETER_RADIUS_KM = 15;

// ---------- small shared helpers ----------
const PARIS_HHMM = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hour12: false });
export function hhmm(iso: string | Date | null | undefined): string {
  if (!iso) return "--:--";
  return PARIS_HHMM.format(typeof iso === "string" ? new Date(iso) : iso);
}
/** "Karim Becker" -> "K. Becker" */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}
export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
export function missionNumber(id: number): string {
  return String(id).padStart(2, "0");
}
export function rescuerLabel(r: { name: string; tier: Tier }): string {
  return `${shortName(r.name)} (${r.tier})`;
}

// ---------- seeded PRNG ----------
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function seededRand(id: string, salt = "noe"): () => number {
  return mulberry32(hashStr(`${salt}:${id}`));
}

// ---------- queue ----------
export type SimItem =
  | { kind: "resident"; dueMs: number; residentId: string; doveCallId: number; outcome: "safe" | "unstable" | "needs_help" | "missed" }
  | { kind: "rescuer"; dueMs: number; rescuerId: string }
  // a persona that cannot climb stairs, re-checked until the water reaches its door
  | { kind: "escalate"; dueMs: number; residentId: string; name: string; lat: number; lon: number };

export interface SimCtx {
  simIso: () => string;
  log: (agent: AgentName, message: string, data?: unknown) => Promise<void>;
  notifyNeed: (kind: "needs_help" | "rescuer_available") => void;
  stale: () => boolean; // true if a reset happened since the item was scheduled
  wetAt: (lat: number, lon: number) => boolean; // water at this point on the flood layer ARK shows (approximate model)
}

const MIN = 60_000;
const ESCALATE_STEP_MS = 5 * MIN;

export function scheduleResidentOutcome(queue: SimItem[], residentId: string, doveCallId: number, callSimMs: number): void {
  if (residentId === REAL_PHONE_RESIDENT) return;
  const rnd = seededRand(residentId, "dove");
  const delay = (3 + rnd() * 17) * MIN; // 3..20 sim-min
  const r = rnd();
  // unstable is carved out of the old safe range, so the same personas still need help as before
  const outcome = r < 0.7 ? "safe" : r < 0.84 ? "unstable" : r < 0.9 ? "needs_help" : "missed";
  queue.push({ kind: "resident", dueMs: callSimMs + delay, residentId, doveCallId, outcome });
}

export function scheduleRescuers(queue: SimItem[], rescuers: Pick<Rescuer, "id" | "available">[], perimeterSimMs: number): void {
  for (const r of rescuers) {
    if (r.id === REAL_PHONE_RESCUER || r.available) continue;
    const rnd = seededRand(r.id, "raven");
    const delay = (2 + rnd() * 38) * MIN; // 2..40 sim-min
    queue.push({ kind: "rescuer", dueMs: perimeterSimMs + delay, rescuerId: r.id });
  }
}

/** Execute all due items (mutates queue). */
export async function processSim(queue: SimItem[], nowSimMs: number, ctx: SimCtx): Promise<void> {
  const due = queue.filter((q) => q.dueMs <= nowSimMs).sort((a, b) => a.dueMs - b.dueMs);
  if (!due.length) return;
  for (const d of due) queue.splice(queue.indexOf(d), 1);
  for (const item of due) {
    if (ctx.stale()) return;
    try {
      if (item.kind === "resident") await runResident(item, queue, nowSimMs, ctx);
      else if (item.kind === "escalate") await runEscalate(item, queue, nowSimMs, ctx);
      else await runRescuer(item, ctx);
    } catch (err: any) {
      console.error("[sim] item failed", item, err?.message);
    }
  }
}

async function runResident(item: Extract<SimItem, { kind: "resident" }>, queue: SimItem[], nowSimMs: number, ctx: SimCtx) {
  const res = await one<Resident>("select * from residents where id = $1", [item.residentId]);
  if (!res) return;
  if (item.outcome === "missed") {
    await query("update dove_calls set state = 'missed' where id = $1 and state = 'ringing'", [item.doveCallId]);
    await ctx.log("voice", `${res.name}: no answer`, { event: "missed", residentId: res.id, doveCallId: item.doveCallId, simulated: true });
    return;
  }
  // DOVE calls up to 90 min before the water: a persona that cannot climb stairs is only urgent once the water
  // is at its door. Until then it reports "OK for now" and escalates when the flood layer reaches it.
  const stuck = item.outcome === "needs_help";
  const needs = stuck && ctx.wetAt(res.lat, res.lon);
  const status = stuck && !needs ? "unstable" : item.outcome;
  await query("update dove_calls set state = 'ended' where id = $1 and state in ('ringing','accepted')", [item.doveCallId]);
  await query(
    "insert into status_reports (resident_id, status, can_climb_stairs, notes, channel) values ($1, $2, $3, 'simulated persona', 'voice')",
    [res.id, status, stuck ? false : res.mobility === "ok" ? true : null],
  );
  await ctx.log(
    "voice",
    needs
      ? `${res.name}: urgent · cannot climb stairs`
      : stuck ? `${res.name}: OK for now · cannot climb stairs`
      : item.outcome === "unstable" ? `${res.name}: OK for now · unstable` : `${res.name}: safe`,
    { event: "status", residentId: res.id, status, channel: "voice", simulated: true },
  );
  if (needs) ctx.notifyNeed("needs_help");
  else if (stuck) queue.push({ kind: "escalate", dueMs: nowSimMs + ESCALATE_STEP_MS, residentId: res.id, name: res.name, lat: res.lat, lon: res.lon });
}

async function runEscalate(item: Extract<SimItem, { kind: "escalate" }>, queue: SimItem[], nowSimMs: number, ctx: SimCtx) {
  if (!ctx.wetAt(item.lat, item.lon)) {
    queue.push({ ...item, dueMs: nowSimMs + ESCALATE_STEP_MS });
    return;
  }
  await query(
    "insert into status_reports (resident_id, status, can_climb_stairs, notes, channel) values ($1, 'needs_help', false, 'simulated persona', 'voice')",
    [item.residentId],
  );
  await ctx.log("voice", `${item.name}: water at the door · urgent · cannot climb stairs`, {
    event: "status", residentId: item.residentId, status: "needs_help", channel: "voice", simulated: true, escalated: true,
  });
  ctx.notifyNeed("needs_help");
}

async function runRescuer(item: Extract<SimItem, { kind: "rescuer" }>, ctx: SimCtx) {
  const r = await one<Rescuer>(
    `update rescuers set available = true, lat = coalesce(lat, home_lat), lon = coalesce(lon, home_lon), updated_at = now()
     where id = $1 and available = false returning *`,
    [item.rescuerId],
  );
  if (!r) return;
  await ctx.log("dispatcher", `${rescuerLabel(r)} available`, { event: "rescuer_available", rescuerId: r.id, tier: r.tier, simulated: true });
  ctx.notifyNeed("rescuer_available");
}
