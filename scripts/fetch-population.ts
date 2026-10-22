// Who actually lives in the box (public data, Licence Ouverte 2.0, no API key):
//   INSEE Filosofi 2019, 200 m grid ("données carroyées"): inhabitants, households, age bands per 200 m square
//   BAN (Base Adresse Nationale, adresse.data.gouv.fr): every postal address, Gard (30) + Hérault (34)
// Big national files are downloaded into the OS temp dir; only the rows inside the terrain box are cached in
// data/raw/ (insee_200m_box.csv, ban_box.csv). Writes:
//   data/population.json        INSEE cells in the box (centre, polygon ring, counts), seeded into PostGIS
//   data/addresses.json.gz      BAN addresses in the box, seeded into PostGIS
//   data/population-grid.json   per terrain cell sums (sparse), used live to count real people in the flood footprint
// Run: npx tsx scripts/fetch-population.ts [--refresh]   (after build-terrain)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import type { TerrainGrid } from "../lib/terrain";
import { BBOX, RAW, ROOT, download, inBox, readData, writeData } from "./_net";

const REFRESH = process.argv.includes("--refresh");
const TMP = path.join(os.tmpdir(), "noe-data");
const INSEE_URL = "https://www.insee.fr/fr/statistiques/fichier/7655475/Filosofi2019_carreaux_200m_csv.zip";
const BAN_URL = (d: string) => `https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-${d}.csv.gz`;

// ---------------------------------------------------------------- ETRS89-LAEA (EPSG:3035), EPSG guidance note 7-2
const A = 6378137, F = 1 / 298.257222101, E2 = 2 * F - F * F, E = Math.sqrt(E2);
const PHI0 = (52 * Math.PI) / 180, LAM0 = (10 * Math.PI) / 180, FE = 4321000, FN = 3210000;
const qOf = (phi: number) => {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
};
const QP = qOf(Math.PI / 2), RQ = A * Math.sqrt(QP / 2), B0 = Math.asin(qOf(PHI0) / QP);
const D = (A * Math.cos(PHI0)) / Math.sqrt(1 - E2 * Math.sin(PHI0) ** 2) / (RQ * Math.cos(B0));

export function toLaea(lon: number, lat: number): [number, number] {
  const phi = (lat * Math.PI) / 180, dl = (lon * Math.PI) / 180 - LAM0;
  const beta = Math.asin(qOf(phi) / QP);
  const b = RQ * Math.sqrt(2 / (1 + Math.sin(B0) * Math.sin(beta) + Math.cos(B0) * Math.cos(beta) * Math.cos(dl)));
  return [FE + b * D * Math.cos(beta) * Math.sin(dl), FN + (b / D) * (Math.cos(B0) * Math.sin(beta) - Math.sin(B0) * Math.cos(beta) * Math.cos(dl))];
}

export function fromLaea(x: number, y: number): [number, number] {
  const dx = x - FE, dy = y - FN;
  const rho = Math.hypot(dx / D, D * dy);
  const c = 2 * Math.asin(rho / (2 * RQ));
  const beta = Math.asin(Math.cos(c) * Math.sin(B0) + (D * dy * Math.sin(c) * Math.cos(B0)) / rho);
  const lam = LAM0 + Math.atan2(dx * Math.sin(c), D * rho * Math.cos(B0) * Math.cos(c) - D * D * dy * Math.sin(B0) * Math.sin(c));
  const e4 = E2 * E2, e6 = e4 * E2;
  const phi = beta + (E2 / 3 + (31 * e4) / 180 + (517 * e6) / 5040) * Math.sin(2 * beta)
    + ((23 * e4) / 360 + (251 * e6) / 3780) * Math.sin(4 * beta) + ((761 * e6) / 45360) * Math.sin(6 * beta);
  return [(lam * 180) / Math.PI, (phi * 180) / Math.PI];
}

/** Reference values from PostGIS ST_Transform on the Aiven service; fail loudly if the maths drift. */
function checkProjection() {
  const [x, y] = toLaea(4.0892, 43.7823);
  const [lon, lat] = fromLaea(3758800, 2290200);
  const ok = Math.abs(x - 3844597.1028) < 0.05 && Math.abs(y - 2315788.1772) < 0.05
    && Math.abs(lon - 3.0570722045) < 1e-8 && Math.abs(lat - 43.4861247200) < 1e-8;
  if (!ok) throw new Error(`LAEA projection check failed: ${x} ${y} / ${lon} ${lat}`);
}

