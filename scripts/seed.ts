// Seed the NOÉ database (Aiven PostgreSQL + PostGIS) and generate demo personas.
//   npx tsx scripts/seed.ts --personas   regenerate data/personas.json (deterministic) and exit
//   npx tsx scripts/seed.ts --dry-run    print counts + samples, no DB
//   npx tsx scripts/seed.ts              apply db/schema.sql (drops everything!) then insert stations,
//                                        observations_raw (all), sites, residents, rescuers, and the public
//                                        reference data when its file exists (flows, rain, Vigicrues, Géorisques,
//                                        communes, INSEE grid, BAN addresses); PostGIS then tags sites/residents
//                                        with the official flood zone they stand in.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { config } from "dotenv";
import { Client } from "pg";
import type { Flow, Mobility, Observation, RainObs, RainStation, Rescuer, Resident, Site, Station, Tier } from "../lib/types";
import { cellCenter, cellOf, type TerrainGrid } from "../lib/terrain";

const ROOT = path.resolve(__dirname, "..");
config({ path: path.join(ROOT, ".env.local") });
config({ path: path.join(ROOT, ".env") });

const readJson = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")) as T;
/** Optional data file (plain or .gz): null when the fetch script has not been run. */
const readOptional = <T>(f: string): T | null => {
  const file = path.join(ROOT, f);
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  return JSON.parse((f.endsWith(".gz") ? zlib.gunzipSync(buf) : buf).toString("utf8")) as T;
};

// public reference data written by scripts/fetch-official.ts, fetch-rain.ts, fetch-population.ts
interface OfficialFile {
  stations: { code: string; historic: { label: string; h_m: number | null; q_m3s: number | null }[] }[];
  vigilance: { code: string; name: string; level: number; label: string; fetchedAt: string; geometry: unknown } | null;
  communes: { code: string; name: string; population: number | null; lat: number; lon: number; flood_disasters: number; last_flood_disaster: string | null; vidourle_atlas: boolean; azi: string[]; tri: string[] }[];
  disasters: { code: string; commune_code: string; start_date: string | null; end_date: string | null; published: string | null; label: string }[];
}
interface ZonesFile { features: { properties: { id: string; scenario: string; river: string; tri: string }; geometry: unknown }[] }
interface PopulationFile { cells: { id: string; lon: number; lat: number; ring: [number, number][]; ind: number; men: number; men_1ind: number; ind_0_3: number; ind_65_79: number; ind_80p: number }[] }
interface AddressesFile { addresses: [string, number, number, string, string, string, string][] }
interface Reference {
  flows: Flow[]; official: OfficialFile | null; zones: ZonesFile | null; rain: { stations: RainStation[]; observations: RainObs[] } | null;
  population: PopulationFile | null; addresses: AddressesFile | null;
}

function loadReference(gauges: { flows?: Flow[] }): Reference {
  return {
    flows: gauges.flows ?? [],
    official: readOptional<OfficialFile>("data/official.json"),
    zones: readOptional<ZonesFile>("data/flood-zones.json.gz"),
    rain: readOptional<Reference["rain"]>("data/rain.json"),
    population: readOptional<PopulationFile>("data/population.json"),
    addresses: readOptional<AddressesFile>("data/addresses.json.gz"),
  };
}

function reportReference(r: Reference) {
  const n = (x: unknown[] | undefined | null) => x?.length ?? "missing";
  console.log(`[seed] reference: flows ${n(r.flows)}, historic floods ${r.official ? r.official.stations.reduce((s, x) => s + x.historic.length, 0) : "missing"}, ` +
    `vigilance ${r.official?.vigilance ? r.official.vigilance.label : "missing"}, flood zones ${n(r.zones?.features)}, communes ${n(r.official?.communes)}, ` +
    `disasters ${n(r.official?.disasters)}, rain stations ${n(r.rain?.stations)}, rain values ${n(r.rain?.observations)}, ` +
    `population cells ${n(r.population?.cells)}, addresses ${n(r.addresses?.addresses)}`);
}

// ---------- deterministic RNG ----------
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KX = 111320 * Math.cos((43.785 * Math.PI) / 180), KY = 110574;
const distM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot((a.lon - b.lon) * KX, (a.lat - b.lat) * KY);
const SOMMIERES = { lat: 43.784, lon: 4.089 };
const TARGET_IDX = 2; // index of Sommières gauge in grid.stations

