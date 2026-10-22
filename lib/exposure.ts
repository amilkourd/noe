// NOÉ Exposure (spec §7.3): APPROXIMATE flood model (label it as such in every UI).
// Pure: takes the terrain grid as an argument (structurally compatible with lib/terrain.ts TerrainGrid).
import type { Exposure, Resident, Site } from "./types";
import type { Projection } from "./forecaster";

/** Structural subset of lib/terrain.ts TerrainGrid used here. */
export interface GridLike {
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  cols: number; rows: number;             // row 0 = north
  elev: number[]; riverDist: number[]; riverBedElev: number[]; urban?: number[];
  station: number[]; stations: string[];
}

/**
 * Per gauge: baseM = pre-event stage (median 19 Oct 00:00-12:00Z in the real Hub'Eau data),
 * bankfullM = rise above base the channel holds before water leaves the bed (tuned so that
 * at 20 Oct 00:00Z almost nothing floods and at the ~05:00Z peak the Sommières reach shows
 * a visible but plausible band). Tuned with scripts/sim-offline.ts.
 */
export const FLOOD_PARAMS: Record<string, { baseM: number; bankfullM: number }> = {
  Y341400501: { baseM: 0.71, bankfullM: 1.5 },  // Quissac (upstream)
  Y344402001: { baseM: 0.18, bankfullM: 2.6 },  // Vic-le-Fesq (mid)
  Y345401001: { baseM: 0.14, bankfullM: 1.75 }, // Sommières (target)
  Y346400501: { baseM: 1.45, bankfullM: 3.4 },  // Gallargues A9 (downstream)
};
const DEFAULT_PARAMS = { baseM: 0, bankfullM: 2.0 };
const WET_M = 0.05;
const MAX_RIVER_DIST_M = 2000;
const SEED_RIVER_DIST_M = 150;

/** Cell index for a point (row 0 = north), -1 if outside the grid. */
export function gridCellOf(g: GridLike, lat: number, lon: number): number {
  const [minLon, minLat, maxLon, maxLat] = g.bbox;
  if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return -1;
  const col = Math.min(g.cols - 1, Math.floor(((lon - minLon) / (maxLon - minLon)) * g.cols));
  const row = Math.min(g.rows - 1, Math.floor(((maxLat - lat) / (maxLat - minLat)) * g.rows));
  return row * g.cols + col;
}

export function gridCellCenter(g: GridLike, i: number): { lat: number; lon: number } {
  const [minLon, minLat, maxLon, maxLat] = g.bbox;
  const col = i % g.cols, row = Math.floor(i / g.cols);
  return { lon: minLon + ((col + 0.5) * (maxLon - minLon)) / g.cols, lat: maxLat - ((row + 0.5) * (maxLat - minLat)) / g.rows };
}

function overflowFor(g: GridLike, stIdx: number, h: Record<string, number>): number {
  const code = g.stations[stIdx];
  const p = FLOOD_PARAMS[code] ?? DEFAULT_PARAMS;
  const hv = h[code];
  if (hv === undefined || !Number.isFinite(hv)) return 0;
  return Math.max(0, Math.max(0, hv - p.baseM) - p.bankfullM);
}

/**
 * Local (unconnected) water depth at a cell, metres (<= 0 = dry):
 * wse = riverBedElev + max(0, rise - bankfull); depth = wse - elev, with elev clamped to >= riverBedElev.
 */
export function depthAt(g: GridLike, cell: number, hByStation: Record<string, number>): number {
  if (cell < 0 || cell >= g.elev.length) return 0;
  const st = g.station[cell];
  if (st === undefined || st < 0 || !(g.riverDist[cell] < MAX_RIVER_DIST_M)) return 0;
  const over = overflowFor(g, st, hByStation);
  if (over <= 0) return 0;
  // height above the nearest river vertex, clamped at 0 (DEM noise can put cells below the bed sample)
  const hand = Math.max(0, g.elev[cell] - g.riverBedElev[cell]);
  return over - hand;
}

// ---- connected flood grid with a small cache (exposure, dispatcher and copilot reuse projections)
const cache = new Map<string, Float32Array>();
const gridIds = new WeakMap<object, number>();
let nextGridId = 1;
function cacheKey(g: GridLike, h: Record<string, number>): string {
  let id = gridIds.get(g);
  if (!id) { id = nextGridId++; gridIds.set(g, id); }
  return id + "|" + g.stations.map((c) => Math.round((h[c] ?? 0) * 100)).join(",");
}

