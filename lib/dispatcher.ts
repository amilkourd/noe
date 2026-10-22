// NOÉ Dispatcher (spec §7.4): deterministic matching -> DRAFT assignments (never sent; a human orders).
import type { Rescuer, Tier } from "./types";
import type { Projection } from "./forecaster";
import { floodGrid, gridCellOf, type GridLike } from "./exposure";
import { haversineM, parisHHmm, pointSegDistM } from "./geo";

/** Structural subset of lib/terrain.ts Road. */
export interface RoadLike { id: string; ref: string | null; name: string | null; highway: string; coords: [number, number][] }

export interface Need {
  targetType: "site" | "resident"; targetId: string; label: string; lat: number; lon: number; priority: number;
  reason: "needs_help" | "exposed_site";
  /** optional extras used by template insights */
  persona?: boolean; note?: string | null;
}
export interface RoadCut { roadId: string; ref: string | null; name: string | null; floodedAt: string | null /*ISO, null = already*/ }
export interface DraftAssignment {
  rescuerId: string; rescuerName: string; tier: Tier; targetType: "site" | "resident"; targetId: string; targetLabel: string;
  requiredTier: Tier; targetHasWater: boolean; distanceM: number; etaMin: number; routeNote: string | null; roadCuts: RoadCut[];
}

const WET_M = 0.05;
export const ROAD_FACTOR = 1.4;        // straight line -> road distance
export const SPEED_M_PER_MIN = 500;    // 30 km/h in degraded conditions
export const TURNOUT_MIN = 3;
export const ROUND_TRIP_MIN = 60;      // evacuation round trip: roads must hold this long after arrival
/** Same ETA everywhere (ARK drafts, RAVEN view). */
export function etaMinutes(distanceM: number): number {
  return Math.round((distanceM * ROAD_FACTOR) / SPEED_M_PER_MIN + TURNOUT_MIN);
}
const NEAR_TARGET_M = 2000;

export function roadLabel(r: { ref: string | null; name: string | null }): string | null {
  return r.ref || r.name || null;
}

// ---- densified road cells, cached per roads array
const roadCellCache = new WeakMap<object, WeakMap<object, number[][]>>();
function roadCells(g: GridLike, roads: RoadLike[]): number[][] {
  let byGrid = roadCellCache.get(roads);
  if (!byGrid) { byGrid = new WeakMap(); roadCellCache.set(roads, byGrid); }
  const hit = byGrid.get(g);
  if (hit) return hit;
  const res = roads.map((r) => {
    const set = new Set<number>();
    for (let i = 0; i < r.coords.length; i++) {
      const [lon, lat] = r.coords[i];
      const c0 = gridCellOf(g, lat, lon);
      if (c0 >= 0) set.add(c0);
      if (i + 1 < r.coords.length) {
        const [lon2, lat2] = r.coords[i + 1];
        const segM = haversineM({ lat, lon }, { lat: lat2, lon: lon2 });
        const n = Math.ceil(segM / 25);
        for (let k = 1; k < n; k++) {
          const c = gridCellOf(g, lat + ((lat2 - lat) * k) / n, lon + ((lon2 - lon) * k) / n);
          if (c >= 0) set.add(c);
        }
      }
    }
    return [...set];
  });
  byGrid.set(g, res);
  return res;
}

/** Earliest step index at which each road is wet (-1 = never within projection). */
function roadFirstWet(g: GridLike, projection: Projection[], roads: RoadLike[], gridsIn?: ArrayLike<number>[]): number[] {
  const cells = roadCells(g, roads);
  const grids = gridsIn ?? projection.map((p) => floodGrid(g, p.h));
  return cells.map((cs) => {
    for (let k = 0; k < grids.length; k++) {
      const fg = grids[k];
      for (const c of cs) if (fg[c] > WET_M) return k;
    }
    return -1;
  });
}

/** Roads (with an OSM ref or name) that the projected flood cuts, earliest first, one per label. */
export function roadCuts(input: { simTime: Date; g: GridLike; projection: Projection[]; roads: RoadLike[] }): RoadCut[] {
  const { g, projection, roads } = input;
  if (!projection.length || !roads.length) return [];
  const first = roadFirstWet(g, projection, roads);
  const byLabel = new Map<string, { k: number; road: RoadLike }>();
  roads.forEach((r, i) => {
    const k = first[i];
    const label = roadLabel(r);
    if (k < 0 || !label) return;
    const prev = byLabel.get(label);
    if (!prev || k < prev.k) byLabel.set(label, { k, road: r });
  });
  return [...byLabel.values()]
    .sort((a, b) => a.k - b.k)
    .map(({ k, road }) => ({ roadId: road.id, ref: road.ref, name: road.name, floodedAt: k === 0 ? null : projection[k].t }));
}

