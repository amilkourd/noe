// Build data/terrain-grid.json from AWS terrarium tiles (z12) + OSM river/landuse/streets.
// Tiles are cached in data/raw/tiles/. Run after scripts/fetch-osm.ts.
// Run: npx tsx scripts/build-terrain.ts
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import type { TerrainGrid } from "../lib/terrain";

const ROOT = path.resolve(__dirname, "..");
const TILE_DIR = path.join(ROOT, "data/raw/tiles");
const Z = 12;
const BBOX: [number, number, number, number] = [3.95, 43.64, 4.22, 43.93];
const COLS = 220, ROWS = 160;
const STATIONS = [
  { code: "Y341400501", lat: 43.9066, lon: 3.9999 },
  { code: "Y344402001", lat: 43.8711, lon: 4.0753 },
  { code: "Y345401001", lat: 43.7823, lon: 4.0892 },
  { code: "Y346400501", lat: 43.723, lon: 4.1506 },
];

const KX = 111320 * Math.cos((43.785 * Math.PI) / 180), KY = 110574;
const toXY = (lon: number, lat: number): [number, number] => [lon * KX, lat * KY];

const lon2tx = (lon: number) => ((lon + 180) / 360) * 2 ** Z;
const lat2ty = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z;
};

async function getTile(x: number, y: number): Promise<PNG> {
  const file = path.join(TILE_DIR, `${Z}_${x}_${y}.png`);
  if (!fs.existsSync(file)) {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`;
    let buf: Buffer | null = null;
    for (let i = 0; i < 4 && !buf; i++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        console.warn(`[terrain] ${url}: ${(e as Error).message}, retry`);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      }
    }
    if (!buf) throw new Error(`could not fetch ${url}`);
    fs.writeFileSync(file, buf);
  }
  return PNG.sync.read(fs.readFileSync(file));
}

function pointInPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function main() {
  fs.mkdirSync(TILE_DIR, { recursive: true });
  const [minLon, minLat, maxLon, maxLat] = BBOX;
  const tx0 = Math.floor(lon2tx(minLon)), tx1 = Math.floor(lon2tx(maxLon));
  const ty0 = Math.floor(lat2ty(maxLat)), ty1 = Math.floor(lat2ty(minLat));
  const tiles = new Map<string, PNG>();
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) tiles.set(`${x}_${y}`, await getTile(x, y));
  console.log(`[terrain] ${tiles.size} tiles z${Z} x ${tx0}..${tx1} y ${ty0}..${ty1}`);

  const px = (tx: number, ty: number, ix: number, iy: number): number => {
    // handle overflow into neighbour tiles
    let x = tx, y = ty;
    if (ix >= 256) { ix -= 256; x++; } if (iy >= 256) { iy -= 256; y++; }
    const t = tiles.get(`${x}_${y}`);
    if (!t) return NaN;
    const o = (iy * 256 + ix) * 4;
    return t.data[o] * 256 + t.data[o + 1] + t.data[o + 2] / 256 - 32768;
  };
  const elevAt = (lon: number, lat: number): number => {
    const fx = lon2tx(lon) * 256 - 0.5, fy = lat2ty(lat) * 256 - 0.5;
    const gx = Math.floor(fx), gy = Math.floor(fy);
    const dx = fx - gx, dy = fy - gy;
    const sample = (X: number, Y: number) => px(Math.floor(X / 256), Math.floor(Y / 256), X % 256, Y % 256);
    const a = sample(gx, gy), b = sample(gx + 1, gy), c = sample(gx, gy + 1), d = sample(gx + 1, gy + 1);
    return a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + c * (1 - dx) * dy + d * dx * dy;
  };

  const river = JSON.parse(fs.readFileSync(path.join(ROOT, "data/river.json"), "utf8")) as [number, number][];
  const landuse = JSON.parse(fs.readFileSync(path.join(ROOT, "data/raw/landuse.json"), "utf8")) as [number, number][][];
  const streets = JSON.parse(fs.readFileSync(path.join(ROOT, "data/raw/streets.json"), "utf8")) as { coords: [number, number][] }[];

  // --- river vertices: along-river distance, bed elevation (min in ~60 m neighbourhood, smoothed, monotone) ---
  const rv = river.map(([lon, lat]) => toXY(lon, lat));
  const along: number[] = [0];
  for (let i = 1; i < rv.length; i++) along.push(along[i - 1] + Math.hypot(rv[i][0] - rv[i - 1][0], rv[i][1] - rv[i - 1][1]));
  const rawBed = river.map(([lon, lat]) => {
    let m = Infinity;
    for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const e = elevAt(lon + (ox * 60) / KX, lat + (oy * 60) / KY);
      if (Number.isFinite(e) && e < m) m = e;
    }
    return m;
  });
  // moving median over ~800 m along the river
  const med: number[] = rawBed.map((_, i) => {
    const win: number[] = [];
    for (let j = i; j >= 0 && along[i] - along[j] <= 400; j--) win.push(rawBed[j]);
    for (let j = i + 1; j < rawBed.length && along[j] - along[i] <= 400; j++) win.push(rawBed[j]);
    win.sort((a, b) => a - b);
    return win[Math.floor(win.length / 2)];
  });
  // monotone non-increasing downstream (river runs N -> S)
  const bed = med.slice();
  for (let i = 1; i < bed.length; i++) bed[i] = Math.min(bed[i], bed[i - 1]);

  // gauge -> along-river position; vertex -> nearest gauge by along-river position
  const gaugeAlong = STATIONS.map((s) => {
    const [sx, sy] = toXY(s.lon, s.lat);
    let bi = 0, bd = Infinity;
    rv.forEach(([x, y], i) => { const d = Math.hypot(x - sx, y - sy); if (d < bd) { bd = d; bi = i; } });
    return along[bi];
  });
  const vStation = along.map((a) => {
    let bi = 0, bd = Infinity;
    gaugeAlong.forEach((g, i) => { const d = Math.abs(a - g); if (d < bd) { bd = d; bi = i; } });
    return bi;
  });

  // --- grid ---
  const N = COLS * ROWS;
  const elev = new Array<number>(N), riverDist = new Array<number>(N), riverBedElev = new Array<number>(N);
  const urban = new Array<number>(N).fill(0), station = new Array<number>(N).fill(-1);
  const cellLon = (c: number) => minLon + ((c + 0.5) / COLS) * (maxLon - minLon);
  const cellLat = (r: number) => maxLat - ((r + 0.5) / ROWS) * (maxLat - minLat);

  // street vertex density for "urban" (named streets)
  const streetCount = new Array<number>(N).fill(0);
  for (const s of streets) for (const [lon, lat] of s.coords) {
    if (lon < minLon || lon >= maxLon || lat <= minLat || lat > maxLat) continue;
    const c = Math.floor(((lon - minLon) / (maxLon - minLon)) * COLS), r = Math.floor(((maxLat - lat) / (maxLat - minLat)) * ROWS);
    streetCount[r * COLS + c]++;
  }
  const polys = landuse.map((p) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [lon, lat] of p) { a = Math.min(a, lon); b = Math.min(b, lat); c = Math.max(c, lon); d = Math.max(d, lat); }
    return { p, bb: [a, b, c, d] };
  });

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c, lon = cellLon(c), lat = cellLat(r);
      elev[i] = elevAt(lon, lat);
      const [x, y] = toXY(lon, lat);
      let bd = Infinity, bv = 0, bt = 0;
      for (let k = 0; k < rv.length - 1; k++) {
        const [ax, ay] = rv[k], [bx, by] = rv[k + 1];
        const vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
        const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L)) : 0;
        const d = Math.hypot(ax + t * vx - x, ay + t * vy - y);
        if (d < bd) { bd = d; bv = k; bt = t; }
      }
      riverDist[i] = bd;
      riverBedElev[i] = bed[bv] * (1 - bt) + bed[bv + 1] * bt;
      if (bd <= 2500) station[i] = vStation[bt < 0.5 ? bv : bv + 1];
      // urban: inside residential landuse, or dense named streets around
      let u = 0;
      for (const { p, bb } of polys) {
        if (lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
        if (pointInPoly(lon, lat, p)) { u = 1; break; }
      }
      if (!u) {
        let s = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS) s += streetCount[rr * COLS + cc];
        }
        if (streetCount[i] >= 4 && s >= 25) u = 1;
      }
      urban[i] = u;
    }
  }

  const r1 = (v: number) => Math.round(v * 10) / 10;
  const grid: TerrainGrid = {
    bbox: BBOX, cols: COLS, rows: ROWS,
    elev: elev.map(r1), riverDist: riverDist.map((v) => Math.round(v)), riverBedElev: riverBedElev.map(r1),
    urban, station, stations: STATIONS.map((s) => s.code),
  };
  fs.writeFileSync(path.join(ROOT, "data/terrain-grid.json"), JSON.stringify(grid));

  // --- sanity report ---
  const ev = elev.filter(Number.isFinite);
  console.log(`[terrain] grid ${COLS}x${ROWS} (${N} cells), cell ~${(((maxLon - minLon) / COLS) * KX).toFixed(0)} m x ${(((maxLat - minLat) / ROWS) * KY).toFixed(0)} m`);
  console.log(`[terrain] elev range ${Math.min(...ev).toFixed(1)}..${Math.max(...ev).toFixed(1)} m; NaN cells ${N - ev.length}`);
  console.log(`[terrain] river bed: N ${bed[0].toFixed(1)} m -> S ${bed[bed.length - 1].toFixed(1)} m; at gauges ${gaugeAlong.map((a) => bed[along.findIndex((x) => x >= a)].toFixed(1)).join(" / ")}`);
  const riverCells = riverDist.map((d, i) => (d < 100 ? elev[i] : NaN)).filter(Number.isFinite);
  console.log(`[terrain] cells <100 m from river: ${riverCells.length}, mean elev ${(riverCells.reduce((s, v) => s + v, 0) / riverCells.length).toFixed(1)} m`);
  console.log(`[terrain] urban cells: ${urban.reduce((s, v) => s + v, 0)}; station-assigned cells: ${STATIONS.map((_, k) => station.filter((s) => s === k).length).join(" / ")}`);
  const [sx, sy] = toXY(4.089, 43.784);
  let near = 0, low1 = 0, low2 = 0, low2u = 0;
  for (let i = 0; i < N; i++) {
    const [x, y] = toXY(cellLon(i % COLS), cellLat(Math.floor(i / COLS)));
    if (Math.hypot(x - sx, y - sy) > 3000) continue;
    near++;
    const rel = elev[i] - riverBedElev[i];
    if (rel <= 1) low1++;
    if (rel <= 2) { low2++; if (urban[i]) low2u++; }
  }
  console.log(`[terrain] within 3 km of Sommières: ${near} cells, <=1 m above bed: ${low1}, <=2 m above bed: ${low2} (urban ${low2u})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
