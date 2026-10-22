// Official vulnerable sites in the box. They replace the OSM schools / care homes / hospitals; OSM campsites are kept.
//   Annuaire de l'éducation (data.education.gouv.fr)    open écoles, collèges, lycées, with phone and address
//   Effectifs (data.education.gouv.fr)                  pupils per school, latest school year -> capacity
//   FINESS (Ministère de la Santé, public.opendatasoft.com mirror of the Etalab extract)
//                                                       EHPAD, disability homes, hospitals. Capacity stays null: the
//                                                       FINESS+ capacity flow has undocumented status codes, and a
//                                                       wrong bed count is worse than "unknown".
//   IGN Géoplateforme altimetry (RGE ALTI, 1–5 m)      ground elevation of every site and demo persona
//   Géorisques ISO_HT (TRI, medium scenario)           official water depth class at each site in or near a flood zone
// All public, Licence Ouverte 2.0, no API key. Raw responses are cached in data/raw/official/ (--refresh to refetch).
// Writes data/sites-official.json (read by db:seed and sim-offline instead of data/sites.json) and data/elevations-ign.json.
// Run: npx tsx scripts/fetch-official-sites.ts [--refresh]   (after fetch-osm, build-terrain, fetch-official, data:personas)
import type { Resident, Site, SiteKind } from "../lib/types";
import { BBOX, cachedJson, getJson, pointInPoly, polysOf, readData, sleep, writeData } from "./_net";

const REFRESH = process.argv.includes("--refresh");
const [MIN_LON, MIN_LAT, MAX_LON, MAX_LAT] = BBOX;
const EDU = "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets";
const ODS_FINESS = "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/healthref-france-finess/records";

