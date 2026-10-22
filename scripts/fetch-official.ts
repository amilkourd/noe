// Official flood references for the NOÉ box, from public French services (no API key):
//   Vigicrues (vigicrues.gouv.fr)    historic floods + forecast status per gauge, Vidourle vigilance (snapshot only:
//                                    Vigicrues publishes no vigilance archive, so 19–20 Oct cannot be replayed)
//   Géorisques (georisques.gouv.fr)  TRI flood-hazard polygons (EU Floods Directive, 2020 reporting), CatNat history,
//                                    flood atlases (AZI) and TRI per commune
//   geo.api.gouv.fr                  communes in the box (INSEE code, population, centre)
// Raw responses are cached in data/raw/official/ (use --refresh to refetch). Writes:
//   data/official.json          gauges' historic floods, vigilance snapshot, communes + flood disaster declarations
//   data/flood-zones.json.gz    Vidourle hazard polygons (frequent / medium / extreme), seeded into PostGIS
//   data/flood-zones-grid.json  per terrain cell: most frequent official scenario covering the cell centre
// Run: npx tsx scripts/fetch-official.ts [--refresh]   (after fetch-osm + build-terrain)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { TerrainGrid } from "../lib/terrain";
import type { FloodZoneScenario } from "../lib/types";
import { BBOX, ROOT, bboxOf, cachedJson, getJson, inBox, pointInPoly, polysOf, readData, sleep, writeData } from "./_net";

const REFRESH = process.argv.includes("--refresh");
const GAUGES = ["Y341400501", "Y344402001", "Y345401001", "Y346400501"];
const VIGI_SECTION = "GA6"; // Vigicrues tronçon "Vidourle" (SPC Grand Delta)
const RIVER = "Vidourle";

const LAYERS: { layer: string; scenario: FloodZoneScenario }[] = [
  { layer: "ALEA_SYNT_01_01FOR_FXX", scenario: "frequent" }, // 10–30 year return period
  { layer: "ALEA_SYNT_01_02MOY_FXX", scenario: "medium" },   // 100–300 year ("centennal")
  { layer: "ALEA_SYNT_01_04FAI_FXX", scenario: "extreme" },  // ≥ 1000 year
];
export const ZONE_RANK: Record<FloodZoneScenario, number> = { extreme: 1, medium: 2, frequent: 3 };

const VIGI_LABEL: Record<number, string> = { 1: "green", 2: "yellow", 3: "orange", 4: "red" };

// ---------------------------------------------------------------- Vigicrues
interface VcStation {
  CdStationHydro: string; LbStationHydro: string; LbCoursEau: string; CdCommune: string;
  VigilanceCrues?: { StationPrevision?: boolean; CruesHistoriques?: { LbUsuel: string; ValHauteur: number | null; ValDebit: number | null }[] };
}

async function vigicrues() {
  const stations = [];
  for (const code of GAUGES) {
    const s = await cachedJson<VcStation>(`official/vigicrues_station_${code}.json`, REFRESH, () =>
      getJson(`https://www.vigicrues.gouv.fr/services/station.json/index.php?CdStationHydro=${code}`));
    const hist = s.VigilanceCrues?.CruesHistoriques ?? [];
    stations.push({
      code, name: s.LbStationHydro, river: s.LbCoursEau, commune: s.CdCommune,
      forecastPoint: !!s.VigilanceCrues?.StationPrevision,
      historic: hist.map((h) => ({ label: h.LbUsuel, h_m: h.ValHauteur, q_m3s: h.ValDebit })),
    });
    console.log(`[vigicrues] ${code} ${s.LbStationHydro}: ${hist.map((h) => `${h.LbUsuel} ${h.ValHauteur} m / ${h.ValDebit} m³/s`).join(" · ")}`);
  }
  const vig = await cachedJson<{ fetchedAt: string; feature: { properties: Record<string, unknown>; geometry: unknown } | null }>(
    `official/vigicrues_vigilance_${VIGI_SECTION}.json`, REFRESH, async () => {
      const all = await getJson<{ features: { properties: Record<string, unknown>; geometry: unknown }[] }>(
        "https://www.vigicrues.gouv.fr/services/1/InfoVigiCru.geojson", { timeoutMs: 180_000 });
      return { fetchedAt: new Date().toISOString(), feature: all.features.find((f) => f.properties.CdEntCru === VIGI_SECTION) ?? null };
    });
  const level = Number(vig.feature?.properties.NivInfViCr ?? NaN);
  const vigilance = vig.feature
    ? {
      code: VIGI_SECTION, name: String(vig.feature.properties.lbentcru ?? RIVER), level,
      label: VIGI_LABEL[level] ?? "unknown", fetchedAt: vig.fetchedAt, geometry: vig.feature.geometry,
    }
    : null;
  console.log(`[vigicrues] vigilance ${VIGI_SECTION}: ${vigilance ? `${vigilance.label} (level ${level}) at ${vig.fetchedAt}` : "not found"}`);
  return { stations, vigilance };
}

