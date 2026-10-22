// Météo-France hourly station observations (open data, meteo.data.gouv.fr, Licence Ouverte 2.0, no API key).
// RR1 = rain fallen in the hour ending at AAAAMMJJHH (UTC), in mm.
// Downloads the "latest" hourly file of the Gard (30) and Hérault (34) departments into the OS temp dir,
// keeps the stations of the Vidourle basin box for 18–22 Oct 2026, caches those rows in data/raw/rain_hourly.csv
// and writes data/rain.json. --refresh downloads again (the files are updated daily).
// Run: npx tsx scripts/fetch-rain.ts [--refresh]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import type { RainObs, RainStation } from "../lib/types";
import { RAW, download, inBox, writeData } from "./_net";

const REFRESH = process.argv.includes("--refresh");
const DEPTS = ["30", "34"];
const BOX: [number, number, number, number] = [3.70, 43.55, 4.30, 44.10]; // Vidourle basin + coast, wider than the terrain grid
const FROM = "2026101800", TO = "2026102223";
const CACHE = path.join(RAW, "rain_hourly.csv");
const TMP = path.join(os.tmpdir(), "noe-data");
// Stations inside the Vidourle catchment (the others are neighbouring Gardon / Hérault / Lez basins: storm context only).
// Upstream ones drain to the Sommières gauge hours later; Villevieille is at Sommières itself.
const BASIN: Record<string, { upstream: boolean; note: string }> = {
  "30263001": { upstream: true, note: "Vidourle, St-Hippolyte-du-Fort" },
  "30349001": { upstream: true, note: "Vidourle, Vic-le-Fesq" },
  "30224001": { upstream: true, note: "Crieulon (Vidourle tributary), La Rouvière" },
  "30352002": { upstream: false, note: "Vidourle, Sommières" },
};

async function extract(): Promise<string[]> {
  const rows: string[] = ["NUM_POSTE;NOM_USUEL;LAT;LON;ALTI;AAAAMMJJHH;RR1"];
  for (const d of DEPTS) {
    const file = await download(
      `https://meteofrance.s3.sbg.io.cloud.ovh.net/data/synchro_ftp/BASE/HOR/H_${d}_latest-2025-2026.csv.gz`,
      path.join(TMP, `H_${d}_latest.csv.gz`), REFRESH,
    );
    const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    let header: string[] | null = null;
    let kept = 0;
    for await (const line of rl) {
      const f = line.split(";");
      if (!header) { header = f; continue; }
      const ts = f[5];
      if (ts < FROM || ts > TO) continue;
      const lat = Number(f[2]), lon = Number(f[3]);
      if (!inBox(lon, lat, BOX)) continue;
      rows.push([f[0], f[1], f[2], f[3], f[4], ts, f[6]].join(";"));
      kept++;
    }
    console.log(`[rain] dept ${d}: ${kept} hourly rows in the box`);
  }
  fs.writeFileSync(CACHE, rows.join("\n") + "\n");
  return rows;
}

async function main() {
  const rows = !REFRESH && fs.existsSync(CACHE) ? fs.readFileSync(CACHE, "utf8").trim().split("\n") : await extract();
  const stations = new Map<string, RainStation>();
  const observations: RainObs[] = [];
  for (const line of rows.slice(1)) {
    const [code, name, lat, lon, alt, ts, rr1] = line.split(";");
    if (rr1 === "" || rr1 == null) continue; // station without a rain gauge (or missing hour)
    const la = Number(lat), lo = Number(lon);
    if (!stations.has(code)) {
      stations.set(code, {
        code, name, lat: la, lon: lo, alt_m: alt === "" ? null : Number(alt),
        basin: code in BASIN, upstream: BASIN[code]?.upstream ?? false,
      });
    }
    const iso = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:00:00.000Z`;
    observations.push({ station_code: code, ts: iso, rr1_mm: Number(rr1) });
  }
  observations.sort((a, b) => a.ts.localeCompare(b.ts) || a.station_code.localeCompare(b.station_code));

  // event totals (19 Oct 12:00Z -> 20 Oct 12:00Z) for the log
  const tot = new Map<string, number>();
  for (const o of observations) if (o.ts > "2026-10-19T12" && o.ts <= "2026-10-20T12:00:00.000Z") tot.set(o.station_code, (tot.get(o.station_code) ?? 0) + o.rr1_mm);
  const top = [...tot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  for (const [code, mm] of top) {
    const s = stations.get(code)!;
    console.log(`[rain] ${s.name.padEnd(22)} ${s.basin ? (s.upstream ? "basin, upstream" : "basin          ") : "neighbour      "} ${mm.toFixed(1)} mm (19 Oct 12Z – 20 Oct 12Z)`);
  }
  const list = [...stations.values()].sort((a, b) => b.lat - a.lat);
  writeData("data/rain.json", { source: "Météo-France, données climatologiques de base horaires (meteo.data.gouv.fr)", stations: list, observations });
  console.log(`[rain] ${list.length} stations (${list.filter((s) => s.basin).length} in the Vidourle basin, ${list.filter((s) => s.upstream).length} upstream of Sommières), ${observations.length} hourly values`);
}

main().catch((e) => { console.error(e); process.exit(1); });
