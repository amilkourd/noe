"use client";

import "./ark.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { MapRef } from "@vis.gl/react-maplibre";
import type { DoveCall, Exposure, StatusReport } from "@/lib/types";
import { useNoe } from "./useNoe";
import { residentLevel, type ResidentLevel } from "./format";
import { HOME, type Selection } from "./ArkMap";
import {
  ActionGrid, Brand, CopilotCard, CopilotPill, Drawer, NavTabs, ReplayPill, RescuersCard, ResidentsCard, RiverCard, SearchBox,
  SelectionCard, Title, type Panel, type View,
} from "./panels";

const ArkMap = dynamic(() => import("./ArkMap"), { ssr: false, loading: () => <div className="absolute inset-0 bg-noe-bg" /> });

// Map padding keeps the visible "centre" clear of the floating chrome.
const PAD_CLOSED = { left: 40, right: 40, top: 200, bottom: 210 };
const PAD_DRAWER = { ...PAD_CLOSED, right: 380 };

export default function ArkApp() {
  const { state, conn, error } = useNoe();
  const [selection, setSelection] = useState<Selection>(null);
  const [panel, setPanel] = useState<Panel>("live");
  const [is3d, setIs3d] = useState(true);
  const [showFlood, setShowFlood] = useState(true);
  const [focus, setFocus] = useState(false);
  const mapRef = useRef<MapRef | null>(null);

  // ---- view model
  const v = useMemo<View | null>(() => {
    if (!state) return null;
    const statusBy = new Map<string, StatusReport>(state.statuses.map((s) => [s.resident_id, s]));
    const callBy = new Map<string, DoveCall>();
    for (const c of state.doveCalls) {
      const prev = callBy.get(c.resident_id);
      if (!prev || c.id > prev.id) callBy.set(c.resident_id, c);
    }
    const counts: Record<ResidentLevel, number> = { needs_help: 0, unstable: 0, safe: 0, calling: 0, no_answer: 0, not_called: 0 };
    const levelBy = new Map<string, ResidentLevel>();
    for (const r of state.residents) {
      const l = residentLevel(statusBy.get(r.id), callBy.get(r.id));
      levelBy.set(r.id, l);
      counts[l]++;
    }
    const levels: Record<string, number> = {};
    const latestTs: Record<string, number> = {};
    for (const o of state.observations) {
      const t = Date.parse(o.ts);
      if (!(t < (latestTs[o.station_code] ?? -Infinity))) { latestTs[o.station_code] = t; levels[o.station_code] = o.h_m; }
    }
    return {
      state, levelBy, statusBy, callBy, counts, levels,
      exposureBy: new Map<string, Exposure>(state.exposures.map((x) => [`${x.target_type}:${x.target_id}`, x])),
      residentBy: new Map(state.residents.map((r) => [r.id, r])),
      siteBy: new Map(state.sites.map((s) => [s.id, s])),
      rescuerBy: new Map(state.rescuers.map((r) => [r.id, r])),
      target: state.stations.find((s) => s.role === "target") ?? null,
      activeMissions: state.missions.filter((m) => m.status !== "done"),
    };
  }, [state]);

  const padding = panel === "live" ? PAD_CLOSED : PAD_DRAWER;
  useEffect(() => { mapRef.current?.easeTo({ padding, duration: 400 }); }, [padding]);
  const onReady = useCallback((m: MapRef) => {
    if (mapRef.current === m) return;
    mapRef.current = m;
    m.setPadding(PAD_CLOSED);
  }, []);

  const posOf = useCallback((s: NonNullable<Selection>): { lat: number; lon: number } | null => {
    if (!v) return null;
    if (s.type === "resident") { const r = v.residentBy.get(s.id); return r ? { lat: r.lat, lon: r.lon } : null; }
    if (s.type === "site") { const x = v.siteBy.get(s.id); return x ? { lat: x.lat, lon: x.lon } : null; }
    if (s.type === "rescuer") {
      const r = v.rescuerBy.get(s.id);
      const lat = r?.lat ?? r?.home_lat, lon = r?.lon ?? r?.home_lon;
      return lat != null && lon != null ? { lat, lon } : null;
    }
    const st = v.state.stations.find((x) => x.code === s.id);
    return st ? { lat: st.lat, lon: st.lon } : null;
  }, [v]);

  const select = useCallback((s: Selection) => {
    setSelection(s);
    if (!s) return;
    const p = posOf(s);
    const m = mapRef.current;
    if (p && m) m.flyTo({ center: [p.lon, p.lat], zoom: Math.max(m.getZoom(), 14.6), duration: 900, essential: true });
  }, [posOf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSelection((sel) => { if (!sel) setPanel("live"); return null; });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selPos = selection ? posOf(selection) : null;
  const card = selection && selPos && v
    ? { ...selPos, node: <SelectionCard sel={selection} v={v} onClose={() => setSelection(null)} onSelect={select} /> }
    : null;

  const togglePanel = (p: Panel) => setPanel((cur) => (cur === p ? "live" : p));

  return (
    <div className="ark">
      <ArkMap
        residents={state?.residents ?? EMPTY}
        statuses={state?.statuses ?? EMPTY}
        doveCalls={state?.doveCalls ?? EMPTY}
        rescuers={state?.rescuers ?? EMPTY}
        missions={state?.missions ?? EMPTY}
        sites={state?.sites ?? EMPTY}
        exposures={state?.exposures ?? EMPTY}
        stations={state?.stations ?? EMPTY}
        levels={v?.levels ?? NO_LEVELS}
        flood={state?.flood ?? null}
        perimeter={state?.perimeter ?? null}
        showFlood={showFlood}
        focus={focus}
        selection={selection}
        onSelect={select}
        onReady={onReady}
        card={card}
      />
      <div className="ark-vignette" />

      {/* top bar */}
      <div className="pointer-events-none absolute inset-x-6 top-5 flex items-center gap-4">
        <div className="pointer-events-auto"><Brand conn={conn} /></div>
        <div className="pointer-events-auto mx-auto">
          <NavTabs panel={panel} onPanel={setPanel} counts={{ residents: v ? v.counts.needs_help + v.counts.unstable : 0, missions: v?.activeMissions.length ?? 0 }} />
        </div>
        <div className="pointer-events-auto flex items-start gap-2">
          <ReplayPill v={v} />
          <CopilotPill v={v} active={panel === "copilot"} onPress={() => togglePanel("copilot")} />
        </div>
      </div>

      {/* title */}
      <div className="absolute left-6 top-[104px]">
        <Title v={v} conn={conn} error={error} />
      </div>

      {/* lists on demand */}
      {v && panel !== "live" && (
        <div className="pointer-events-none absolute bottom-[200px] right-6 top-[84px] flex">
          <Drawer panel={panel} v={v} onClose={() => setPanel("live")} onSelect={select} />
        </div>
      )}

      {/* bottom: search + actions, then the cards */}
      <div className="pointer-events-none absolute inset-x-6 bottom-6 flex items-end gap-3">
        <div className="pointer-events-auto flex w-[296px] flex-none flex-col gap-2">
          <SearchBox v={v} onSelect={select} />
          <ActionGrid
            is3d={is3d} showFlood={showFlood} focus={focus}
            onHome={() => { setSelection(null); mapRef.current?.flyTo({ center: [HOME.longitude, HOME.latitude], zoom: HOME.zoom, pitch: is3d ? HOME.pitch : 0, bearing: is3d ? HOME.bearing : 0, duration: 1200 }); }}
            on3d={() => { const next = !is3d; setIs3d(next); mapRef.current?.easeTo({ pitch: next ? HOME.pitch : 0, bearing: next ? HOME.bearing : 0, duration: 700 }); }}
            onFlood={() => setShowFlood((x) => !x)}
            onFocus={() => setFocus((x) => !x)}
          />
        </div>
        {v ? (
          <div className="pointer-events-auto flex min-w-0 flex-1 items-stretch gap-3">
            <ResidentsCard v={v} onOpen={() => togglePanel("residents")} />
            <RiverCard v={v} onOpen={() => v.target && select({ type: "station", id: v.target.code })} />
            <CopilotCard v={v} onOpen={() => togglePanel("copilot")} onSelect={select} />
            <RescuersCard v={v} onOpen={() => togglePanel("rescuers")} />
          </div>
        ) : (
          <div className="ark-glass ark-card pointer-events-auto justify-center text-sm text-noe-muted">
            {conn === "no_db" ? "NOÉ has no database: set DATABASE_URL and run npm run db:seed." : error ?? "Loading the situation…"}
          </div>
        )}
      </div>
    </div>
  );
}

const EMPTY: never[] = [];
const NO_LEVELS: Record<string, number> = {};