// ---------------------------------------------------------------- Géorisques flood zones (WFS)
function zoneFilter(): string {
  const [minLon, minLat, maxLon, maxLat] = BBOX;
  return encodeURIComponent(
    `<Filter xmlns="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2"><And>` +
    `<PropertyIsEqualTo><ValueReference>cours_deau</ValueReference><Literal>${RIVER}</Literal></PropertyIsEqualTo>` +
    `<BBOX><ValueReference>msGeometry</ValueReference><gml:Envelope srsName="urn:ogc:def:crs:EPSG::4326">` +
    `<gml:lowerCorner>${minLat} ${minLon}</gml:lowerCorner><gml:upperCorner>${maxLat} ${maxLon}</gml:upperCorner></gml:Envelope></BBOX>` +
    `</And></Filter>`,
  );
}

interface ZoneFeature {
  type: "Feature";
  properties: { id: string; scenario: FloodZoneScenario; river: string; tri: string; source: "georisques" };
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
}

async function floodZones(): Promise<ZoneFeature[]> {
  const out = path.join(ROOT, "data/flood-zones.json.gz");
  if (!REFRESH && fs.existsSync(out)) {
    const fc = JSON.parse(zlib.gunzipSync(fs.readFileSync(out)).toString("utf8")) as { features: ZoneFeature[] };
    console.log(`[georisques] flood zones: ${fc.features.length} polygons (cached)`);
    return fc.features;
  }
  const features: ZoneFeature[] = [];
  const PAGE = 500;
  for (const { layer, scenario } of LAYERS) {
    for (let start = 0; ; start += PAGE) {
      const url = `https://georisques.gouv.fr/services?service=WFS&version=2.0.0&request=GetFeature&typeNames=ms:${layer}` +
        `&count=${PAGE}&startIndex=${start}&outputFormat=geojson&FILTER=${zoneFilter()}`;
      const fc = await getJson<{ features: { properties: Record<string, string>; geometry: ZoneFeature["geometry"] }[] }>(url, { timeoutMs: 240_000 });
      for (const f of fc.features) {
        if (!f.geometry) continue;
        features.push({
          type: "Feature",
          properties: { id: `${scenario}-${f.properties.id}`, scenario, river: f.properties.cours_deau, tri: f.properties.id_tri, source: "georisques" },
          geometry: f.geometry,
        });
      }
      console.log(`[georisques] ${layer} page ${start / PAGE + 1}: ${fc.features.length}`);
      if (fc.features.length < PAGE) break;
    }
  }
  fs.writeFileSync(out, zlib.gzipSync(JSON.stringify({ type: "FeatureCollection", features })));
  console.log(`[georisques] wrote data/flood-zones.json.gz: ${features.length} polygons (${Math.round(fs.statSync(out).size / 1024)} KB)`);
  return features;
}

/** Per terrain cell: rank of the most frequent official scenario containing the cell centre (0 = outside all). */
function zoneGrid(g: TerrainGrid, features: ZoneFeature[]): number[] {
  const [minLon, minLat, maxLon, maxLat] = g.bbox;
  const cw = (maxLon - minLon) / g.cols, ch = (maxLat - minLat) / g.rows;
  const rank = new Array<number>(g.cols * g.rows).fill(0);
  for (const f of features) {
    const r = ZONE_RANK[f.properties.scenario];
    for (const poly of polysOf(f.geometry)) {
      const [a, b, c, d] = bboxOf(poly);
      const c0 = Math.max(0, Math.floor((a - minLon) / cw - 0.5)), c1 = Math.min(g.cols - 1, Math.ceil((c - minLon) / cw - 0.5));
      const r0 = Math.max(0, Math.floor((maxLat - d) / ch - 0.5)), r1 = Math.min(g.rows - 1, Math.ceil((maxLat - b) / ch - 0.5));
      for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) {
        const i = row * g.cols + col;
        if (rank[i] >= r) continue;
        const lon = minLon + (col + 0.5) * cw, lat = maxLat - (row + 0.5) * ch;
        if (pointInPoly(lon, lat, poly)) rank[i] = r;
      }
    }
  }
  return rank;
}

