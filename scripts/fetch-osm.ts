// Fetch OSM features (sites, Vidourle river, main roads, residential landuse, named streets) via Overpass.
// Idempotent: caches the raw response in data/raw/osm.json (use --refresh to refetch).
// Run: npx tsx scripts/fetch-osm.ts
import fs from "node:fs";
import path from "node:path";
import type { Site, SiteKind } from "../lib/types";

const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "data/raw/osm.json");
const OUT = path.join(ROOT, "data");
const B = "43.64,3.95,43.93,4.22";

const QUERY = `[out:json][timeout:90];
(
  nwr["amenity"="nursing_home"](${B});
  nwr["social_facility"="nursing_home"](${B});
  nwr["amenity"="school"](${B});
  nwr["tourism"="camp_site"](${B});
  nwr["amenity"="hospital"](${B});
  way["waterway"="river"]["name"~"Vidourle"](${B});
  way["highway"~"^(primary|secondary|tertiary)$"](${B});
  way["landuse"="residential"](${B});
  way["highway"~"^(residential|unclassified|living_street)$"]["name"](${B});
);
out geom;`;

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

interface OsmEl {
  type: "node" | "way" | "relation"; id: number; lat?: number; lon?: number;
  center?: { lat: number; lon: number };
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; ref: number; role: string; geometry?: { lat: number; lon: number }[] }[];
  tags?: Record<string, string>;
}

