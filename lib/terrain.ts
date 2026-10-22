// Terrain grid + OSM roads/river loaders (server-only: uses fs). Cached in module scope.
// Files are produced by scripts/fetch-osm.ts and scripts/build-terrain.ts.
import fs from "node:fs";
import path from "node:path";

export interface TerrainGrid {
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  cols: number;
  rows: number; // row 0 = north
  elev: number[];
  riverDist: number[]; // m to Vidourle polyline
  riverBedElev: number[]; // elev of nearest river vertex (smoothed, decreasing downstream)
  urban: number[]; // 0|1
  station: number[]; // per cell index into stations[] (gauge whose river reach is nearest), -1 if riverDist > 2500
  stations: string[]; // station codes
}

export interface Road {
  id: string;
  ref: string | null;
  name: string | null;
  highway: string;
  coords: [number, number][]; // [lon, lat]
}

const DATA_DIR = path.join(process.cwd(), "data");

let gridCache: TerrainGrid | null = null;
let roadsCache: Road[] | null = null;
let riverCache: [number, number][] | null = null;

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")) as T;
}

export function loadTerrain(): TerrainGrid {
  if (!gridCache) gridCache = readJson<TerrainGrid>("terrain-grid.json");
  return gridCache;
}

export function loadRoads(): Road[] {
  if (!roadsCache) roadsCache = readJson<Road[]>("roads.json");
  return roadsCache;
}

export function loadRiver(): [number, number][] {
  if (!riverCache) riverCache = readJson<[number, number][]>("river.json");
  return riverCache;
}

/** Cell index for a lat/lon, or -1 if outside the grid. */
export function cellOf(g: TerrainGrid, lat: number, lon: number): number {
  const [minLon, minLat, maxLon, maxLat] = g.bbox;
  if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return -1;
  const c = Math.min(g.cols - 1, Math.floor(((lon - minLon) / (maxLon - minLon)) * g.cols));
  const r = Math.min(g.rows - 1, Math.floor(((maxLat - lat) / (maxLat - minLat)) * g.rows));
  return r * g.cols + c;
}

/** Centre of a cell. */
export function cellCenter(g: TerrainGrid, i: number): { lat: number; lon: number } {
  const [minLon, minLat, maxLon, maxLat] = g.bbox;
  const r = Math.floor(i / g.cols);
  const c = i % g.cols;
  return {
    lon: minLon + ((c + 0.5) / g.cols) * (maxLon - minLon),
    lat: maxLat - ((r + 0.5) / g.rows) * (maxLat - minLat),
  };
}