/** Depth per cell (0 = dry) after hydraulic connectivity: flood-fill from river cells. */
export function floodGrid(g: GridLike, hByStation: Record<string, number>): Float32Array {
  const key = cacheKey(g, hByStation);
  const hit = cache.get(key);
  if (hit) return hit;
  const n = g.cols * g.rows;
  const local = new Float32Array(n);
  const over: number[] = g.stations.map((_, i) => overflowFor(g, i, hByStation));
  let any = false;
  for (let c = 0; c < n; c++) {
    const st = g.station[c];
    if (st < 0 || !(g.riverDist[c] < MAX_RIVER_DIST_M)) continue;
    const o = over[st];
    if (o <= 0) continue;
    const d = o - Math.max(0, g.elev[c] - g.riverBedElev[c]);
    if (d > WET_M) { local[c] = d; any = true; }
  }
  const out = new Float32Array(n);
  if (any) {
    const seen = new Uint8Array(n);
    const stack: number[] = [];
    for (let c = 0; c < n; c++) {
      if (local[c] > 0 && g.riverDist[c] <= SEED_RIVER_DIST_M) { seen[c] = 1; stack.push(c); }
    }
    while (stack.length) {
      const c = stack.pop()!;
      out[c] = local[c];
      const r = Math.floor(c / g.cols), col = c % g.cols;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr, cc = col + dc;
        if (rr < 0 || rr >= g.rows || cc < 0 || cc >= g.cols) continue;
        const nb = rr * g.cols + cc;
        if (!seen[nb] && local[nb] > 0) { seen[nb] = 1; stack.push(nb); }
      }
    }
  }
  if (cache.size > 300) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}

export function floodAt(g: GridLike, hByStation: Record<string, number>): { cells: number[]; depths: number[] } {
  const fg = floodGrid(g, hByStation);
  const cells: number[] = [], depths: number[] = [];
  for (let c = 0; c < fg.length; c++) if (fg[c] > 0) { cells.push(c); depths.push(Math.round(fg[c] * 100) / 100); }
  return { cells, depths };
}

export type ExposureDraft = Omit<Exposure, "id" | "forecast_id">;

const SITE_VULN: Record<string, number> = { care_home: 6, hospital: 5, campsite: 4, school: 3 };
const RES_VULN: Record<string, number> = { bedridden: 5, reduced: 4, ok: 2 };

export function computeExposures(input: {
  g: GridLike; simTime: Date; hNow: Record<string, number>; projection: Projection[]; sites: Site[]; residents: Resident[];
}): ExposureDraft[] {
  const { g, simTime } = input;
  const now = simTime.getTime();
  const grids = [floodGrid(g, input.hNow), ...input.projection.map((p) => floodGrid(g, p.h))];
  const times = [now, ...input.projection.map((p) => Date.parse(p.t))];
  const targets: { type: "site" | "resident"; id: string; lat: number; lon: number; vuln: number }[] = [
    ...input.sites.map((s) => ({ type: "site" as const, id: s.id, lat: s.lat, lon: s.lon, vuln: SITE_VULN[s.kind] ?? 3 })),
    ...input.residents.map((r) => ({ type: "resident" as const, id: r.id, lat: r.lat, lon: r.lon, vuln: RES_VULN[r.mobility] ?? 2 })),
  ];
  const out: ExposureDraft[] = [];
  for (const t of targets) {
    const cell = gridCellOf(g, t.lat, t.lon);
    if (cell < 0) continue;
    let eta: number | null = null, maxDepth = 0;
    for (let k = 0; k < grids.length; k++) {
      const d = grids[k][cell];
      if (d > WET_M) {
        if (eta === null) eta = Math.max(now, times[k]);
        if (d > maxDepth) maxDepth = d;
      }
    }
    if (eta === null) continue;
    const hoursToEta = Math.max(0, (eta - now) / 3_600_000);
    const urgency = 1 + Math.max(0, 3 - hoursToEta);
    out.push({
      target_type: t.type, target_id: t.id, eta: new Date(eta).toISOString(),
      depth_m: Math.round(maxDepth * 100) / 100, priority: Math.round(t.vuln * urgency),
    });
  }
  out.sort((a, b) => b.priority - a.priority || (a.eta ?? "").localeCompare(b.eta ?? ""));
  return out;
}
