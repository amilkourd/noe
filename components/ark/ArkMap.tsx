"use client";

// ARK map: MapLibre GL + IGN orthophotos (darkened) + Mapterhorn 3D terrain, with the NOÉ flood grid,
// river, roads, perimeter, missions and live markers on top. Loaded with ssr:false (WebGL only).
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Map, Marker, Source, Layer, AttributionControl, type MapRef, type MapLayerMouseEvent } from "@vis.gl/react-maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import type { DoveCall, Exposure, FloodState, Mission, Rescuer, Resident, Site, Station, StatusReport } from "@/lib/types";
import { residentLevel, stationShort, LEVEL_RANK, type ResidentLevel } from "./format";

// The worker URL must be set before the first map is created (MapLibre v6 + Turbopack).
const mapLib = import("maplibre-gl").then((m) => {
  m.setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString());
  return m;
});

const BOUNDS: [number, number, number, number] = [3.8, 43.55, 4.38, 44.0];

export const HOME = { longitude: 4.089, latitude: 43.784, zoom: 13.1, pitch: 58, bearing: -18 };

const IGN_ORTHO =
  "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS" +
  "&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}";
const DEM = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";

const STYLE = {
  version: 8 as const,
  sources: {
    ortho: {
      type: "raster" as const, tiles: [IGN_ORTHO], tileSize: 256, maxzoom: 19,
      attribution: "Orthophotos © IGN BD ORTHO® (Licence Ouverte 2.0)",
    },
    dem: {
      type: "raster-dem" as const, tiles: [DEM], tileSize: 512, maxzoom: 15, encoding: "terrarium" as const,
      attribution: "Terrain © <a href=\"https://mapterhorn.com/attribution\" target=\"_blank\">Mapterhorn</a>",
    },
    hill: { type: "raster-dem" as const, tiles: [DEM], tileSize: 512, maxzoom: 15, encoding: "terrarium" as const },
  },
  layers: [
    { id: "bg", type: "background" as const, paint: { "background-color": "#0b0d10" } },
    {
      id: "ortho", type: "raster" as const, source: "ortho",
      paint: { "raster-saturation": -0.05, "raster-brightness-max": 0.78, "raster-contrast": 0.18, "raster-fade-duration": 200 },
    },
    {
      id: "hillshade", type: "hillshade" as const, source: "hill",
      paint: {
        "hillshade-shadow-color": "#000000",
        "hillshade-highlight-color": "rgba(255,255,255,0.10)",
        "hillshade-accent-color": "#000000",
        "hillshade-exaggeration": 0.35,
      },
    },
    // invisible slots fix the draw order whatever order the React layers mount in:
    // flood < roads/river/perimeter < sites/missions
    { id: "flood-slot", type: "background" as const, layout: { visibility: "none" as const } },
    { id: "overlay-slot", type: "background" as const, layout: { visibility: "none" as const } },
  ],
  sky: {
    "sky-color": "#06080c",
    "horizon-color": "#1a222e",
    "fog-color": "#0b0f15",
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.7,
    "fog-ground-blend": 0.35,
    "atmosphere-blend": 0,
  },
  terrain: { source: "dem", exaggeration: 1.6 },
};

// ---------------------------------------------------------------- terrain payload (/api/terrain)
interface TerrainPayload {
  grid: { bbox: [number, number, number, number]; cols: number; rows: number };
  roads: { id: string; highway: string; coords: [number, number][] }[];
  river: [number, number][];
}
const MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);

// Flood palette (shallow -> deep), matches --noe-water-1..4
const WATER: [number, number, number][] = [[30, 90, 138], [59, 158, 219], [125, 211, 252], [186, 230, 253]];

function floodImage(flood: FloodState, cols: number, rows: number): string | null {
  if (typeof document === "undefined" || !flood.cells.length) return null;
  const c = document.createElement("canvas");
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(cols, rows);
  flood.cells.forEach((cell, k) => {
    const d = flood.depths[k] ?? 0;
    const [r, g, b] = WATER[d < 0.3 ? 0 : d < 0.8 ? 1 : d < 1.5 ? 2 : 3];
    const o = cell * 4;
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b;
    img.data[o + 3] = Math.round(255 * Math.min(0.9, 0.45 + d * 0.3));
  });
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

function circlePolygon(lon: number, lat: number, km: number): GeoJSON.Feature<GeoJSON.Polygon> {
  const pts: [number, number][] = [];
  const dLat = km / 111.32, dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    pts.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [pts] } };
}

