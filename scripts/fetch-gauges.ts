// Normalise raw Hub'Eau v2 observations (data/raw/obs_<code>.json + stations.json) into data/gauges.json.
// --refresh refetches observations_tr from Hub'Eau (with retries) before normalising. Never required.
// Run: npx tsx scripts/fetch-gauges.ts [--refresh]
import fs from "node:fs";
import path from "node:path";
import type { Observation, Station, StationRole } from "../lib/types";

const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "data/raw");

const GAUGES: { code: string; role: StationRole; name: string; lat: number; lon: number }[] = [
  { code: "Y341400501", role: "upstream", name: "Le Vidourle à Quissac", lat: 43.9066, lon: 3.9999 },
  { code: "Y344402001", role: "mid", name: "Le Vidourle à Vic-le-Fesq", lat: 43.8711, lon: 4.0753 },
  { code: "Y345401001", role: "target", name: "Le Vidourle à Sommières [Mairie]", lat: 43.7823, lon: 4.0892 },
  { code: "Y346400501", role: "downstream", name: "Le Vidourle à Gallargues-le-Montueux [Autoroute A9]", lat: 43.723, lon: 4.1506 },
];
const TARGET_THRESHOLD = 2.0;

async function fetchWithRetry(url: string, tries = 4): Promise<unknown> {
  let err: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      err = e;
      console.warn(`[gauges] ${url} failed (${(e as Error).message}), retry ${i + 1}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw err;
}

async function refresh() {
  for (const g of GAUGES) {
    const url = `https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr?code_entite=${g.code}&grandeur_hydro=H&date_debut_obs=2026-10-18T00:00:00Z&size=20000&format=json`;
    const json = await fetchWithRetry(url);
    fs.writeFileSync(path.join(RAW, `obs_${g.code}.json`), JSON.stringify(json));
    console.log(`[gauges] refreshed ${g.code}`);
  }
}

async function main() {
  if (process.argv.includes("--refresh")) {
    try { await refresh(); } catch (e) { console.warn("[gauges] refresh failed, using cached raw files:", (e as Error).message); }
  }
  const rawStations = fs.existsSync(path.join(RAW, "stations.json"))
    ? (JSON.parse(fs.readFileSync(path.join(RAW, "stations.json"), "utf8")).data as Record<string, unknown>[])
    : [];
  const stations: Station[] = GAUGES.map((g) => {
    const rs = rawStations.find((s) => s.code_station === g.code);
    return {
      code: g.code,
      name: (rs?.libelle_station as string) ?? g.name,
      river: (rs?.libelle_cours_eau as string) ?? "Le Vidourle",
      role: g.role,
      lat: +(((rs?.latitude_station as number) ?? g.lat).toFixed(6)),
      lon: +(((rs?.longitude_station as number) ?? g.lon).toFixed(6)),
      threshold_m: g.role === "target" ? TARGET_THRESHOLD : null,
      threshold_label: g.role === "target" ? "demo threshold" : null,
    };
  });

  const observations: Observation[] = [];
  for (const g of GAUGES) {
    const file = path.join(RAW, `obs_${g.code}.json`);
    if (!fs.existsSync(file)) { console.warn(`[gauges] missing ${file}`); continue; }
    const data = JSON.parse(fs.readFileSync(file, "utf8")).data as { date_obs: string; resultat_obs: number | null }[];
    const byTs = new Map<string, number>();
    for (const d of data) {
      if (d.resultat_obs == null || !d.date_obs) continue;
      byTs.set(new Date(d.date_obs).toISOString(), +(d.resultat_obs / 1000).toFixed(3));
    }
    const rows = [...byTs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [ts, h] of rows) observations.push({ station_code: g.code, ts, h_m: h, source: "hubeau" });
    const peak = rows.reduce((m, r) => (r[1] > m[1] ? r : m), rows[0]);
    console.log(`[gauges] ${g.code} ${g.role.padEnd(10)} ${rows.length} obs ${rows[0]?.[0]} .. ${rows[rows.length - 1]?.[0]} peak ${peak?.[1]} m at ${peak?.[0]}`);
  }
  observations.sort((a, b) => a.ts.localeCompare(b.ts) || a.station_code.localeCompare(b.station_code));
  fs.writeFileSync(path.join(ROOT, "data/gauges.json"), JSON.stringify({ stations, observations }));
  console.log(`[gauges] wrote data/gauges.json: ${stations.length} stations, ${observations.length} observations`);
}

main().catch((e) => { console.error(e); process.exit(1); });