async function fetchOverpass(): Promise<{ elements: OsmEl[] }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        console.log(`[osm] POST ${url} (attempt ${attempt + 1})`);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 95_000);
        const res = await fetch(url, {
          method: "POST",
          body: "data=" + encodeURIComponent(QUERY),
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "noe-hackathon-demo/0.1" },
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { elements: OsmEl[] };
        if (!json.elements?.length) throw new Error("empty response");
        return json;
      } catch (e) {
        lastErr = e;
        console.warn(`[osm] failed: ${(e as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw lastErr;
}

function centroid(el: OsmEl): { lat: number; lon: number } | null {
  if (el.type === "node" && el.lat != null && el.lon != null) return { lat: el.lat, lon: el.lon };
  const pts: { lat: number; lon: number }[] = [];
  if (el.geometry) pts.push(...el.geometry);
  if (el.members) for (const m of el.members) if (m.geometry) pts.push(...m.geometry);
  if (pts.length) {
    const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
    return { lat, lon };
  }
  if (el.bounds) return { lat: (el.bounds.minlat + el.bounds.maxlat) / 2, lon: (el.bounds.minlon + el.bounds.maxlon) / 2 };
  if (el.center) return el.center;
  return null;
}

function siteKind(t: Record<string, string>): SiteKind | null {
  if (t.amenity === "nursing_home" || t.social_facility === "nursing_home") return "care_home";
  if (t.amenity === "hospital") return "hospital";
  if (t.amenity === "school") return "school";
  if (t.tourism === "camp_site") return "campsite";
  return null;
}

function numericCap(v: string | undefined): number | null {
  if (!v) return null;
  return /^\s*\d+\s*$/.test(v) ? parseInt(v, 10) : null;
}

const d2 = (a: [number, number], b: [number, number]) => {
  const kx = Math.cos((43.8 * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * kx, a[1] - b[1]);
};

// Merge way segments into ordered polylines by endpoint chaining, then orient north->south.
function mergeSegments(segs: [number, number][][]): [number, number][][] {
  const pool = segs.map((s) => s.slice());
  const chains: [number, number][][] = [];
  const EPS = 1e-6;
  while (pool.length) {
    let chain = pool.shift()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        const head = chain[0], tail = chain[chain.length - 1];
        const sh = s[0], st = s[s.length - 1];
        if (d2(tail, sh) < EPS) chain = chain.concat(s.slice(1));
        else if (d2(tail, st) < EPS) chain = chain.concat(s.slice().reverse().slice(1));
        else if (d2(head, st) < EPS) chain = s.concat(chain.slice(1));
        else if (d2(head, sh) < EPS) chain = s.slice().reverse().concat(chain.slice(1));
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    chains.push(chain);
  }
  // orient each chain north -> south
  for (const c of chains) if (c[0][1] < c[c.length - 1][1]) c.reverse();
  chains.sort((a, b) => b.length - a.length);
  return chains;
}

// Greedy join of chains (allowing small gaps) into one N->S polyline.
function joinChains(chains: [number, number][][]): [number, number][] {
  if (!chains.length) return [];
  const remaining = chains.slice().sort((a, b) => b[0][1] - a[0][1]); // northernmost start first
  let line = remaining.shift()!;
  while (remaining.length) {
    const tail = line[line.length - 1];
    let best = -1, bestD = Infinity, rev = false;
    remaining.forEach((c, i) => {
      const dh = d2(tail, c[0]), dt = d2(tail, c[c.length - 1]);
      if (dh < bestD) { bestD = dh; best = i; rev = false; }
      if (dt < bestD) { bestD = dt; best = i; rev = true; }
    });
    // gap in degrees (~ 0.02 deg ~ 2 km): stop joining unrelated branches (e.g. side channels far away)
    if (bestD > 0.03) break;
    const c = remaining.splice(best, 1)[0];
    line = line.concat(rev ? c.slice().reverse() : c);
  }
  return line;
}

async function main() {
  const refresh = process.argv.includes("--refresh");
  let raw: { elements: OsmEl[] };
  if (!refresh && fs.existsSync(RAW)) {
    raw = JSON.parse(fs.readFileSync(RAW, "utf8"));
    console.log(`[osm] using cached ${RAW} (${raw.elements.length} elements)`);
  } else {
    raw = await fetchOverpass();
    fs.writeFileSync(RAW, JSON.stringify(raw));
    console.log(`[osm] saved ${raw.elements.length} elements to ${RAW}`);
  }

  const sites: Site[] = [];
  const seenSite = new Set<string>();
  const riverSegs: [number, number][][] = [];
  const roads: { id: string; ref: string | null; name: string | null; highway: string; coords: [number, number][] }[] = [];
  const landuse: [number, number][][] = [];
  const streets: { id: string; name: string; highway: string; coords: [number, number][] }[] = [];

  for (const el of raw.elements) {
    const t = el.tags ?? {};
    const kind = siteKind(t);
    if (kind) {
      if (!t.name) continue;
      const c = centroid(el);
      if (!c) continue;
      const key = `${kind}|${t.name}`;
      // de-duplicate the same facility mapped as both node and way
      const dup = sites.find((s) => s.kind === kind && s.name === t.name && Math.abs(s.lat - c.lat) < 0.003 && Math.abs(s.lon - c.lon) < 0.003);
      if (dup || seenSite.has(`osm-${el.type}-${el.id}`)) continue;
      seenSite.add(`osm-${el.type}-${el.id}`);
      void key;
      sites.push({
        id: `osm-${el.type}-${el.id}`, kind, name: t.name,
        capacity: numericCap(t.capacity) ?? numericCap(t.beds),
        lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6), elevation_m: null, source: "OSM",
      });
      continue;
    }
    if (el.type !== "way" || !el.geometry) continue;
    const coords = el.geometry.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)] as [number, number]);
    if (t.waterway === "river" && /Vidourle/.test(t.name ?? "")) { riverSegs.push(coords); continue; }
    if (t.highway && /^(primary|secondary|tertiary)$/.test(t.highway)) {
      roads.push({ id: `osm-way-${el.id}`, ref: t.ref ?? null, name: t.name ?? null, highway: t.highway, coords });
      continue;
    }
    if (t.landuse === "residential") { landuse.push(coords); continue; }
    if (t.highway && t.name) streets.push({ id: `osm-way-${el.id}`, name: t.name, highway: t.highway, coords });
  }

  const chains = mergeSegments(riverSegs);
  const river = joinChains(chains);

  fs.writeFileSync(path.join(OUT, "sites.json"), JSON.stringify(sites, null, 1));
  fs.writeFileSync(path.join(OUT, "roads.json"), JSON.stringify(roads));
  fs.writeFileSync(path.join(OUT, "river.json"), JSON.stringify(river));
  fs.writeFileSync(path.join(OUT, "river-segments.json"), JSON.stringify(chains));
  fs.writeFileSync(path.join(ROOT, "data/raw/landuse.json"), JSON.stringify(landuse));
  fs.writeFileSync(path.join(ROOT, "data/raw/streets.json"), JSON.stringify(streets));

  const byKind: Record<string, string[]> = {};
  for (const s of sites) (byKind[s.kind] ??= []).push(s.name);
  console.log(`[osm] sites: ${sites.length}`, Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length])));
  console.log(`[osm] care homes: ${(byKind.care_home ?? []).join(" | ")}`);
  console.log(`[osm] river: ${riverSegs.length} ways -> ${chains.length} chains -> main polyline ${river.length} vertices (N ${river[0]?.[1]} -> S ${river[river.length - 1]?.[1]})`);
  const refs = [...new Set(roads.map((r) => r.ref).filter(Boolean))].sort();
  console.log(`[osm] roads: ${roads.length} ways, refs: ${refs.join(", ")}`);
  console.log(`[osm] residential landuse polygons: ${landuse.length}, named streets: ${streets.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