// ---------------------------------------------------------------- markers

export type Selection = { type: "resident" | "site" | "rescuer" | "station"; id: string } | null;

const ResidentPin = memo(function ResidentPin({ level, selected }: { level: ResidentLevel; selected: boolean }) {
  return (
    <span className={`ark-pin ark-pin--${level}${selected ? " is-selected" : ""}`} aria-hidden>
      {level === "needs_help" || level === "unstable" ? (
        <svg viewBox="0 0 24 22" width="20" height="18"><path d="M12 2 L22.5 20 H1.5 Z" /></svg>
      ) : (
        <i />
      )}
    </span>
  );
});

function RescuerPin({ r, busy, selected }: { r: Rescuer; busy: boolean; selected: boolean }) {
  return (
    <span className={`ark-rescuer${r.available ? "" : " is-off"}${busy ? " is-busy" : ""}${selected ? " is-selected" : ""}`}>
      {r.tier}
    </span>
  );
}

// ---------------------------------------------------------------- map

export interface ArkMapProps {
  residents: Resident[];
  statuses: StatusReport[];
  doveCalls: DoveCall[];
  rescuers: Rescuer[];
  missions: Mission[];
  sites: Site[];
  exposures: Exposure[];
  stations: Station[];
  levels: Record<string, number>; // latest gauge level per station
  flood: FloodState | null;
  perimeter: { active: boolean; center: { lat: number; lon: number }; radiusKm: number } | null;
  showFlood: boolean;
  focus: boolean; // only residents that need attention
  selection: Selection;
  onSelect: (s: Selection) => void;
  onReady: (m: MapRef) => void;
  card: { lat: number; lon: number; node: ReactNode } | null;
}

