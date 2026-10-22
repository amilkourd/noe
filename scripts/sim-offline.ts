// Offline replay of NOÉ's pure pipeline (no DB): forecaster -> flood model -> exposure -> dispatcher -> template copilot.
// Usage: npx tsx scripts/sim-offline.ts [--step 15] [--quiet]
// Prints a timeline table plus the learner metric (ETA error per model vs. the real 2.0 m crossing).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { config } from "dotenv";
import type { FloodZoneScenario, Flow, Observation, RainObs, RainStation, Rescuer, Resident, Site, Station } from "../lib/types";
import { runForecast, lagDiagnostics, type ForecastDraft } from "../lib/forecaster";
import { computeExposures, floodAt, FLOOD_PARAMS, type GridLike } from "../lib/exposure";
import { draftAssignments, roadCuts, type Need, type RoadLike } from "../lib/dispatcher";
import { summarizeRain, templateInsights, type CopilotContext } from "../lib/copilot";
import { haversineM, parisHHmm, parisDayHHmm } from "../lib/geo";

config({ path: ".env.local" });
const ROOT = process.cwd();
const rd = <T>(p: string): T | null => {
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f)) return null;
  const buf = fs.readFileSync(f);
  return JSON.parse((p.endsWith(".gz") ? zlib.gunzipSync(buf) : buf).toString("utf8")) as T;
};
const args = process.argv.slice(2);
const STEP_MIN = Number(args[args.indexOf("--step") + 1]) || 15;
const START = new Date(process.env.REPLAY_START || "2026-10-19T18:00:00Z");
const END = new Date(process.env.REPLAY_END || "2026-10-20T12:00:00Z");

// ---------------------------------------------------------------- data
const gauges = rd<{ stations: Station[]; observations: Observation[]; flows?: Flow[] }>("data/gauges.json");
if (!gauges) throw new Error("data/gauges.json missing (npm run data:gauges)");
const stations = gauges.stations;
const obsBy: Record<string, Observation[]> = {};
for (const o of gauges.observations) (obsBy[o.station_code] ??= []).push(o);
for (const k of Object.keys(obsBy)) obsBy[k].sort((a, b) => a.ts.localeCompare(b.ts));
const target = stations.find((s) => s.role === "target")!;
const T = target.threshold_m ?? 2.0;

// same site file as db:seed: official directories when fetched (npm run data:sites), else OSM
const officialSites = rd<Site[]>("data/sites-official.json");
const sites = officialSites ?? rd<Site[]>("data/sites.json") ?? [];
const zonesTagged = tagOfficialZones(sites);
const siteById = new Map(sites.map((s) => [s.id, s]));
// public reference data for the copilot context (scripts/fetch-official.ts, fetch-rain.ts)
const official = rd<{ stations: { code: string; historic: { label: string; h_m: number | null; q_m3s: number | null }[] }[] }>("data/official.json");
const rain = rd<{ stations: RainStation[]; observations: RainObs[] }>("data/rain.json");
const roads = rd<RoadLike[]>("data/roads.json") ?? [];
const personas = rd<{ residents: Resident[]; rescuers: Rescuer[] }>("data/personas.json");
let g = rd<GridLike>("data/terrain-grid.json");
const synthetic = !g;
if (!g) g = syntheticGrid();
const residents: Resident[] = personas?.residents ?? [testResident()];
const rescuers: Rescuer[] = (personas?.rescuers ?? testRescuers()).map((r) => ({ ...r, available: true }));

console.log(`grid ${g.cols}x${g.rows}${synthetic ? " (SYNTHETIC test grid: data/terrain-grid.json not found)" : ""} · sites ${sites.length}${officialSites ? ` (official, ${zonesTagged} in a Géorisques zone)` : ""} · roads ${roads.length} · residents ${residents.length}${personas ? "" : " (test)"} · rescuers ${rescuers.length}`);
console.log("FLOOD_PARAMS", JSON.stringify(FLOOD_PARAMS));
console.log(`reference: flows ${gauges.flows?.length ?? "missing"} · historic floods ${official ? official.stations.reduce((n, x) => n + x.historic.length, 0) : "missing"} · rain values ${rain?.observations.length ?? "missing"}`);