interface Personas { residents: Resident[]; rescuers: Rescuer[] }

function generatePersonas(g: TerrainGrid): Personas {
  const rnd = mulberry32(20261019);
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const N = g.cols * g.rows;
  const cellW = (g.bbox[2] - g.bbox[0]) / g.cols, cellH = (g.bbox[3] - g.bbox[1]) / g.rows;
  const rel = (i: number) => g.elev[i] - g.riverBedElev[i];
  const prone = (i: number) => g.riverDist[i] < 1500 && rel(i) >= 0.3 && rel(i) <= 2.5 && g.station[i] >= 0;
  const high = (i: number) => rel(i) > 6 || g.riverDist[i] > 2500;
  const centers = Array.from({ length: N }, (_, i) => cellCenter(g, i));
  const used = new Map<number, number>();
  const jitter = (i: number) => {
    const c = centers[i];
    return { lat: +(c.lat + (rnd() - 0.5) * cellH * 0.7).toFixed(6), lon: +(c.lon + (rnd() - 0.5) * cellW * 0.7).toFixed(6) };
  };

  // named streets for addresses
  const streets = readJson<{ name: string; coords: [number, number][] }[]>("data/raw/streets.json");
  const streetPts: { name: string; lat: number; lon: number }[] = [];
  for (const s of streets) for (const [lon, lat] of s.coords) if (distM({ lat, lon }, SOMMIERES) < 3500) streetPts.push({ name: s.name, lat, lon });
  const nearestStreet = (p: { lat: number; lon: number }): string | null => {
    let best: string | null = null, bd = 250;
    for (const s of streetPts) { const d = distM(p, s); if (d < bd) { bd = d; best = s.name; } }
    return best;
  };

  // ---- 12 named residents near Sommières ----
  const nearCells = [...Array(N).keys()].filter((i) => prone(i) && g.station[i] === TARGET_IDX && distM(centers[i], SOMMIERES) < 2000);
  // Garcia: clearly floods at the peak, but not among the very first (rel 0.6..0.9 m), prefer urban, close to town
  const garciaCands = nearCells.filter((i) => rel(i) >= 0.6 && rel(i) <= 0.9 && g.riverDist[i] >= 120)
    .sort((a, b) => (g.urban[b] - g.urban[a]) || distM(centers[a], SOMMIERES) - distM(centers[b], SOMMIERES));
  const fallbackGarcia = nearCells.filter((i) => rel(i) >= 0.4 && rel(i) <= 0.9).sort((a, b) => distM(centers[a], SOMMIERES) - distM(centers[b], SOMMIERES));
  const garciaCell = garciaCands[0] ?? fallbackGarcia[0];
  if (garciaCell == null) throw new Error("no cell for Mrs Garcia");
  const named: Omit<Resident, "lat" | "lon" | "elevation_m" | "address">[] = [
    { id: "res-garcia", name: "Mrs Garcia", age: 84, language: "es", mobility: "reduced", floor: 0, persona: true },
    { id: "res-martin", name: "Mr Martin", age: 71, language: "fr", mobility: "ok", floor: 0, persona: true },
    { id: "res-benali", name: "Mrs Benali", age: 67, language: "ar", mobility: "reduced", floor: 1, persona: true },
    { id: "res-ferreira", name: "Mrs Ferreira", age: 58, language: "pt", mobility: "ok", floor: 0, persona: true },
    { id: "res-dubois", name: "Mr Dubois", age: 89, language: "fr", mobility: "bedridden", floor: 0, persona: true },
    { id: "res-thompson", name: "Mrs Thompson", age: 76, language: "en", mobility: "ok", floor: 1, persona: true },
    { id: "res-haddad", name: "Mr Haddad", age: 45, language: "ar", mobility: "ok", floor: 0, persona: true },
    { id: "res-santos", name: "Mr Santos", age: 80, language: "pt", mobility: "reduced", floor: 0, persona: true },
    { id: "res-roux", name: "Mrs Roux", age: 92, language: "fr", mobility: "bedridden", floor: 1, persona: true },
    { id: "res-lopez", name: "Mr López", age: 63, language: "es", mobility: "ok", floor: 0, persona: true },
    { id: "res-obrien", name: "Mr O'Brien", age: 70, language: "en", mobility: "reduced", floor: 0, persona: true },
    { id: "res-moreau", name: "Mrs Moreau", age: 38, language: "fr", mobility: "ok", floor: 0, persona: true },
  ];
  const residents: Resident[] = [];
  const pool = nearCells.filter((i) => i !== garciaCell).sort((a, b) => (g.urban[b] - g.urban[a]) || rnd() - 0.5);
  for (const p of named) {
    let cell: number;
    if (p.id === "res-garcia") cell = garciaCell;
    else {
      // spread: avoid reusing a cell, prefer cells within 1.5 km, mix of depths
      const cands = pool.filter((i) => !used.has(i) && distM(centers[i], SOMMIERES) < (rnd() < 0.8 ? 1500 : 2000));
      cell = pick(cands.slice(0, Math.max(8, Math.floor(cands.length * 0.6))));
    }
    used.set(cell, 1);
    const pos = p.id === "res-garcia" ? { lat: +centers[cell].lat.toFixed(6), lon: +centers[cell].lon.toFixed(6) } : jitter(cell);
    const street = nearestStreet(pos);
    residents.push({ ...p, ...pos, elevation_m: g.elev[cell], address: street ? `${street}, Sommières` : null });
  }

  // ---- ~200 generic households along the corridor Sommières -> Lunel/Marsillargues ----
  const corridor = (i: number) => g.station[i] >= TARGET_IDX && centers[i].lat <= 43.80 && centers[i].lat >= 43.64;
  const proneUrban = [...Array(N).keys()].filter((i) => corridor(i) && prone(i) && g.urban[i]);
  const proneAny = [...Array(N).keys()].filter((i) => corridor(i) && prone(i) && !g.urban[i] && g.riverDist[i] < 1000);
  const higher = [...Array(N).keys()].filter((i) => corridor(i) && g.urban[i] && rel(i) > 3 && g.riverDist[i] < 2500);
  const langs = ["fr", "fr", "fr", "fr", "fr", "fr", "fr", "es", "ar", "pt", "en"];
  const mobs: Mobility[] = ["ok", "ok", "ok", "ok", "ok", "reduced", "reduced", "bedridden"];
  const HH = 200;
  for (let k = 1; k <= HH; k++) {
    const proneHh = k <= Math.round(HH * 0.7);
    const src = proneHh ? (rnd() < 0.6 && proneUrban.length ? proneUrban : proneAny) : higher;
    const cell = pick(src);
    const pos = jitter(cell);
    const id = `hh-${String(k).padStart(3, "0")}`;
    residents.push({
      id, name: `Household ${String(k).padStart(3, "0")}`, age: null, language: pick(langs), mobility: pick(mobs),
      floor: rnd() < 0.6 ? 0 : 1, address: null, ...pos, elevation_m: g.elev[cell], persona: true,
    });
  }

  // ---- rescuers ----
  const garcia = residents[0];
  const now = new Date().toISOString();
  const rescuers: Rescuer[] = [];
  // Karim: ~900 m from Garcia on high ground
  const karimCell = [...Array(N).keys()]
    .filter((i) => high(i) && Math.abs(distM(centers[i], garcia) - 900) < 150)
    .sort((a, b) => (g.urban[b] - g.urban[a]) || Math.abs(distM(centers[a], garcia) - 900) - Math.abs(distM(centers[b], garcia) - 900))[0];
  if (karimCell == null) throw new Error("no cell for Karim");
  const kp = { lat: +centers[karimCell].lat.toFixed(6), lon: +centers[karimCell].lon.toFixed(6) };
  rescuers.push({ id: "rb-karim", name: "Karim Becker", org: "DLRG", country: "DE", tier: "T3", available: false, ...kp, home_lat: kp.lat, home_lon: kp.lon, updated_at: now, persona: true });

  const team: { name: string; org: string; tier: Tier }[] = [
    { name: "Lucas Bernard", org: "SDIS 30", tier: "T3" },
    { name: "Inès Mercier", org: "SDIS 30", tier: "T3" },
    { name: "Hugo Lefèvre", org: "SNSM", tier: "T3" },
    { name: "Chloé Garnier", org: "SNSM", tier: "T3" },
    { name: "Nathan Faure", org: "SDIS 30", tier: "T3" },
    { name: "Julie Blanc", org: "SDIS 30", tier: "T2" },
    { name: "Thomas Girard", org: "SDIS 30", tier: "T2" },
    { name: "Sarah Fontaine", org: "Protection Civile", tier: "T2" },
    { name: "Antoine Chevalier", org: "Protection Civile", tier: "T2" },
    { name: "Léa Perrin", org: "Croix-Rouge", tier: "T2" },
    { name: "Maxime Robin", org: "Protection Civile", tier: "T1" },
    { name: "Camille Masson", org: "Croix-Rouge", tier: "T1" },
    { name: "Paul Lambert", org: "Croix-Rouge", tier: "T1" },
    { name: "Emma Rousseau", org: "Protection Civile", tier: "T1" },
    { name: "Louis Vincent", org: "Croix-Rouge", tier: "T1" },
    { name: "Manon Henry", org: "SDIS 30", tier: "T2" },
    { name: "Yanis Morel", org: "Protection Civile", tier: "T1" },
    { name: "Clara Fournier", org: "Croix-Rouge", tier: "T1" },
    { name: "Romain André", org: "SNSM", tier: "T2" },
  ];
  const rescCells = [...Array(N).keys()].filter((i) => {
    const d = distM(centers[i], SOMMIERES);
    return high(i) && g.urban[i] && d >= 2000 && d <= 10000;
  });
  team.forEach((t, k) => {
    const minFromGarcia = t.tier === "T3" ? 3500 : 1200;
    const cands = rescCells.filter((i) => !used.has(i) && distM(centers[i], garcia) >= minFromGarcia);
    const cell = pick(cands);
    used.set(cell, 1);
    const pos = jitter(cell);
    rescuers.push({
      id: `rb-${String(k + 1).padStart(2, "0")}`, name: t.name, org: t.org, country: "FR", tier: t.tier, available: false,
      ...pos, home_lat: pos.lat, home_lon: pos.lon, updated_at: now, persona: true,
    });
  });
  return { residents, rescuers };
}