// ---------------------------------------------------------------- INSEE
const INSEE_CACHE = path.join(RAW, "insee_200m_box.csv");
const INSEE_COLS = ["Idcar_200m", "Ind", "Men", "Men_1ind", "Ind_0_3", "Ind_65_79", "Ind_80p"];

async function inseeRows(): Promise<string[][]> {
  if (!REFRESH && fs.existsSync(INSEE_CACHE)) {
    return fs.readFileSync(INSEE_CACHE, "utf8").trim().split("\n").slice(1).map((l) => l.split(";"));
  }
  const zip = await download(INSEE_URL, path.join(TMP, "Filosofi2019_carreaux_200m_csv.zip"), REFRESH);
  // LAEA box of the terrain box (+1 cell margin)
  const corners = [[BBOX[0], BBOX[1]], [BBOX[0], BBOX[3]], [BBOX[2], BBOX[1]], [BBOX[2], BBOX[3]]].map(([lo, la]) => toLaea(lo, la));
  const xmin = Math.min(...corners.map((c) => c[0])) - 200, xmax = Math.max(...corners.map((c) => c[0])) + 200;
  const ymin = Math.min(...corners.map((c) => c[1])) - 200, ymax = Math.max(...corners.map((c) => c[1])) + 200;
  const unzip = spawn("unzip", ["-p", zip, "*.csv"]);
  const rl = readline.createInterface({ input: unzip.stdout, crlfDelay: Infinity });
  let idx: number[] | null = null, sep = ";";
  const out: string[][] = [];
  for await (const line of rl) {
    if (!idx) {
      sep = line.includes(";") ? ";" : ",";
      const h = line.replace(/"/g, "").split(sep);
      idx = INSEE_COLS.map((c) => h.findIndex((x) => x.toLowerCase() === c.toLowerCase()));
      if (idx.some((i) => i < 0)) throw new Error(`INSEE header missing columns: ${line.slice(0, 300)}`);
      continue;
    }
    const f = line.replace(/"/g, "").split(sep);
    const m = /N(\d+)E(\d+)/.exec(f[idx[0]]);
    if (!m) continue;
    const y = Number(m[1]), x = Number(m[2]); // south-west corner
    if (x < xmin || x > xmax || y < ymin || y > ymax) continue;
    out.push(idx.map((i) => f[i]));
  }
  fs.writeFileSync(INSEE_CACHE, [INSEE_COLS.join(";"), ...out.map((r) => r.join(";"))].join("\n") + "\n");
  console.log(`[insee] ${out.length} cells in the LAEA box cached in data/raw/insee_200m_box.csv`);
  return out;
}

// ---------------------------------------------------------------- BAN
const BAN_CACHE = path.join(RAW, "ban_box.csv");
const BAN_COLS = ["id", "numero", "rep", "nom_voie", "code_postal", "code_insee", "nom_commune", "lon", "lat"];

async function banRows(): Promise<string[][]> {
  if (!REFRESH && fs.existsSync(BAN_CACHE)) {
    return fs.readFileSync(BAN_CACHE, "utf8").trim().split("\n").slice(1).map((l) => l.split(";"));
  }
  const out: string[][] = [];
  for (const d of ["30", "34"]) {
    const file = await download(BAN_URL(d), path.join(TMP, `adresses-${d}.csv.gz`), REFRESH);
    const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    let idx: number[] | null = null;
    for await (const line of rl) {
      const f = line.split(";");
      if (!idx) { idx = BAN_COLS.map((c) => f.indexOf(c)); continue; }
      const lon = Number(f[idx[7]]), lat = Number(f[idx[8]]);
      if (!inBox(lon, lat)) continue;
      out.push(idx.map((i) => (f[i] ?? "").replace(/;/g, ",")));
    }
  }
  fs.writeFileSync(BAN_CACHE, [BAN_COLS.join(";"), ...out.map((r) => r.join(";"))].join("\n") + "\n");
  console.log(`[ban] ${out.length} addresses in the box cached in data/raw/ban_box.csv`);
  return out;
}

// ---------------------------------------------------------------- main
const r1 = (x: number) => Math.round(x * 10) / 10;

async function main() {
  checkProjection();
  const g = readData<TerrainGrid>("data/terrain-grid.json");
  if (!g) throw new Error("data/terrain-grid.json missing (npm run data:terrain)");
  const [minLon, minLat, maxLon, maxLat] = g.bbox;
  const cellOf = (lon: number, lat: number) => {
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return -1;
    const c = Math.min(g.cols - 1, Math.floor(((lon - minLon) / (maxLon - minLon)) * g.cols));
    const r = Math.min(g.rows - 1, Math.floor(((maxLat - lat) / (maxLat - minLat)) * g.rows));
    return r * g.cols + c;
  };
  const N = g.cols * g.rows;
  const sums = { ind: new Float64Array(N), ind80p: new Float64Array(N), ind65_79: new Float64Array(N), ind0_3: new Float64Array(N), men1: new Float64Array(N), addr: new Float64Array(N) };

  // INSEE: keep cells whose centre is in the box; spread each 200 m square over the terrain cells (4x4 sub-points)
  const cells = [];
  let totInd = 0;
  for (const [id, ind, men, men1, i03, i6579, i80] of await inseeRows()) {
    const m = /N(\d+)E(\d+)/.exec(id)!;
    const y0 = Number(m[1]), x0 = Number(m[2]);
    const [clon, clat] = fromLaea(x0 + 100, y0 + 100);
    if (!inBox(clon, clat, g.bbox)) continue;
    const v = { ind: Number(ind), men: Number(men), men1: Number(men1), i03: Number(i03), i6579: Number(i6579), i80: Number(i80) };
    const ring = [[x0, y0], [x0 + 200, y0], [x0 + 200, y0 + 200], [x0, y0 + 200], [x0, y0]].map(([x, y]) => {
      const [lo, la] = fromLaea(x, y);
      return [+lo.toFixed(6), +la.toFixed(6)];
    });
    cells.push({ id, lon: +clon.toFixed(6), lat: +clat.toFixed(6), ring, ind: r1(v.ind), men: r1(v.men), men_1ind: r1(v.men1), ind_0_3: r1(v.i03), ind_65_79: r1(v.i6579), ind_80p: r1(v.i80) });
    totInd += v.ind;
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
      const [lo, la] = fromLaea(x0 + 25 + 50 * a, y0 + 25 + 50 * b);
      const t = cellOf(lo, la);
      if (t < 0) continue;
      sums.ind[t] += v.ind / 16; sums.ind80p[t] += v.i80 / 16; sums.ind65_79[t] += v.i6579 / 16; sums.ind0_3[t] += v.i03 / 16; sums.men1[t] += v.men1 / 16;
    }
  }
  writeData("data/population.json", {
    source: "INSEE, Filosofi 2019, données carroyées 200 m (insee.fr/fr/statistiques/7655475)", year: 2019, cells,
  });
  console.log(`[insee] ${cells.length} populated 200 m cells, ${Math.round(totInd)} inhabitants in the box`);

  // BAN
  const addresses: (string | number)[][] = [];
  for (const [id, num, rep, voie, cp, insee, commune, lon, lat] of await banRows()) {
    const lo = Number(lon), la = Number(lat);
    const t = cellOf(lo, la);
    if (t < 0) continue;
    sums.addr[t] += 1;
    addresses.push([id, +lo.toFixed(6), +la.toFixed(6), `${num}${rep ? " " + rep : ""} ${voie}`.trim(), cp, insee, commune]);
  }
  const gz = path.join(ROOT, "data/addresses.json.gz");
  fs.writeFileSync(gz, zlib.gzipSync(JSON.stringify({
    source: "Base Adresse Nationale (adresse.data.gouv.fr)", columns: ["id", "lon", "lat", "label", "postcode", "insee", "commune"], addresses,
  })));
  console.log(`[ban] ${addresses.length} addresses in the box · wrote data/addresses.json.gz (${Math.round(fs.statSync(gz).size / 1024)} KB)`);

  // sparse per terrain cell
  const idxs: number[] = [];
  for (let i = 0; i < N; i++) if (sums.ind[i] > 0 || sums.addr[i] > 0) idxs.push(i);
  const pick = (a: Float64Array) => idxs.map((i) => r1(a[i]));
  writeData("data/population-grid.json", {
    cols: g.cols, rows: g.rows, bbox: g.bbox, sources: ["INSEE Filosofi 2019 (200 m)", "BAN"],
    cells: idxs, ind: pick(sums.ind), ind80p: pick(sums.ind80p), ind65_79: pick(sums.ind65_79), ind0_3: pick(sums.ind0_3),
    men1: pick(sums.men1), addr: idxs.map((i) => sums.addr[i]),
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
