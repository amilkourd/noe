// Shared helpers for the scripts/fetch-*.ts data scripts: retrying fetch, cached raw JSON, file downloads.
// Every public source is fetched once and cached under data/raw/ so the demo never depends on the network.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const UA = "noe-hackathon-demo/0.1";
export const ROOT = path.resolve(__dirname, "..");
export const RAW = path.join(ROOT, "data/raw");
/** Terrain grid box (minLon, minLat, maxLon, maxLat), same as BBOX in .env.example. */
export const BBOX: [number, number, number, number] = [3.95, 43.64, 4.22, 43.93];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET/POST with retries and a timeout. Parses JSON inside the retry loop (WFS sometimes truncates bodies). */
export async function getJson<T>(url: string, opts: { tries?: number; timeoutMs?: number; init?: RequestInit } = {}): Promise<T> {
  const { tries = 4, timeoutMs = 120_000, init } = opts;
  let err: unknown;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...(init?.headers ?? {}) }, signal: ctrl.signal });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      err = e;
      console.warn(`[net] ${url.slice(0, 150)} failed (${(e as Error).message}), retry ${i + 1}/${tries}`);
      await sleep(1000 * 2 ** i);
    } finally {
      clearTimeout(t);
    }
  }
  throw err;
}

/** Raw JSON cached at data/raw/<rel>: fetched by `load` only when missing or when refresh is set. */
export async function cachedJson<T>(rel: string, refresh: boolean, load: () => Promise<T>): Promise<T> {
  const file = path.join(RAW, rel);
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  const data = await load();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

/** Stream a (large) file to disk. Skips the download when the file already exists, unless refresh. */
export async function download(url: string, file: string, refresh = false): Promise<string> {
  if (!refresh && fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".part";
  for (let i = 0; i < 3; i++) {
    try {
      console.log(`[net] downloading ${url}`);
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), fs.createWriteStream(tmp));
      fs.renameSync(tmp, file);
      return file;
    } catch (e) {
      console.warn(`[net] download failed (${(e as Error).message}), retry ${i + 1}/3`);
      await sleep(3000 * 2 ** i);
    }
  }
  throw new Error(`download failed: ${url}`);
}

export const inBox = (lon: number, lat: number, b: [number, number, number, number] = BBOX) =>
  lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

export function writeData(rel: string, data: unknown) {
  fs.writeFileSync(path.join(ROOT, rel), JSON.stringify(data));
  console.log(`[data] wrote ${rel} (${Math.round(fs.statSync(path.join(ROOT, rel)).size / 1024)} KB)`);
}

export function readData<T>(rel: string): T | null {
  const f = path.join(ROOT, rel);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as T) : null;
}

// ---------------------------------------------------------------- geometry

export type Ring = [number, number][];
export type PolyCoords = Ring[]; // outer ring + holes, [lon, lat]

/** Even-odd ray casting on one polygon (outer ring + holes). */
export function pointInPoly(lon: number, lat: number, poly: PolyCoords): boolean {
  let inside = false;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export function polysOf(geom: { type: string; coordinates: unknown }): PolyCoords[] {
  if (geom.type === "Polygon") return [geom.coordinates as PolyCoords];
  if (geom.type === "MultiPolygon") return geom.coordinates as PolyCoords[];
  return [];
}

export function bboxOf(poly: PolyCoords): [number, number, number, number] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of poly[0]) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
}