function loadPersonas(g: TerrainGrid, regenerate: boolean): Personas {
  const file = path.join(ROOT, "data/personas.json");
  if (!regenerate && fs.existsSync(file)) return readJson<Personas>("data/personas.json");
  const p = generatePersonas(g);
  fs.writeFileSync(file, JSON.stringify(p, null, 1));
  console.log(`[seed] wrote data/personas.json`);
  return p;
}

function report(g: TerrainGrid, sites: Site[], p: Personas, gauges: { stations: Station[]; observations: Observation[] }) {
  const rel = (lat: number, lon: number) => { const i = cellOf(g, lat, lon); return i < 0 ? NaN : g.elev[i] - g.riverBedElev[i]; };
  const garcia = p.residents.find((r) => r.id === "res-garcia")!;
  const karim = p.rescuers.find((r) => r.id === "rb-karim")!;
  const t3 = p.rescuers.filter((r) => r.tier === "T3").map((r) => ({ id: r.id, d: Math.round(distM(garcia, { lat: r.lat!, lon: r.lon! })) })).sort((a, b) => a.d - b.d);
  const gi = cellOf(g, garcia.lat, garcia.lon);
  const targetProne = g.elev.map((_, i) => i).filter((i) => g.station[i] === TARGET_IDX && g.riverDist[i] < 1500 && g.elev[i] - g.riverBedElev[i] >= 0);
  const below = targetProne.filter((i) => g.elev[i] - g.riverBedElev[i] < g.elev[gi] - g.riverBedElev[gi]).length;
  const named = p.residents.filter((r) => !r.id.startsWith("hh-"));
  const hh = p.residents.filter((r) => r.id.startsWith("hh-"));
  const hhProne = hh.filter((r) => { const v = rel(r.lat, r.lon); return v >= 0.3 && v <= 2.5; }).length;
  console.log(`[seed] stations ${gauges.stations.length}, observations_raw ${gauges.observations.length}, sites ${sites.length}, residents ${p.residents.length} (named ${named.length}, households ${hh.length}, ${hhProne} flood-prone), rescuers ${p.rescuers.length} (T3 ${t3.length})`);
  for (const r of named) console.log(`  ${r.id.padEnd(13)} ${r.name.padEnd(13)} ${r.language} ${r.mobility.padEnd(9)} f${r.floor} (${r.lat}, ${r.lon}) rel ${rel(r.lat, r.lon).toFixed(1)} m, ${Math.round(distM(r, SOMMIERES))} m from centre, ${r.address ?? "no address"}`);
  console.log(`[seed] Garcia (${garcia.lat}, ${garcia.lon}) elev ${g.elev[gi]} bed ${g.riverBedElev[gi]} riverDist ${g.riverDist[gi]} m; ${below}/${targetProne.length} Sommières-reach cells are lower`);
  console.log(`[seed] Karim (${karim.lat}, ${karim.lon}) rel ${rel(karim.lat!, karim.lon!).toFixed(1)} m; distance to Garcia ${Math.round(distM(garcia, { lat: karim.lat!, lon: karim.lon! }))} m`);
  console.log(`[seed] T3 distances to Garcia: ${t3.map((x) => `${x.id} ${x.d} m`).join(", ")}`);
  for (const r of p.rescuers.slice(0, 4)) console.log(`  ${r.id} ${r.name} ${r.org} ${r.tier} ${Math.round(distM(r as { lat: number; lon: number }, SOMMIERES))} m from Sommières`);
}