// ---------------------------------------------------------------- communes + CatNat (geo.api + Géorisques GASPAR)
interface GeoCommune { nom: string; code: string; population?: number; centre?: { coordinates: [number, number] } }
interface CatNat { code_national_catnat: string; date_debut_evt: string; date_fin_evt: string; date_publication_jo: string; libelle_risque_jo: string; code_insee: string; libelle_commune: string }

const frDate = (d: string | null | undefined) => {
  const m = d?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

async function gaspar<T>(endpoint: string, code: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await getJson<{ data: T[]; total_pages: number }>(
      `https://georisques.gouv.fr/api/v1/gaspar/${endpoint}?code_insee=${code}&page_size=100&page=${page}`);
    rows.push(...(r.data ?? []));
    if (page >= (r.total_pages ?? 1)) break;
    await sleep(150);
  }
  return rows;
}

async function communes() {
  const list = await cachedJson<GeoCommune[]>("official/geoapi_communes.json", REFRESH, async () => {
    const all: GeoCommune[] = [];
    for (const dep of ["30", "34"]) {
      all.push(...await getJson<GeoCommune[]>(`https://geo.api.gouv.fr/departements/${dep}/communes?fields=nom,code,population,centre&format=json`));
    }
    return all.filter((c) => c.centre && inBox(c.centre.coordinates[0], c.centre.coordinates[1]));
  });
  const docs = await cachedJson<Record<string, { catnat: CatNat[]; azi: string[]; tri: string[] }>>("official/georisques_communes.json", REFRESH, async () => {
    const out: Record<string, { catnat: CatNat[]; azi: string[]; tri: string[] }> = {};
    for (const c of list) {
      const [catnat, azi, tri] = [
        await gaspar<CatNat>("catnat", c.code),
        await gaspar<{ libelle_azi: string }>("azi", c.code),
        await gaspar<{ libelle_tri: string }>("tri", c.code),
      ];
      out[c.code] = { catnat, azi: [...new Set(azi.map((a) => a.libelle_azi))], tri: [...new Set(tri.map((t) => t.libelle_tri))] };
      console.log(`[georisques] ${c.code} ${c.nom}: ${catnat.length} CatNat, ${azi.length} AZI, ${tri.length} TRI`);
    }
    return out;
  });
  const disasters = [];
  const rows = [];
  for (const c of list) {
    const d = docs[c.code] ?? { catnat: [], azi: [], tri: [] };
    const floods = d.catnat.filter((x) => /inondation/i.test(x.libelle_risque_jo));
    for (const x of floods) {
      disasters.push({
        code: x.code_national_catnat, commune_code: c.code, start_date: frDate(x.date_debut_evt), end_date: frDate(x.date_fin_evt),
        published: frDate(x.date_publication_jo), label: x.libelle_risque_jo,
      });
    }
    const last = floods.map((x) => frDate(x.date_debut_evt)).filter((x): x is string => !!x).sort().pop() ?? null;
    rows.push({
      code: c.code, name: c.nom, population: c.population ?? null, lon: c.centre!.coordinates[0], lat: c.centre!.coordinates[1],
      flood_disasters: floods.length, last_flood_disaster: last,
      vidourle_atlas: d.azi.some((a) => /vidourle/i.test(a)), azi: d.azi, tri: d.tri,
    });
  }
  rows.sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
  console.log(`[communes] ${rows.length} communes in the box, ${disasters.length} flood disaster declarations (CatNat)`);
  return { communes: rows, disasters };
}

// ---------------------------------------------------------------- main
async function main() {
  const { stations, vigilance } = await vigicrues();
  const zones = await floodZones();
  const { communes: cs, disasters } = await communes();

  const g = readData<TerrainGrid>("data/terrain-grid.json");
  if (g) {
    const rank = zoneGrid(g, zones);
    const n = (r: number) => rank.filter((x) => x === r).length;
    writeData("data/flood-zones-grid.json", { cols: g.cols, rows: g.rows, bbox: g.bbox, rank, legend: ZONE_RANK });
    console.log(`[zones] terrain cells inside official zones: frequent ${n(3)}, medium-only ${n(2)}, extreme-only ${n(1)}`);
  } else {
    console.warn("[zones] data/terrain-grid.json missing: skipped flood-zones-grid.json (run data:terrain first)");
  }

  const byScenario: Record<string, number> = {};
  for (const z of zones) byScenario[z.properties.scenario] = (byScenario[z.properties.scenario] ?? 0) + 1;
  writeData("data/official.json", {
    fetchedAt: new Date().toISOString(),
    stations, vigilance, communes: cs, disasters,
    floodZones: { river: RIVER, polygons: byScenario, tri: [...new Set(zones.map((z) => z.properties.tri))] },
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