export default function ArkMap(p: ArkMapProps) {
  const [terrain, setTerrain] = useState<TerrainPayload | null>(null);
  // client-only component (ssr:false), so the DOM is available here
  const [webgl] = useState(() => !!document.createElement("canvas").getContext("webgl2"));

  useEffect(() => {
    if (!webgl) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = 2000;
    const get = async () => {
      try {
        const r = await fetch("/api/terrain");
        if (!r.ok) throw new Error(String(r.status));
        const t = (await r.json()) as TerrainPayload;
        if (alive) setTerrain(t);
      } catch {
        if (!alive) return;
        timer = setTimeout(get, delay); // flood, roads and river all depend on it: keep trying
        delay = Math.min(30_000, delay * 2);
      }
    };
    void get();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [webgl]);

  // ---- static overlays from /api/terrain
  const river = useMemo<GeoJSON.Feature<GeoJSON.LineString> | null>(
    () => (terrain ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: terrain.river } } : null),
    [terrain],
  );
  const roads = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!terrain) return null;
    return {
      type: "FeatureCollection",
      features: terrain.roads
        .filter((r) => MAJOR.has(r.highway))
        .map((r) => ({ type: "Feature", properties: { major: r.highway !== "tertiary" }, geometry: { type: "LineString", coordinates: r.coords } })),
    };
  }, [terrain]);

  // ---- flood image (re-drawn on each 15 sim-min pipeline pass)
  const flood = useMemo(() => {
    if (!terrain || !p.flood) return null;
    const url = floodImage(p.flood, terrain.grid.cols, terrain.grid.rows);
    if (!url) return null;
    const [minLon, minLat, maxLon, maxLat] = terrain.grid.bbox;
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] =
      [[minLon, maxLat], [maxLon, maxLat], [maxLon, minLat], [minLon, minLat]];
    return { url, coordinates };
  }, [terrain, p.flood]);

  // ---- sites (GL layer: 160 points, exposed ones glow)
  const exposedIds = useMemo(() => new Set(p.exposures.map((x) => `${x.target_type}:${x.target_id}`)), [p.exposures]);
  const sites = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: "FeatureCollection",
    features: p.sites.map((s) => ({
      type: "Feature",
      properties: { id: s.id, exposed: exposedIds.has(`site:${s.id}`), selected: p.selection?.type === "site" && p.selection.id === s.id },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    })),
  }), [p.sites, exposedIds, p.selection]);

  // ---- missions: dashed line rescuer -> target
  const missionLines = useMemo<GeoJSON.FeatureCollection>(() => {
    const byId = new globalThis.Map(p.rescuers.map((r) => [r.id, r]));
    const res = new globalThis.Map(p.residents.map((r) => [r.id, r]));
    const st = new globalThis.Map(p.sites.map((s) => [s.id, s]));
    const features: GeoJSON.Feature[] = [];
    for (const m of p.missions) {
      if (m.status === "done") continue;
      const r = byId.get(m.rescuer_id);
      const t = m.target_type === "resident" ? res.get(m.target_id) : st.get(m.target_id);
      const rl = r?.lat ?? r?.home_lat, ro = r?.lon ?? r?.home_lon;
      if (!t || rl == null || ro == null) continue;
      features.push({ type: "Feature", properties: { id: m.id }, geometry: { type: "LineString", coordinates: [[ro, rl], [t.lon, t.lat]] } });
    }
    return { type: "FeatureCollection", features };
  }, [p.missions, p.rescuers, p.residents, p.sites]);

  const perimeter = useMemo(
    () => (p.perimeter?.active ? circlePolygon(p.perimeter.center.lon, p.perimeter.center.lat, p.perimeter.radiusKm) : null),
    [p.perimeter],
  );

  // ---- resident markers (memoised: the clock ticks every second, markers only change with reports/calls/selection)
  const selResident = p.selection?.type === "resident" ? p.selection.id : null;
  const residentMarkers = useMemo(() => {
    const status = new globalThis.Map(p.statuses.map((s) => [s.resident_id, s]));
    const call = new globalThis.Map<string, DoveCall>();
    for (const c of p.doveCalls) {
      const prev = call.get(c.resident_id);
      if (!prev || c.id > prev.id) call.set(c.resident_id, c);
    }
    return p.residents
      .map((r) => ({ r, level: residentLevel(status.get(r.id), call.get(r.id)) }))
      .filter(({ r, level }) => !p.focus || LEVEL_RANK[level] <= LEVEL_RANK.no_answer || r.id === selResident)
      .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]) // urgent last = drawn on top
      .map(({ r, level }) => (
        <Marker
          key={r.id}
          longitude={r.lon}
          latitude={r.lat}
          style={{ zIndex: 10 - LEVEL_RANK[level] }}
          onClick={(e) => { e.originalEvent.stopPropagation(); p.onSelect({ type: "resident", id: r.id }); }}
        >
          <ResidentPin level={level} selected={selResident === r.id} />
        </Marker>
      ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.residents, p.statuses, p.doveCalls, p.focus, selResident]);

  const busy = useMemo(() => new Set(p.missions.filter((m) => m.status !== "done").map((m) => m.rescuer_id)), [p.missions]);

  if (!webgl) {
    return (
      <div className="absolute inset-0 grid place-items-center bg-noe-bg text-noe-muted text-sm">
        This browser has no WebGL2: the 3D map cannot start.
      </div>
    );
  }
  return (
    <Map
      mapLib={mapLib}
      ref={(m) => { if (m) p.onReady(m); }}
      initialViewState={HOME}
      mapStyle={STYLE}
      maxPitch={75}
      maxBounds={BOUNDS}
      attributionControl={false}
      interactiveLayerIds={["sites-dot"]}
      onClick={(e: MapLayerMouseEvent) => {
        if ((e.originalEvent.target as HTMLElement | null)?.closest?.(".maplibregl-marker")) return;
        const f = e.features?.[0];
        p.onSelect(f?.properties?.id ? { type: "site", id: String(f.properties.id) } : null);
      }}
      onMouseEnter={(e) => { e.target.getCanvas().style.cursor = "pointer"; }}
      onMouseLeave={(e) => { e.target.getCanvas().style.cursor = ""; }}
      style={{ position: "absolute", inset: 0, isolation: "isolate" }}
    >
      <AttributionControl compact position="bottom-right" />

      {flood && (
        <Source id="flood" type="image" url={flood.url} coordinates={flood.coordinates}>
          <Layer
            id="flood"
            beforeId="flood-slot"
            type="raster"
            layout={{ visibility: p.showFlood ? "visible" : "none" }}
            paint={{ "raster-opacity": 0.85, "raster-fade-duration": 0, "raster-resampling": "linear" }}
          />
        </Source>
      )}

      {roads && (
        <Source id="roads" type="geojson" data={roads}>
          <Layer
            id="roads"
            beforeId="overlay-slot"
            type="line"
            layout={{ "line-cap": "round", "line-join": "round" }}
            paint={{
              "line-color": "#ffffff",
              "line-opacity": ["case", ["get", "major"], 0.42, 0.22],
              "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.4, 15, ["case", ["get", "major"], 1.6, 1]],
            }}
          />
        </Source>
      )}

      {river && (
        <Source id="river" type="geojson" data={river}>
          <Layer id="river-glow" beforeId="overlay-slot" type="line" layout={{ "line-cap": "round", "line-join": "round" }}
            paint={{ "line-color": "#7DD3FC", "line-opacity": 0.35, "line-width": 10, "line-blur": 8 }} />
          <Layer id="river-core" beforeId="overlay-slot" type="line" layout={{ "line-cap": "round", "line-join": "round" }}
            paint={{ "line-color": "#BAE6FD", "line-opacity": 0.9, "line-width": 1.4 }} />
        </Source>
      )}

      {perimeter && (
        <Source id="perimeter" type="geojson" data={perimeter}>
          <Layer id="perimeter-line" beforeId="overlay-slot" type="line"
            paint={{ "line-color": "#ffffff", "line-opacity": 0.4, "line-width": 1, "line-dasharray": [3, 3] }} />
        </Source>
      )}

      <Source id="missions" type="geojson" data={missionLines}>
        <Layer id="mission-glow" type="line" layout={{ "line-cap": "round" }}
          paint={{ "line-color": "#ffffff", "line-opacity": 0.25, "line-width": 6, "line-blur": 5 }} />
        <Layer id="mission-line" type="line" layout={{ "line-cap": "round" }}
          paint={{ "line-color": "#ffffff", "line-opacity": 0.95, "line-width": 1.5, "line-dasharray": [2, 2] }} />
      </Source>

      <Source id="sites" type="geojson" data={sites}>
        <Layer id="sites-glow" type="circle" filter={["==", ["get", "exposed"], true]}
          paint={{ "circle-radius": 12, "circle-color": "#FF9F43", "circle-opacity": 0.35, "circle-blur": 1 }} />
        <Layer id="sites-dot" type="circle"
          paint={{
            "circle-radius": ["case", ["get", "selected"], 6, ["get", "exposed"], 4.5, 3],
            "circle-color": ["case", ["get", "exposed"], "#FF9F43", "#0E0F11"],
            "circle-stroke-color": ["case", ["get", "exposed"], "#FFD9B3", "rgba(255,255,255,0.55)"],
            "circle-stroke-width": ["case", ["get", "selected"], 2, 1],
            "circle-pitch-alignment": "map",
          }} />
      </Source>

      {p.stations.map((s) => (
        <Marker key={s.code} longitude={s.lon} latitude={s.lat} anchor="bottom"
          onClick={(e) => { e.originalEvent.stopPropagation(); p.onSelect({ type: "station", id: s.code }); }}>
          <span className={`ark-gauge${s.role === "target" ? " is-target" : ""}`}>
            <b>{stationShort(s.name)}</b>
            {p.levels[s.code] != null && <em className="tabular">{p.levels[s.code].toFixed(2)} m</em>}
          </span>
        </Marker>
      ))}

      {residentMarkers}

      {p.rescuers.map((r) => {
        const lat = r.lat ?? r.home_lat, lon = r.lon ?? r.home_lon;
        if (lat == null || lon == null) return null;
        return (
          <Marker key={r.id} longitude={lon} latitude={lat} style={{ zIndex: 20 }}
            onClick={(e) => { e.originalEvent.stopPropagation(); p.onSelect({ type: "rescuer", id: r.id }); }}>
            <RescuerPin r={r} busy={busy.has(r.id)} selected={p.selection?.type === "rescuer" && p.selection.id === r.id} />
          </Marker>
        );
      })}

      {p.card && (
        <Marker longitude={p.card.lon} latitude={p.card.lat} anchor="bottom-left" offset={[18, -18]} style={{ zIndex: 40 }}>
          {p.card.node}
        </Marker>
      )}
    </Map>
  );
}