// ---------------------------------------------------------------- loop
const until = (t: number) => {
  const o: Record<string, Observation[]> = {};
  for (const [k, arr] of Object.entries(obsBy)) o[k] = arr.filter((x) => Date.parse(x.ts) <= t);
  return o;
};
const rows: string[][] = [];
const etas: { t: number; v0: number | null; v1: number | null; best: ForecastDraft }[] = [];
let printedInsight = false;
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const header = ["time", "hSom", "best", "ETA", "conf", "peak", "v0 ETA", "v1 ETA", "lag", "flooded", "sites", "res", "Garcia", "first road cut"];

for (let t = START.getTime(); t <= END.getTime(); t += STEP_MIN * 60_000) {
  const simTime = new Date(t);
  const obs = until(t);
  const { drafts, best, projection } = runForecast({ simTime, stations, obs });
  const v0 = drafts.find((d) => d.model === "trend_v0") ?? null;
  const v1 = drafts.find((d) => d.model === "lag_v1") ?? null;
  const lag = lagDiagnostics({ simTime, stations, obs });
  const hNow = projection[0].h;
  const flood = floodAt(g, hNow);
  const exps = computeExposures({ g, simTime, hNow, projection, sites, residents });
  const nSites = exps.filter((e) => e.target_type === "site").length;
  const nRes = exps.filter((e) => e.target_type === "resident").length;
  const garcia = exps.find((e) => e.target_id === "res-garcia");
  const cuts = roadCuts({ simTime, g, projection, roads });
  const c0 = cuts[0];
  etas.push({ t, v0: v0?.eta_crossing ? Date.parse(v0.eta_crossing) : null, v1: v1?.eta_crossing ? Date.parse(v1.eta_crossing) : null, best });
  rows.push([
    parisDayHHmm(simTime), best.h_now_m.toFixed(2), best.model, parisHHmm(best.eta_crossing), `${Math.round(best.confidence * 100)}%`,
    best.peak_h_m !== null ? `${best.peak_h_m}@${parisHHmm(best.peak_time)}` : "-",
    parisHHmm(v0?.eta_crossing), v1 ? parisHHmm(v1.eta_crossing) : "n/a",
    lag ? `${lag.upstream.slice(0, 6)}+${lag.lagMin}m r2=${lag.r2.toFixed(2)}` : "-",
    String(flood.cells.length), String(nSites), String(nRes),
    garcia ? `${parisHHmm(garcia.eta)} ${garcia.depth_m}m` : "-",
    c0 ? `${c0.ref ?? c0.name} ${c0.floodedAt ? "≈" + parisHHmm(c0.floodedAt) : "now"}` : "-",
  ]);

  // once Garcia is exposed within 90 min: build a need, a draft and the template insight (what ARK would show)
  if (!printedInsight && garcia && Date.parse(garcia.eta!) - t <= 90 * 60_000) {
    printedInsight = true;
    const r = residents.find((x) => x.id === "res-garcia")!;
    const needs: Need[] = [{ targetType: "resident", targetId: r.id, label: r.name, lat: r.lat, lon: r.lon, priority: garcia.priority, reason: "needs_help", persona: r.persona, note: "cannot climb stairs" }];
    const label = new Map<string, string>([...sites.map((s) => [s.id, s.name] as [string, string]), ...residents.map((x) => [x.id, x.name] as [string, string])]);
    const drafts2 = draftAssignments({ simTime, g, hNow, projection, needs, rescuers, roads });
    const context = contextAt(t);
    const ins = templateInsights({
      simTime: simTime.toISOString(), forecasts: [best, ...drafts.filter((d) => d !== best)],
      // as lib/replay.ts: top 10 + up to 3 exposed sites (care homes first) that the dispatcher takes as needs
      topExposures: [...exps.slice(0, 10), ...exps.filter((e) => e.target_type === "site" && !exps.slice(0, 10).includes(e))
        .sort((a, b) => Number(siteById.get(a.target_id)?.kind !== "care_home") - Number(siteById.get(b.target_id)?.kind !== "care_home") || b.priority - a.priority)
        .slice(0, 3)].map((e) => {
        const s = e.target_type === "site" ? siteById.get(e.target_id) : undefined;
        return {
          ...e, label: label.get(e.target_id) ?? e.target_id,
          ...(s && {
            capacity: s.capacity, category: s.category ?? null, source: s.source, capacity_source: s.capacity_source ?? null,
            official_zone: s.official_zone ?? null, official_depth: s.official_depth ?? null,
          }),
        };
      }),
      openNeeds: needs, drafts: drafts2, roadCuts: cuts.slice(0, 8),
      availableRescuers: rescuers.slice(0, 10).map((x) => ({ id: x.id, name: x.name, tier: x.tier, org: x.org, distanceToNearestNeedM: x.lat !== null && x.lon !== null ? Math.round(haversineM({ lat: x.lat, lon: x.lon }, r)) : null })),
      context,
    });
    console.log(`\n--- at ${parisDayHHmm(simTime)} (Paris): Garcia exposed, eta ${parisHHmm(garcia.eta)}; drafts:`);
    for (const d of drafts2) console.log("  ", JSON.stringify({ ...d, roadCuts: d.roadCuts.slice(0, 3) }));
    console.log("--- copilot context:");
    for (const f of context.flows) console.log(`   flow ${f.station_code} ${f.q_m3s} m³/s @ ${parisHHmm(f.ts)}`);
    for (const x of context.rain) console.log(`   rain ${x.station_code} ${x.name}${x.upstream ? " (upstream)" : ""}: ${x.mm_1h} / ${x.mm_3h} / ${x.mm_6h} mm in 1 / 3 / 6 h`);
    for (const e of exps.filter((x) => x.target_type === "site").slice(0, 5)) {
      const s = siteById.get(e.target_id);
      console.log(`   site ${e.target_id} ${s?.name} · zone ${s?.official_zone ?? "-"} · depth ${s?.official_depth ?? "-"} · capacity ${s?.capacity ?? "-"}`);
    }
    console.log("--- template insights:");
    for (const i of ins) console.log(`  [${i.kind}] ${i.title}\n      ${i.detail}  (conf ${i.confidence})`);
    console.log("");
  }
}