async function main() {
  const args = process.argv.slice(2);
  const g = readJson<TerrainGrid>("data/terrain-grid.json");
  const gauges = readJson<{ stations: Station[]; observations: Observation[]; flows?: Flow[] }>("data/gauges.json");
  // official sites (scripts/fetch-official-sites.ts) when available, else the OSM ones; IGN elevation, else the grid
  const siteFile = fs.existsSync(path.join(ROOT, "data/sites-official.json")) ? "data/sites-official.json" : "data/sites.json";
  const sites = readJson<Site[]>(siteFile).map((s) => {
    const i = cellOf(g, s.lat, s.lon);
    return { ...s, elevation_m: s.elevation_m ?? (i >= 0 ? g.elev[i] : null) };
  });
  console.log(`[seed] sites from ${siteFile}`);
  const p = loadPersonas(g, args.includes("--personas"));
  report(g, sites, p, gauges);
  if (args.includes("--personas")) return;
  const ign = readOptional<{ residents: Record<string, number> }>("data/elevations-ign.json");
  if (ign) p.residents = p.residents.map((r) => ({ ...r, elevation_m: ign.residents[r.id] ?? r.elevation_m }));
  const ref = loadReference(gauges);
  reportReference(ref);
  if (args.includes("--dry-run")) return;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing (.env.local)");
  const ca = process.env.AIVEN_CA_CERT?.replace(/\\n/g, "\n");
  const client = new Client({
    connectionString: url.replace(/[?&]sslmode=[^&]*/g, ""),
    ssl: ca ? { ca, rejectUnauthorized: true } : url.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    console.log("[seed] applying db/schema.sql");
    await client.query(fs.readFileSync(path.join(ROOT, "db/schema.sql"), "utf8"));

    // expr: SQL around a column's parameter ("?" is replaced by $n), e.g. for GeoJSON -> PostGIS geography
    async function insert(table: string, cols: string[], rows: unknown[][], batch = 400, expr: Record<string, string> = {}) {
      for (let k = 0; k < rows.length; k += batch) {
        const chunk = rows.slice(k, k + batch);
        const params: unknown[] = [];
        const values = chunk.map((r) => `(${r.map((v, j) => {
          params.push(v);
          const ph = `$${params.length}`;
          return expr[cols[j]] ? expr[cols[j]].replace("?", ph) : ph;
        }).join(",")})`).join(",");
        await client.query(`insert into ${table} (${cols.join(",")}) values ${values} on conflict do nothing`, params);
      }
      console.log(`[seed] ${table}: ${rows.length}`);
    }
    const GEO = (kind: "multi" | "plain") => kind === "multi"
      ? "st_multi(st_collectionextract(st_makevalid(st_setsrid(st_geomfromgeojson(?),4326)),3))::geography"
      : "st_setsrid(st_geomfromgeojson(?),4326)::geography";
    await client.query("begin");
    await insert("stations", ["code", "name", "river", "role", "lat", "lon", "threshold_m", "threshold_label"],
      gauges.stations.map((s) => [s.code, s.name, s.river, s.role, s.lat, s.lon, s.threshold_m, s.threshold_label]));
    await insert("observations_raw", ["station_code", "ts", "h_m", "source"],
      gauges.observations.map((o) => [o.station_code, o.ts, o.h_m, o.source]));
    await insert("sites", ["id", "kind", "name", "capacity", "lat", "lon", "elevation_m", "source", "category", "ref", "address", "phone", "capacity_source", "official_depth"],
      sites.map((s) => [s.id, s.kind, s.name, s.capacity, s.lat, s.lon, s.elevation_m, s.source, s.category ?? null, s.ref ?? null,
        s.address ?? null, s.phone ?? null, s.capacity_source ?? null, s.official_depth ?? null]));
    await insert("residents", ["id", "name", "age", "language", "mobility", "floor", "address", "lat", "lon", "elevation_m", "persona"],
      p.residents.map((r) => [r.id, r.name, r.age, r.language, r.mobility, r.floor, r.address, r.lat, r.lon, r.elevation_m, r.persona]));
    await insert("rescuers", ["id", "name", "org", "country", "tier", "available", "lat", "lon", "home_lat", "home_lon", "persona"],
      p.rescuers.map((r) => [r.id, r.name, r.org, r.country, r.tier, r.available, r.lat, r.lon, r.home_lat, r.home_lon, r.persona]));

    // ---- public reference data
    await insert("flows_raw", ["station_code", "ts", "q_m3s", "source"], ref.flows.map((f) => [f.station_code, f.ts, f.q_m3s, f.source]));
    if (ref.official) {
      const o = ref.official;
      await insert("historic_floods", ["station_code", "label", "h_m", "q_m3s"],
        o.stations.flatMap((s) => s.historic.map((h) => [s.code, h.label, h.h_m, h.q_m3s])));
      if (o.vigilance) {
        await insert("vigilance", ["code", "name", "level", "label", "fetched_at", "geom"],
          [[o.vigilance.code, o.vigilance.name, o.vigilance.level, o.vigilance.label, o.vigilance.fetchedAt, JSON.stringify(o.vigilance.geometry)]],
          1, { geom: "st_multi(st_setsrid(st_geomfromgeojson(?),4326))::geography" });
      }
      await insert("communes", ["code", "name", "population", "lat", "lon", "flood_disasters", "last_flood_disaster", "vidourle_atlas", "azi", "tri"],
        o.communes.map((c) => [c.code, c.name, c.population, c.lat, c.lon, c.flood_disasters, c.last_flood_disaster, c.vidourle_atlas, c.azi, c.tri]));
      await insert("disasters", ["code", "commune_code", "start_date", "end_date", "published", "label"],
        o.disasters.map((d) => [d.code, d.commune_code, d.start_date, d.end_date, d.published, d.label]));
    }
    if (ref.zones) {
      await insert("flood_zones", ["id", "scenario", "river", "tri", "geom"],
        ref.zones.features.map((f) => [f.properties.id, f.properties.scenario, f.properties.river, f.properties.tri, JSON.stringify(f.geometry)]),
        50, { geom: GEO("multi") });
    }
    if (ref.rain) {
      await insert("rain_stations", ["code", "name", "lat", "lon", "alt_m", "basin", "upstream"],
        ref.rain.stations.map((s) => [s.code, s.name, s.lat, s.lon, s.alt_m, s.basin, s.upstream]));
      await insert("rain_raw", ["station_code", "ts", "rr1_mm"], ref.rain.observations.map((r) => [r.station_code, r.ts, r.rr1_mm]));
    }
    if (ref.population) {
      await insert("population_cells", ["id", "ind", "men", "men_1ind", "ind_0_3", "ind_65_79", "ind_80p", "geom", "centre"],
        ref.population.cells.map((c) => [c.id, c.ind, c.men, c.men_1ind, c.ind_0_3, c.ind_65_79, c.ind_80p,
          JSON.stringify({ type: "Polygon", coordinates: [c.ring] }), JSON.stringify({ type: "Point", coordinates: [c.lon, c.lat] })]),
        300, { geom: GEO("plain"), centre: GEO("plain") });
    }
    if (ref.addresses) {
      await insert("addresses", ["id", "lon", "lat", "label", "postcode", "insee", "commune"], ref.addresses.addresses, 1000);
    }
    // PostGIS: tag every site / resident with the most frequent official scenario it stands in
    for (const t of ["sites", "residents"]) {
      const r = await client.query(
        `update ${t} x set official_zone = (
           select z.scenario from flood_zones z where st_intersects(z.geom, x.geom)
           order by case z.scenario when 'frequent' then 1 when 'medium' then 2 else 3 end limit 1)`,
      );
      const z = await client.query<{ official_zone: string | null; n: number }>(
        `select official_zone, count(*)::int as n from ${t} group by official_zone order by official_zone nulls last`);
      console.log(`[seed] ${t} official zones (${r.rowCount} rows): ${z.rows.map((x) => `${x.official_zone ?? "none"} ${x.n}`).join(", ")}`);
    }
    await client.query("commit");
    console.log("[seed] done");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