// ---------------------------------------------------------------- helpers
const ACRONYMS = new Set(["EHPAD", "MAS", "EAM", "EANM", "FAM", "IME", "CH", "CHU", "CHR", "SSR", "USLD", "ESAT", "II", "III", "ADAPEI", "APF"]);
const SMALL = new Set(["de", "du", "des", "la", "le", "les", "l", "d", "et", "en", "au", "aux", "sur", "a"]);
function titleCase(s: string): string {
  if (s !== s.toUpperCase()) return s.trim();
  return s.toLowerCase().split(/(\s+|-|')/).map((w, i) => {
    const up = w.toUpperCase();
    if (ACRONYMS.has(up)) return up;
    if (i > 0 && SMALL.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join("").trim();
}

async function odsAll<T>(url: string, where: string, select?: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < 10_000; offset += 100) {
    const q = `${url}?where=${encodeURIComponent(where)}&limit=100&offset=${offset}${select ? `&select=${encodeURIComponent(select)}` : ""}`;
    const r = await getJson<{ total_count: number; results: T[] }>(q);
    out.push(...r.results);
    if (out.length >= r.total_count || r.results.length < 100) break;
  }
  return out;
}

const inList = (field: string, ids: string[]) => `${field} in (${ids.map((x) => `'${x}'`).join(",")})`;
function chunks<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

// ---------------------------------------------------------------- schools
interface EduRow {
  identifiant_de_l_etablissement: string; nom_etablissement: string; type_etablissement: string; statut_public_prive: string;
  libelle_nature: string | null; adresse_1: string | null; code_postal: string | null; nom_commune: string | null;
  telephone: string | null; latitude: number | null; longitude: number | null;
}

async function schools(): Promise<Site[]> {
  const rows = await cachedJson<EduRow[]>("official/education_annuaire.json", REFRESH, () => odsAll<EduRow>(
    `${EDU}/fr-en-annuaire-education/records`,
    `in_bbox(position, ${MIN_LAT}, ${MIN_LON}, ${MAX_LAT}, ${MAX_LON}) and etat = 'OUVERT' and type_etablissement in ('Ecole', 'Collège', 'Lycée')`,
    "identifiant_de_l_etablissement,nom_etablissement,type_etablissement,statut_public_prive,libelle_nature,adresse_1,code_postal,nom_commune,telephone,latitude,longitude",
  ));
  const uai = rows.map((r) => r.identifiant_de_l_etablissement);

  // pupils, latest school year per establishment (lycées polyvalents appear in both GT and pro datasets: summed)
  const pupils = await cachedJson<Record<string, { year: string; n: number }>>("official/education_effectifs.json", REFRESH, async () => {
    const best: Record<string, Record<string, { year: string; n: number }>> = {};
    const sets: [string, string, string][] = [
      ["fr-en-ecoles-effectifs-nb_classes", "numero_ecole", "nombre_total_eleves"],
      ["fr-en-college-effectifs-niveau-sexe-lv", "numero_college", "nombre_eleves_total"],
      ["fr-en-lycee_gt-effectifs-niveau-sexe-lv", "numero_lycee", "nombre_d_eleves"],
      ["fr-en-lycee_pro-effectifs-niveau-sexe-lv", "numero_lycee", "nombre_d_eleves"],
    ];
    for (const [ds, key, val] of sets) {
      for (const part of chunks(uai, 40)) {
        const r = await odsAll<Record<string, string | number>>(`${EDU}/${ds}/records`, inList(key, part), `rentree_scolaire,${key},${val}`);
        for (const x of r) {
          const id = String(x[key]), year = String(x.rentree_scolaire), n = Number(x[val]);
          if (!Number.isFinite(n)) continue;
          const cur = ((best[id] ??= {})[ds]);
          if (!cur || year > cur.year) best[id][ds] = { year, n };
        }
        await sleep(100);
      }
    }
    const out: Record<string, { year: string; n: number }> = {};
    for (const [id, byDs] of Object.entries(best)) {
      const year = Object.values(byDs).map((v) => v.year).sort().pop()!;
      out[id] = { year, n: Object.values(byDs).filter((v) => v.year === year).reduce((s, v) => s + v.n, 0) };
    }
    return out;
  });

  return rows.filter((r) => r.latitude != null && r.longitude != null).map((r) => {
    const p = pupils[r.identifiant_de_l_etablissement];
    const nature = r.libelle_nature ? titleCase(r.libelle_nature) : r.type_etablissement;
    return {
      id: `uai-${r.identifiant_de_l_etablissement}`, kind: "school" as SiteKind, name: titleCase(r.nom_etablissement),
      capacity: p ? p.n : null, capacity_source: p ? `pupils, school year ${p.year}-${Number(p.year) + 1} (Éducation nationale)` : null,
      lat: +Number(r.latitude).toFixed(6), lon: +Number(r.longitude).toFixed(6), elevation_m: null,
      source: "Annuaire de l'éducation", category: `${nature} · ${r.statut_public_prive}`, ref: r.identifiant_de_l_etablissement,
      address: [r.adresse_1, [r.code_postal, r.nom_commune].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null,
      phone: r.telephone || null,
    };
  });
}

// ---------------------------------------------------------------- FINESS
interface FinessRow {
  nofinesset: string; rs: string; categetab: number; libcategetab: string; com_name: string | null;
  address: string | null; ligneacheminement: string | null; telephone: string | null; coord: { lon: number; lat: number } | null;
}
// residents who cannot leave on their own: elderly homes, disability homes, children with disabilities
const CARE = new Set([500, 202, 255, 437, 448, 449, 252, 382, 183]);
// inpatient care (SMUR bases are excluded below: they are a rescue resource, not a site to evacuate)
const HOSPITAL = new Set([101, 106, 355, 362, 365, 128, 129]);

async function health(): Promise<Site[]> {
  const cats = [...CARE, ...HOSPITAL].join(",");
  const rows = await cachedJson<FinessRow[]>("official/finess_box.json", REFRESH, () => odsAll<FinessRow>(
    ODS_FINESS, `in_bbox(coord, ${MIN_LAT}, ${MIN_LON}, ${MAX_LAT}, ${MAX_LON}) and categetab in (${cats})`,
    "nofinesset,rs,categetab,libcategetab,com_name,address,ligneacheminement,telephone,coord",
  ));
  const out: Site[] = [];
  for (const r of rows) {
    if (!r.coord) continue;
    if (/\bSMUR\b/i.test(r.rs)) { console.log(`[finess] skip ${r.rs} (SMUR base)`); continue; }
    const tel = r.telephone ? r.telephone.replace(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3 $4 $5") : null;
    out.push({
      id: `finess-${r.nofinesset}`, kind: CARE.has(r.categetab) ? "care_home" : "hospital", name: titleCase(r.rs),
      capacity: null, capacity_source: null,
      lat: +r.coord.lat.toFixed(6), lon: +r.coord.lon.toFixed(6), elevation_m: null,
      source: "FINESS", category: r.libcategetab, ref: r.nofinesset,
      address: [r.address ? titleCase(r.address) : null, r.ligneacheminement ? titleCase(r.ligneacheminement) : r.com_name].filter(Boolean).join(", ") || null,
      phone: tel,
    });
  }
  return out;
}

// ---------------------------------------------------------------- IGN elevations
async function ignElevations(points: { id: string; lat: number; lon: number }[]): Promise<Record<string, number>> {
  return cachedJson<Record<string, number>>("official/ign_elevations.json", REFRESH, async () => {
    const out: Record<string, number> = {};
    for (const part of chunks(points, 50)) {
      const url = "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json"
        + `?lon=${part.map((p) => p.lon).join("|")}&lat=${part.map((p) => p.lat).join("|")}&resource=ign_rge_alti_wld&zonly=true`;
      const r = await getJson<{ elevations: number[] }>(url);
      part.forEach((p, i) => { const z = r.elevations[i]; if (z > -1000) out[p.id] = Math.round(z * 100) / 100; });
      await sleep(120);
    }
    return out;
  });
}

// ---------------------------------------------------------------- Géorisques depth class (medium scenario)
interface IsoFeature { properties: { ht_min: string; ht_max: string; cours_deau: string }; geometry: { type: string; coordinates: unknown } }
function depthLabel(min: number, max: number): string {
  if (max >= 999) return `> ${min} m`;
  if (min <= 0) return `< ${max} m`;
  return `${min}–${max} m`;
}

async function depthClasses(sites: Site[], zoneRank: (lat: number, lon: number) => number): Promise<Record<string, string | null>> {
  const cands = sites.filter((s) => zoneRank(s.lat, s.lon) > 0);
  return cachedJson<Record<string, string | null>>("official/georisques_depth_sites.json", REFRESH, async () => {
    const out: Record<string, string | null> = {};
    const work = [...cands];
    const one = async (s: Site) => {
      const d = 0.0003;
      const url = "https://georisques.gouv.fr/services?service=WFS&version=2.0.0&request=GetFeature&typeNames=ms:ISO_HT_01_02MOY_FXX"
        + `&outputFormat=geojson&count=50&bbox=${s.lat - d},${s.lon - d},${s.lat + d},${s.lon + d},urn:ogc:def:crs:EPSG::4326`;
      const fc = await getJson<{ features: IsoFeature[] }>(url, { timeoutMs: 90_000 });
      const hit = fc.features
        .filter((f) => polysOf(f.geometry).some((p) => pointInPoly(s.lon, s.lat, p)))
        .sort((a, b) => Number(b.properties.ht_min) - Number(a.properties.ht_min))[0];
      out[s.id] = hit ? depthLabel(Number(hit.properties.ht_min), Number(hit.properties.ht_max)) : null;
    };
    const workers = Array.from({ length: 4 }, async () => {
      for (let s = work.shift(); s; s = work.shift()) {
        try { await one(s); } catch (e) { console.warn(`[georisques] depth ${s.id} failed: ${(e as Error).message}`); }
      }
    });
    await Promise.all(workers);
    console.log(`[georisques] depth classes for ${Object.keys(out).length}/${cands.length} sites in or near an official zone`);
    return out;
  });
}

// ---------------------------------------------------------------- main
async function main() {
  const osm = readData<Site[]>("data/sites.json") ?? [];
  const campsites = osm.filter((s) => s.kind === "campsite").map((s) => ({ ...s, category: "Campsite", capacity_source: s.capacity != null ? "OSM" : null }));
  const [edu, fin] = [await schools(), await health()];
  const sites: Site[] = [...edu, ...fin, ...campsites];

  // official zone rank per point (flood-zones-grid.json from fetch-official)
  const zg = readData<{ cols: number; rows: number; bbox: [number, number, number, number]; rank: number[] }>("data/flood-zones-grid.json");
  const zoneRank = (lat: number, lon: number) => {
    if (!zg) return 1; // no grid yet: query every site
    const [a, b, c, d] = zg.bbox;
    if (lon < a || lon > c || lat < b || lat > d) return 0;
    const col = Math.min(zg.cols - 1, Math.floor(((lon - a) / (c - a)) * zg.cols));
    const row = Math.min(zg.rows - 1, Math.floor(((d - lat) / (d - b)) * zg.rows));
    // the cell or one of its neighbours (sites at the edge of a zone)
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = row + dr, cc = col + dc;
      if (rr >= 0 && rr < zg.rows && cc >= 0 && cc < zg.cols && zg.rank[rr * zg.cols + cc] > 0) return 1;
    }
    return 0;
  };
  const depth = await depthClasses(sites, zoneRank);

  const personas = readData<{ residents: Resident[] }>("data/personas.json");
  const residents = personas?.residents ?? [];
  const elev = await ignElevations([...sites, ...residents].map((p) => ({ id: p.id, lat: p.lat, lon: p.lon })));

  for (const s of sites) {
    s.elevation_m = elev[s.id] ?? s.elevation_m ?? null;
    s.official_depth = depth[s.id] ?? null;
  }
  const byKind: Record<string, number> = {};
  for (const s of sites) byKind[`${s.kind}/${s.source}`] = (byKind[`${s.kind}/${s.source}`] ?? 0) + 1;
  console.log(`[sites] ${sites.length} sites:`, byKind);
  console.log(`[sites] capacity known for ${sites.filter((s) => s.capacity != null).length}; IGN elevation for ${sites.filter((s) => elev[s.id] != null).length}; 100-yr depth class for ${sites.filter((s) => s.official_depth).length}`);
  for (const s of sites.filter((x) => x.official_depth).slice(0, 12)) console.log(`  ${s.official_depth?.padEnd(8)} ${s.kind.padEnd(9)} ${s.name}`);
  writeData("data/sites-official.json", sites);
  writeData("data/elevations-ign.json", {
    source: "IGN Géoplateforme altimétrie, RGE ALTI (data.geopf.fr)",
    residents: Object.fromEntries(residents.filter((r) => elev[r.id] != null).map((r) => [r.id, elev[r.id]])),
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