// ---------------------------------------------------------------- table
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
console.log(header.map((h, i) => pad(h, widths[i])).join(" | "));
for (const r of rows) console.log(r.map((c, i) => pad(c, widths[i])).join(" | "));

// ---------------------------------------------------------------- learner metric
const tgtObs = obsBy[target.code];
let actual: number | null = null;
for (let i = 1; i < tgtObs.length; i++) {
  const a = tgtObs[i - 1], b = tgtObs[i];
  const ta = Date.parse(a.ts), tb = Date.parse(b.ts);
  if (ta >= START.getTime() - 6 * 3_600_000 && a.h_m < T && b.h_m >= T) { actual = ta + ((T - a.h_m) * (tb - ta)) / (b.h_m - a.h_m); break; }
}
console.log(`\nActual crossing of ${T} m (${target.threshold_label ?? "threshold"}) at Sommières: ${actual ? parisDayHHmm(actual) + " Paris (" + new Date(actual).toISOString() + ")" : "never"}`);
if (actual) {
  const win = etas.filter((e) => e.t < actual! && e.t >= actual! - 3 * 3_600_000);
  for (const m of ["v0", "v1"] as const) {
    const errs = win.filter((e) => e[m] !== null).map((e) => Math.abs((e[m]! - actual!) / 60_000));
    const at1h = [...etas].reverse().find((e) => e.t <= actual! - 60 * 60_000);
    const e1 = at1h && at1h[m] !== null ? Math.round((at1h[m]! - actual) / 60_000) : null;
    console.log(`  ${m === "v0" ? "trend_v0" : "lag_v1  "}: mean |ETA error| over the 3 h before crossing = ${errs.length ? Math.round(errs.reduce((a, b) => a + b, 0) / errs.length) + " min (" + errs.length + " forecasts)" : "n/a"}; error at T-1h = ${e1 === null ? "n/a" : e1 + " min"}`);
  }
  const firstGood = etas.find((e) => e.t < actual! && e.best.eta_crossing && Math.abs(Date.parse(e.best.eta_crossing) - actual!) <= 30 * 60_000 && e.best.confidence >= 0.6);
  console.log(`  first best-model ETA within ±30 min with conf ≥ 60%: ${firstGood ? parisDayHHmm(firstGood.t) + " → lead time " + Math.round((actual - firstGood.t) / 60_000) + " min" : "none"}`);
}