function roadDistM(r: RoadLike, p: { lat: number; lon: number }): number {
  let best = Infinity;
  for (let i = 0; i + 1 < r.coords.length; i++) {
    const a = { lon: r.coords[i][0], lat: r.coords[i][1] }, b = { lon: r.coords[i + 1][0], lat: r.coords[i + 1][1] };
    const d = pointSegDistM(p, a, b);
    if (d < best) best = d;
  }
  if (r.coords.length === 1) best = haversineM(p, { lon: r.coords[0][0], lat: r.coords[0][1] });
  return best;
}

function tierOk(t: Tier, required: Tier): boolean {
  return required === "T3" ? t === "T3" : true;
}

export function draftAssignments(input: {
  simTime: Date; g: GridLike; hNow: Record<string, number>; projection: Projection[]; needs: Need[]; rescuers: Rescuer[]; roads: RoadLike[];
}): DraftAssignment[] {
  const { g, simTime, projection, roads } = input;
  const now = simTime.getTime();
  const nowGrid = floodGrid(g, input.hNow);
  const grids = projection.map((p) => floodGrid(g, p.h));
  const first = projection.length && roads.length ? roadFirstWet(g, projection, roads, grids) : roads.map(() => -1);
  const used = new Set<string>();
  const out: DraftAssignment[] = [];
  const needs = [...input.needs].sort((a, b) => b.priority - a.priority);
  for (const need of needs) {
    const cell = gridCellOf(g, need.lat, need.lon);
    const hasWater = cell >= 0 && nowGrid[cell] > WET_M;
    // first projected wet time at the target (water arriving before the rescuer = moving water -> T3 only)
    let wetAt: number | null = hasWater ? now : null;
    if (wetAt === null && cell >= 0) {
      for (let k = 0; k < grids.length; k++) {
        if (grids[k][cell] > WET_M) { wetAt = Date.parse(projection[k].t); break; }
      }
    }
    let best: { r: Rescuer; d: number; required: Tier } | null = null;
    for (const r of input.rescuers) {
      if (!r.available || used.has(r.id)) continue;
      const lat = r.lat ?? r.home_lat, lon = r.lon ?? r.home_lon;
      if (lat === null || lon === null) continue;
      const d = haversineM({ lat, lon }, need);
      const req: Tier = hasWater || (wetAt !== null && wetAt <= now + (etaMinutes(d) + 15) * 60_000) ? "T3" : "T1";
      if (!tierOk(r.tier, req)) continue;
      if (!best || d < best.d) best = { r, d, required: req };
    }
    if (!best) continue;
    used.add(best.r.id);
    const required = best.required;
    const etaMin = etaMinutes(best.d);
    const arrival = now + etaMin * 60_000;
    const horizon = arrival + ROUND_TRIP_MIN * 60_000; // rescuer must get in AND back out with the evacuee

    // road cuts near the target that are under water before the rescuer arrives
    const near: { road: RoadLike; k: number; dist: number }[] = [];
    roads.forEach((road, i) => {
      if (!roadLabel(road)) return;
      const dist = roadDistM(road, need);
      if (dist > NEAR_TARGET_M) return;
      near.push({ road, k: first[i], dist });
    });
    const cutNear = near
      .filter((x) => x.k >= 0 && (x.k === 0 || Date.parse(projection[x.k].t) <= horizon))
      .sort((a, b) => a.dist - b.dist);
    const cutLabels = new Set(cutNear.map((x) => roadLabel(x.road)!));
    const seen = new Set<string>();
    const cuts: RoadCut[] = [];
    for (const x of cutNear) {
      const l = roadLabel(x.road)!;
      if (seen.has(l)) continue;
      seen.add(l);
      cuts.push({ roadId: x.road.id, ref: x.road.ref, name: x.road.name, floodedAt: x.k === 0 ? null : projection[x.k].t });
    }
    let routeNote: string | null = null;
    if (cuts.length) {
      const alt = near
        .filter((x) => x.road.ref && !cutLabels.has(roadLabel(x.road)!) && (x.k < 0 || Date.parse(projection[x.k].t) > horizon + 30 * 60_000))
        .sort((a, b) => a.dist - b.dist)[0];
      const c = cuts[0];
      const cutL = roadLabel(c)!;
      const when = c.floodedAt ? `≈${parisHHmm(c.floodedAt)}` : "now";
      if (alt) routeNote = `${cutL} under water ${when} → via ${alt.road.ref}`;
      else routeNote = `${cutL} under water ${when}`;
    }
    out.push({
      rescuerId: best.r.id, rescuerName: best.r.name, tier: best.r.tier, targetType: need.targetType, targetId: need.targetId,
      targetLabel: need.label, requiredTier: required, targetHasWater: hasWater, distanceM: Math.round(best.d), etaMin, routeNote, roadCuts: cuts,
    });
  }
  return out;
}