// ---------------------------------------------------------------- copilot context (what lib/replay.ts loads from the DB)
function contextAt(t: number): CopilotContext {
  const latest = new Map<string, Flow>();
  for (const f of gauges!.flows ?? []) {
    const p = latest.get(f.station_code);
    if (Date.parse(f.ts) <= t && (!p || Date.parse(f.ts) > Date.parse(p.ts))) latest.set(f.station_code, f);
  }
  const name = new Map(stations.map((s) => [s.code, s.name]));
  return {
    flows: [...latest.values()].map((f) => ({ station_code: f.station_code, name: name.get(f.station_code) ?? f.station_code, ts: f.ts, q_m3s: f.q_m3s })),
    historicFloods: (official?.stations ?? []).flatMap((s) => s.historic.map((h) => ({ station_code: s.code, ...h }))),
    rain: rain ? summarizeRain(rain.stations, rain.observations, t) : [],
  };
}

/** Offline twin of the db:seed PostGIS step: most frequent Géorisques scenario whose polygon contains the site. */
function tagOfficialZones(list: Site[]): number {
  type Ring = [number, number][];
  const z = rd<{ features: { properties: { scenario: FloodZoneScenario }; geometry: { type: string; coordinates: Ring[] | Ring[][] } }[] }>("data/flood-zones.json.gz");
  if (!z) return 0;
  const order: FloodZoneScenario[] = ["frequent", "medium", "extreme"];
  const inside = (polys: Ring[][], lon: number, lat: number) => polys.some((rings) => {
    let x = false; // even-odd over outer ring + holes
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) x = !x;
    }
    return x;
  });
  let n = 0;
  for (const s of list) {
    const hit = z.features
      .filter((f) => inside(f.geometry.type === "Polygon" ? [f.geometry.coordinates as Ring[]] : (f.geometry.coordinates as Ring[][]), s.lon, s.lat))
      .map((f) => f.properties.scenario);
    s.official_zone = order.find((sc) => hit.includes(sc)) ?? null;
    if (s.official_zone) n++;
  }
  return n;
}

// ---------------------------------------------------------------- test fixtures (only when real data files are missing)
function testResident(): Resident {
  return { id: "res-garcia", name: "Mrs Garcia", age: 84, language: "es", mobility: "reduced", floor: 0, address: null, lat: 43.7826, lon: 4.0905, elevation_m: null, persona: true };
}
function testRescuers(): Rescuer[] {
  const base = { country: "FR", available: true, home_lat: null, home_lon: null, updated_at: new Date().toISOString(), persona: true };
  return [
    { ...base, id: "rb-karim", name: "Karim Becker", org: "DLRG", country: "DE", tier: "T3", lat: 43.7900, lon: 4.0850 },
    { ...base, id: "rb-t1", name: "Paul Martin", org: "SDIS 30", tier: "T1", lat: 43.7840, lon: 4.0960 },
  ];
}
function syntheticGrid(): GridLike {
  const river = rd<[number, number][]>("data/river.json") ?? [[4.0, 43.91], [4.089, 43.784], [4.15, 43.72]];
  const bbox: [number, number, number, number] = [3.95, 43.64, 4.22, 43.93];
  const cols = 240, rows = 290;
  const n = cols * rows;
  const elev = new Array(n), riverDist = new Array(n), riverBedElev = new Array(n), urban = new Array(n).fill(0), station = new Array(n);
  const bedAt = (lat: number) => 5 + (lat - 43.64) * 250; // ~5 m at the coast, ~77 m at Quissac
  const stCodes = stations.map((s) => s.code);
  const pts = river.length > 1 ? river : [[4.0, 43.91], [4.15, 43.72]];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    const lon = bbox[0] + ((c + 0.5) * (bbox[2] - bbox[0])) / cols, lat = bbox[3] - ((r + 0.5) * (bbox[3] - bbox[1])) / rows;
    let best = Infinity, bl = lat;
    for (let k = 0; k < pts.length; k += 2) {
      const d = haversineM({ lat, lon }, { lat: pts[k][1], lon: pts[k][0] });
      if (d < best) { best = d; bl = pts[k][1]; }
    }
    riverDist[i] = best;
    riverBedElev[i] = bedAt(bl);
    elev[i] = bedAt(bl) + 0.5 + best * 0.004 + Math.max(0, best - 600) * 0.01 + Math.sin(c * 0.7) * Math.cos(r * 0.5) * 0.4;
    let st = -1, sd = Infinity;
    stations.forEach((s, j) => { const d = Math.abs(s.lat - bl); if (d < sd) { sd = d; st = j; } });
    station[i] = best > 2500 ? -1 : st;
  }
  return { bbox, cols, rows, elev, riverDist, riverBedElev, urban, station, stations: stCodes };
}
