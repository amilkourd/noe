"use client";

// ARK chrome, Urbis-style: the map is the screen. Small glass pieces float on it; lists open on demand.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, ScrollShadow, Tabs, ToggleButton, ToggleButtonGroup, Tooltip } from "@heroui/react";
import type { AgentLog, Exposure, Forecast, Insight, MissionStatus, NoeState, Observation, Rescuer, Resident, Station, StatusReport, DoveCall, Mission, Site } from "@/lib/types";
import { hhmm, day, minutesUntil, relMinutes, shortName, missionNumber, splitNum, mobilityLabel, stationShort, LEVEL_LABEL, LEVEL_RANK, type ResidentLevel } from "./format";
import { sendMission, setInsight, replay, type ActionResult, type Conn } from "./useNoe";
import {
  ArkMark, ArrowUpRightIcon, CloseIcon, CubeIcon, LocateIcon, PauseIcon, PhoneIcon, PlayIcon, ResetIcon, SparkIcon, TriangleGlyph, WavesIcon,
} from "./icons";
import type { Selection } from "./ArkMap";

// ---------------------------------------------------------------- view model

export interface View {
  state: NoeState;
  levelBy: Map<string, ResidentLevel>;
  statusBy: Map<string, StatusReport>;
  callBy: Map<string, DoveCall>;
  exposureBy: Map<string, Exposure>;
  residentBy: Map<string, Resident>;
  siteBy: Map<string, Site>;
  rescuerBy: Map<string, Rescuer>;
  levels: Record<string, number>;
  target: Station | null;
  counts: Record<ResidentLevel, number>;
  activeMissions: Mission[];
}

export type Panel = "live" | "residents" | "rescuers" | "missions" | "activity" | "copilot";

const KIND_LABEL: Record<Insight["kind"], string> = {
  assignment: "Assignment", forecast: "Forecast", site: "Site", route: "Route", resource: "Resource",
};
const STEPS: MissionStatus[] = ["sent", "accepted", "en_route", "on_site", "done"];
const STEP_LABEL: Record<MissionStatus, string> = {
  sent: "Sent", accepted: "Accepted", en_route: "En route", on_site: "On site", done: "Done", backup: "Backup asked",
};

/** Water at a target from the latest exposure: eta == pipeline time when already wet (lib/replay.ts); depth is the 6 h peak. */
function waterText(ex: Exposure | undefined, s: NoeState): string {
  const simTime = s.clock.simTime;
  if (!ex) return s.latestForecast ? "Dry in the 6 h model" : "No flood model yet";
  const depth = ex.depth_m != null ? ` · up to ${ex.depth_m.toFixed(1)} m` : "";
  if (ex.eta && Date.parse(ex.eta) > Date.parse(simTime)) return `≈ ${hhmm(ex.eta)} · ${relMinutes(minutesUntil(ex.eta, simTime))}${depth}`;
  return `Wet now${depth}`;
}

/** What the resident actually said (lib/sim.ts writes "simulated persona" as an internal marker). */
function said(st: StatusReport | undefined): string | null {
  const n = st?.notes?.trim();
  return n && n !== "simulated persona" ? n : null;
}

function residentSub(r: Resident, st: StatusReport | undefined): string {
  const n = said(st);
  return `${mobilityLabel(r)}${st?.can_climb_stairs === false ? " · can't climb stairs" : ""}${n ? ` · “${n}”` : ""}`;
}

// ---------------------------------------------------------------- small pieces

export function LevelGlyph({ level }: { level: ResidentLevel }) {
  switch (level) {
    case "needs_help": return <TriangleGlyph className="text-noe-danger ark-blink" />;
    case "unstable": return <TriangleGlyph className="text-[var(--ark-caution)] ark-blink" />;
    case "safe": return <span className="ark-dot text-[var(--ark-caution)]" />;
    case "calling": return <span className="ark-dot text-white ark-live" />;
    case "no_answer": return <span className="inline-block size-2 flex-none rounded-full border border-white/80" />;
    default: return <span className="inline-block size-1.5 flex-none rounded-full bg-white/50" />;
  }
}

function Big({ value, digits = 0, unit, className = "" }: { value: number; digits?: number; unit?: string; className?: string }) {
  const [a, b] = splitNum(value, digits);
  return (
    <span className={`ark-big tabular ${className}`}>
      {a}<span className="ark-dim">{b}</span>
      {unit && <span className="ark-dim ml-1 text-[0.42em] tracking-normal">{unit}</span>}
    </span>
  );
}

function CardHead({ label, onOpen, extra }: { label: string; onOpen?: () => void; extra?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="ark-cap">{label}</span>
      <span className="ml-auto flex items-center gap-2">
        {extra}
        {onOpen && (
          <button onClick={onOpen} aria-label={`Open ${label.toLowerCase()}`} className="text-white/60 transition-colors hover:text-white">
            <ArrowUpRightIcon size={14} />
          </button>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- top bar

export function Brand({ conn }: { conn: Conn }) {
  return (
    <div className="flex items-center gap-3">
      <span className="relative grid size-11 place-items-center rounded-full bg-white text-noe-bg shadow-[0_8px_30px_-8px_rgba(255,255,255,0.5)]">
        <ArkMark />
        <span className={`absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-noe-bg ${conn === "live" ? "bg-noe-land" : conn === "connecting" ? "bg-white/60" : "bg-noe-danger"}`} />
      </span>
      <span className="text-[15px] tracking-wide">ARK</span>
    </div>
  );
}

export function NavTabs({ panel, onPanel, counts }: { panel: Panel; onPanel: (p: Panel) => void; counts: Partial<Record<Panel, number>> }) {
  const items: [Panel, string][] = [["live", "Live"], ["residents", "Residents"], ["rescuers", "Rescuers"], ["missions", "Missions"], ["activity", "Activity"]];
  return (
    <Tabs className="ark-nav" selectedKey={panel === "copilot" ? "live" : panel} onSelectionChange={(k) => onPanel(String(k) as Panel)}>
      <Tabs.ListContainer>
        <Tabs.List aria-label="ARK views">
          {items.map(([id, label]) => (
            <Tabs.Tab key={id} id={id}>
              {label}
              {counts[id] ? <span className="ml-1.5 tabular opacity-60">{counts[id]}</span> : null}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}

export function ReplayPill({ v }: { v: View | null }) {
  const clock = v?.state.clock;
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const armedAt = useRef(0);
  const disarm = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (disarm.current) clearTimeout(disarm.current);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const finished = !!clock && !clock.running && Date.parse(clock.simTime) >= Date.parse(clock.end);
  const speeds = useMemo(() => [...new Set([10, 60, 300, ...(clock ? [clock.speed] : [])])].sort((a, b) => a - b), [clock]);

  const run = async (fn: () => Promise<ActionResult>): Promise<boolean> => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    setErr(r.ok ? null : r.message ?? "Failed");
    return r.ok;
  };
  const pressReset = () => {
    if (!armed) {
      armedAt.current = Date.now();
      setArmed(true);
      if (disarm.current) clearTimeout(disarm.current);
      disarm.current = setTimeout(() => setArmed(false), 3500);
      return;
    }
    if (Date.now() - armedAt.current < 500) return; // a double-click must not confirm a wipe
    if (disarm.current) clearTimeout(disarm.current);
    setArmed(false);
    void run(() => replay("reset")).then((ok) => {
      if (!ok) return;
      // reset sets every rescuer off duty (lib/replay.ts): RAVEN gets no mission until Karim is back on duty
      setNotice("Flood reset · rescuers off duty: put RAVEN back on duty");
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(null), 8000);
    });
  };
  const resetHelp = `Restart the flood from ${clock ? `${day(clock.start)} ${hhmm(clock.start)}` : "the start"}: wipes missions, insights, DOVE calls and the agent log; all rescuers go off duty`;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="ark-float ark-pill flex items-center gap-1 p-1">
        <Tooltip delay={300}>
          <Tooltip.Trigger>
            <Button isIconOnly size="sm" aria-label={clock?.running ? "Pause replay" : finished ? "Replay finished" : "Start replay"}
              className="ark-solid !size-8 !min-w-8" isDisabled={!clock || busy || finished}
              onPress={() => run(() => replay(clock?.running ? "pause" : "start"))}>
              {clock?.running ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>{finished ? "Replay finished: reset to run it again" : clock?.running ? "Pause replay" : "Start replay"}</Tooltip.Content>
        </Tooltip>
        <ToggleButtonGroup size="sm" selectionMode="single" disallowEmptySelection aria-label="Replay speed"
          selectedKeys={clock ? [String(clock.speed)] : []} isDisabled={!clock || busy}
          onSelectionChange={(keys) => { const k = [...keys][0]; if (k != null) void run(() => replay("speed", Number(k))); }}>
          {speeds.map((s) => <ToggleButton key={s} id={String(s)} className="tabular !h-8 !px-2.5">×{s}</ToggleButton>)}
        </ToggleButtonGroup>
        {armed ? (
          <Button size="sm" variant="danger" className="!h-8 rounded-full px-3" isDisabled={!clock || busy} onPress={pressReset}>
            Wipe & reset
          </Button>
        ) : (
          <Tooltip delay={300}>
            <Tooltip.Trigger>
              <Button size="sm" variant="tertiary" isDisabled={!clock || busy} onPress={pressReset}
                className={`!h-8 gap-1.5 rounded-full px-3 ${finished ? "ark-solid" : "ark-pill !border-0 !bg-transparent hover:!bg-white/10"}`}>
                <ResetIcon size={14} />Reset flood
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content className="max-w-[260px]">{resetHelp}</Tooltip.Content>
          </Tooltip>
        )}
      </div>
      {err && <span className="ark-float ark-pill px-3 py-1 text-[11px] text-noe-danger">{err}</span>}
      {!err && notice && <span className="ark-float ark-pill px-3 py-1 text-[11px]">{notice}</span>}
    </div>
  );
}

export function CopilotPill({ v, active, onPress }: { v: View | null; active: boolean; onPress: () => void }) {
  const n = v?.state.insights.length ?? 0;
  return (
    <Button variant="tertiary" className={`ark-pill ark-float !h-10 gap-2 px-4 ${active ? "is-active" : ""}`} onPress={onPress}>
      <SparkIcon size={14} /> Copilot
      {n > 0 && <span className="grid size-5 place-items-center rounded-full bg-white text-[10px] font-semibold text-noe-bg tabular">{n}</span>}
    </Button>
  );
}

// ---------------------------------------------------------------- title

export function Title({ v, conn, error }: { v: View | null; conn: Conn; error: string | null }) {
  const clock = v?.state.clock;
  const lvl = v?.target ? v.levels[v.target.code] : undefined;
  const status = conn === "no_db" ? "No database"
    : conn === "connecting" ? "Connecting…"
    : conn === "offline" ? "Stream offline · retrying"
    : error ? "Resync failed · retrying"
    : clock?.mode === "SCENARIO" ? "SCENARIO · simulated" : "REPLAY · real data 19–20 Oct 2026";
  return (
    <div className="pointer-events-none">
      <h1 className="text-[56px] font-light leading-none tracking-tight text-white drop-shadow-[0_2px_16px_rgba(0,0,0,0.55)]">
        Sommières{" "}
        {lvl != null && <span className="tabular text-white/40">{lvl.toFixed(2)}<span className="text-[0.5em]"> m</span></span>}
      </h1>
      <div className="pointer-events-auto mt-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="ark-pill ark-float inline-flex h-8 items-center gap-2 px-3">
          <span className={`size-1.5 rounded-full ${conn === "live" && !error ? "bg-noe-land" : conn === "connecting" ? "bg-white/60" : "bg-noe-danger"}`} />
          {status}
        </span>
        {clock && (
          <span className="ark-pill ark-float inline-flex h-8 items-center gap-2 px-3 tabular">
            <span className="text-white/50">{day(clock.simTime)}</span>{hhmm(clock.simTime)}<span className="text-white/50">×{clock.speed}</span>
          </span>
        )}
        {v?.state.perimeter.active && (
          <span className="ark-pill ark-float inline-flex h-8 items-center gap-2 px-3">
            <span className="size-1.5 rounded-full bg-noe-warn" />Perimeter alert · {v.state.perimeter.radiusKm} km
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- bottom-left: search + action grid

export function SearchBox({ v, onSelect }: { v: View | null; onSelect: (s: Selection) => void }) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!v || n.length < 2) return [];
    const res = v.state.residents
      .filter((r) => r.name.toLowerCase().includes(n) || (r.address ?? "").toLowerCase().includes(n))
      .slice(0, 5).map((r) => ({ sel: { type: "resident" as const, id: r.id }, label: r.name, sub: r.address ?? mobilityLabel(r), level: v.levelBy.get(r.id) }));
    const sites = v.state.sites
      .filter((s) => s.name.toLowerCase().includes(n)).slice(0, 3)
      .map((s) => ({ sel: { type: "site" as const, id: s.id }, label: s.name, sub: s.kind.replace("_", " "), level: undefined }));
    return [...res, ...sites];
  }, [q, v]);
  return (
    <div className="relative">
      {hits.length > 0 && (
        <div className="ark-glass absolute bottom-full left-0 right-0 mb-2 overflow-hidden p-1.5">
          {hits.map((h) => (
            <button key={`${h.sel.type}:${h.sel.id}`} onClick={() => { onSelect(h.sel); setQ(""); }}
              className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left hover:bg-white/[0.07]">
              <span className="grid w-3 place-items-center">{h.level ? <LevelGlyph level={h.level} /> : <span className="size-1.5 rounded-sm bg-noe-warn" />}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{h.label}</span>
                <span className="block truncate text-[11px] text-noe-muted">{h.sub}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && hits[0]) { onSelect(hits[0].sel); setQ(""); } }}
        placeholder="Search resident, address or site" aria-label="Search"
        className="ark-glass h-12 w-full !rounded-full px-5 text-sm outline-none placeholder:text-white/40" />
    </div>
  );
}

export function ActionGrid({ is3d, showFlood, focus, onHome, on3d, onFlood, onFocus }: {
  is3d: boolean; showFlood: boolean; focus: boolean; onHome: () => void; on3d: () => void; onFlood: () => void; onFocus: () => void;
}) {
  const b = (label: string, icon: ReactNode, onPress: () => void, active = false) => (
    <Button variant="tertiary" onPress={onPress} aria-pressed={active}
      className={`ark-pill ark-grid-btn !h-11 w-full justify-start gap-2 px-4 ${active ? "is-active" : ""}`}>
      {icon}{label}
    </Button>
  );
  return (
    <div className="ark-glass grid grid-cols-2 gap-1.5 p-1.5">
      {b("Locate", <LocateIcon size={15} />, onHome)}
      {b(is3d ? "3D" : "2D", <CubeIcon size={15} />, on3d, is3d)}
      {b("Flood", <WavesIcon size={15} />, onFlood, showFlood)}
      {b("Focus", <TriangleGlyph className="!w-3 !h-3" />, onFocus, focus)}
    </div>
  );
}

// ---------------------------------------------------------------- bottom cards

export function ResidentsCard({ v, onOpen }: { v: View; onOpen: () => void }) {
  const c = v.counts;
  return (
    <section className="ark-glass ark-card w-[236px]">
      <CardHead label="Residents" onOpen={onOpen} />
      <div className="mt-auto grid grid-cols-2 gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-[11px] text-white/70"><TriangleGlyph className={`text-noe-danger ${c.needs_help ? "ark-blink" : ""}`} />Need help</div>
          <Big value={c.needs_help} className="mt-1 block text-[38px]" />
        </div>
        <div>
          <div className="flex items-center gap-1.5 text-[11px] text-white/70"><TriangleGlyph className={`text-[var(--ark-caution)] ${c.unstable ? "ark-blink" : ""}`} />Unstable</div>
          <Big value={c.unstable} className="mt-1 block text-[38px]" />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3 text-[11px] text-noe-muted tabular">
        <span className="flex items-center gap-1"><LevelGlyph level="safe" />{c.safe}</span>
        <span className="flex items-center gap-1"><LevelGlyph level="calling" />{c.calling}</span>
        <span className="flex items-center gap-1"><LevelGlyph level="no_answer" />{c.no_answer}</span>
        <span className="ml-auto">{c.not_called} not called</span>
      </div>
    </section>
  );
}

export function RiverCard({ v, onOpen }: { v: View; onOpen: () => void }) {
  const s = v.state;
  const t = v.target;
  const f = s.latestForecast;
  const obs = useMemo(() => (t ? s.observations.filter((o) => o.station_code === t.code) : []), [s.observations, t]);
  const now = t ? v.levels[t.code] ?? null : null;
  const threshold = t?.threshold_m ?? f?.threshold_m ?? 2;
  const etaMin = minutesUntil(f?.eta_crossing, s.clock.simTime);
  const above = (now != null && now >= threshold) || (etaMin != null && etaMin <= 0);
  return (
    <section className="ark-glass ark-card w-[284px]">
      <CardHead label={`Vidourle · ${t ? stationShort(t.name) : "Sommières"}`} onOpen={onOpen} />
      <div className="mt-2 flex items-end justify-between gap-2">
        {now != null ? <Big value={now} digits={2} unit="m" className="text-[38px]" /> : <span className="ark-big ark-dim text-[38px]">–</span>}
        <div className="pb-1 text-right text-[11px] leading-tight">
          <div className="text-noe-muted">{above ? "above" : "crosses"} {threshold.toFixed(1)} m{above ? " since" : ""}</div>
          <div className="tabular">
            {above ? (f?.eta_crossing && etaMin != null && etaMin <= 0 ? hhmm(f.eta_crossing) : "now")
              : f?.eta_crossing ? `${hhmm(f.eta_crossing)}${etaMin != null && etaMin > 0 ? ` · ${relMinutes(etaMin)}` : ""}` : "not forecast"}
          </div>
        </div>
      </div>
      <RiverChart obs={obs} forecast={f} threshold={threshold} clock={s.clock} />
      <div className="mt-1 flex justify-between text-[10px] text-noe-muted tabular">
        <span>peak {f?.peak_h_m != null ? `${f.peak_h_m.toFixed(2)} m · ${hhmm(f.peak_time)}` : "—"}</span>
        <span>{f ? `${Math.round(f.confidence * 100)}% · ${f.model}` : ""}</span>
      </div>
    </section>
  );
}

function RiverChart({ obs, forecast, threshold, clock }: { obs: Observation[]; forecast: Forecast | null; threshold: number; clock: NoeState["clock"] }) {
  const W = 252, H = 40, P = 2;
  const t0 = Date.parse(clock.start), t1 = Date.parse(clock.end), tn = Date.parse(clock.simTime);
  if (!(t1 > t0)) return <div className="mt-2 h-10" />;
  const maxH = Math.max(threshold + 0.4, ...obs.map((o) => o.h_m), forecast?.peak_h_m ?? 0) * 1.08;
  const x = (t: number) => P + ((Math.min(t1, Math.max(t0, t)) - t0) / (t1 - t0)) * (W - 2 * P);
  const y = (h: number) => H - P - (Math.max(0, h) / maxH) * (H - 2 * P);
  const line = obs.map((o, i) => `${i ? "L" : "M"}${x(Date.parse(o.ts)).toFixed(1)},${y(o.h_m).toFixed(1)}`).join("");
  const last = obs[obs.length - 1];
  const area = last ? `${line}L${x(Date.parse(last.ts)).toFixed(1)},${H}L${x(Date.parse(obs[0].ts)).toFixed(1)},${H}Z` : "";
  let fc = "";
  if (last && forecast?.peak_h_m != null && forecast.peak_time && Date.parse(forecast.peak_time) > Date.parse(last.ts)) {
    fc = `M${x(Date.parse(last.ts))},${y(last.h_m)}L${x(Date.parse(forecast.peak_time))},${y(forecast.peak_h_m)}`;
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-10 w-full" preserveAspectRatio="none" aria-label="Sommières water level, observed and forecast">
      <defs>
        <linearGradient id="ark-river-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#7DD3FC" stopOpacity="0.4" />
          <stop offset="1" stopColor="#7DD3FC" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1={0} x2={W} y1={y(threshold)} y2={y(threshold)} stroke="#FF9F43" strokeOpacity="0.75" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      {area && <path d={area} fill="url(#ark-river-fill)" />}
      {line && <path d={line} fill="none" stroke="#F3F5F6" strokeWidth="1.3" vectorEffect="non-scaling-stroke" />}
      {fc && <path d={fc} fill="none" stroke="#BAE6FD" strokeWidth="1.2" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />}
      {tn >= t0 && tn <= t1 && <line x1={x(tn)} x2={x(tn)} y1={0} y2={H} stroke="#fff" strokeOpacity="0.3" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

export function CopilotCard({ v, onOpen, onSelect }: { v: View; onOpen: () => void; onSelect: (s: Selection) => void }) {
  const list = v.state.insights;
  const [idx, setIdx] = useState(0);
  const i = list[Math.min(idx, Math.max(0, list.length - 1))];
  const origin = list[0]?.origin;
  return (
    <section className="ark-glass ark-card min-w-[300px] flex-1 max-w-[460px]">
      <CardHead
        label={`Copilot${origin ? ` · ${origin === "llm" ? "Claude" : "template"}` : ""}`}
        onOpen={onOpen}
        extra={list.length > 1 ? (
          <span className="flex items-center gap-1 text-[11px] text-noe-muted tabular">
            <button aria-label="Previous suggestion" className="px-1 hover:text-white" onClick={() => setIdx((k) => (k - 1 + list.length) % list.length)}>‹</button>
            {Math.min(idx, list.length - 1) + 1}/{list.length}
            <button aria-label="Next suggestion" className="px-1 hover:text-white" onClick={() => setIdx((k) => (k + 1) % list.length)}>›</button>
          </span>
        ) : null}
      />
      {!i ? (
        <p className="mt-auto text-[12px] leading-relaxed text-noe-muted">No open suggestion. They appear when residents are exposed or ask for help.<br />It suggests, you decide.</p>
      ) : (
        <>
          <button className="mt-2 text-left" onClick={() => {
            const t = i.action.payload.targetId, tt = i.action.payload.targetType;
            if (t && tt) onSelect({ type: tt, id: t });
          }}>
            <div className="line-clamp-1 text-[14px]">{i.title}</div>
            <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-noe-muted">{i.detail}</div>
          </button>
          <InsightActions key={i.id} i={i} v={v} compact />
        </>
      )}
    </section>
  );
}

export function RescuersCard({ v, onOpen }: { v: View; onOpen: () => void }) {
  const busy = new Set(v.activeMissions.map((m) => m.rescuer_id));
  const avail = v.state.rescuers.filter((r) => r.available && !busy.has(r.id));
  const t3 = avail.filter((r) => r.tier === "T3").length;
  return (
    <section className="ark-glass ark-card w-[208px] max-[1380px]:hidden">
      <CardHead label="Rescuers" onOpen={onOpen} />
      <div className="mt-auto flex items-end gap-2">
        <Big value={avail.length} className="text-[38px]" />
        <span className="pb-1.5 text-[11px] text-noe-muted">available</span>
      </div>
      <div className="mt-3 flex items-center gap-3 text-[11px] text-noe-muted tabular">
        <span><span className="text-white">{t3}</span> T3</span>
        <span><span className="text-white">{busy.size}</span> on mission</span>
        <span className="ml-auto">{v.state.rescuers.length - avail.length - busy.size} off</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- insight actions (shared by card, drawer, map card)

function InsightActions({ i, v, compact = false }: { i: Insight; v: View; compact?: boolean }) {
  const [pending, setPending] = useState<null | "send" | "dismiss" | "approve">(null);
  const [err, setErr] = useState<string | null>(null);
  const p = i.action.payload;
  const r = p.rescuerId ? v.rescuerBy.get(p.rescuerId) : undefined;
  const act = async (kind: "send" | "dismiss" | "approve") => {
    setPending(kind);
    setErr(null);
    const res = kind === "send" ? await sendMission(i) : await setInsight(i.id, kind === "dismiss" ? "dismissed" : "accepted");
    setPending(null);
    if (!res.ok) setErr(res.message ?? "Failed");
  };
  return (
    <div className={compact ? "mt-auto" : "mt-3"}>
      <div className="flex items-center gap-2">
        {i.action.type === "assign_mission" && (
          <Button size="sm" className="ark-solid !h-8 px-4" isPending={pending === "send"} isDisabled={!!pending} onPress={() => act("send")}>
            Send {r ? shortName(r.name) : "rescuer"}{p.requiredTier ? ` · ${p.requiredTier}` : ""}
          </Button>
        )}
        {i.action.type === "approve_preevacuation" && (
          <Tooltip delay={300}>
            <Tooltip.Trigger>
              <Button size="sm" className="ark-solid !h-8 px-4" isPending={pending === "approve"} isDisabled={!!pending} onPress={() => act("approve")}>Mark approved</Button>
            </Tooltip.Trigger>
            <Tooltip.Content>Records the decision only: NOÉ does not start an evacuation by itself.</Tooltip.Content>
          </Tooltip>
        )}
        <Button size="sm" variant="tertiary" className="ark-pill !h-8 px-4" isPending={pending === "dismiss"} isDisabled={!!pending} onPress={() => act("dismiss")}>Dismiss</Button>
        <span className="ml-auto text-[10px] text-noe-muted tabular">{Math.round(i.confidence * 100)}%</span>
      </div>
      {err && <p className="mt-1.5 line-clamp-2 text-[11px] text-noe-danger">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- drawer (lists on demand)

export function Drawer({ panel, v, onClose, onSelect }: { panel: Exclude<Panel, "live">; v: View; onClose: () => void; onSelect: (s: Selection) => void }) {
  const title: Record<typeof panel, string> = {
    residents: "Residents", rescuers: "Rescuers", missions: "Missions", activity: "Activity", copilot: "Copilot",
  };
  return (
    <aside className="ark-glass pointer-events-auto flex h-full w-[340px] flex-col overflow-hidden">
      <header className="flex items-center gap-2 px-5 pb-3 pt-4">
        <span className="ark-cap">{title[panel]}</span>
        {panel === "copilot" && <span className="text-[11px] text-noe-muted">· it suggests, you decide</span>}
        <Button isIconOnly size="sm" variant="tertiary" aria-label="Close" className="ark-pill ml-auto !size-7 !min-w-7" onPress={onClose}>
          <CloseIcon size={12} />
        </Button>
      </header>
      <ScrollShadow hideScrollBar className="flex-1 px-3 pb-4">
        {panel === "residents" && <ResidentList v={v} onSelect={onSelect} />}
        {panel === "rescuers" && <RescuerList v={v} onSelect={onSelect} />}
        {panel === "missions" && <MissionList v={v} onSelect={onSelect} />}
        {panel === "activity" && <ActivityFeed logs={v.state.logs} />}
        {panel === "copilot" && <CopilotList v={v} onSelect={onSelect} />}
      </ScrollShadow>
    </aside>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-3 text-xs leading-relaxed text-noe-muted">{children}</p>;
}

function Row({ onClick, left, title, sub, right }: { onClick: () => void; left: ReactNode; title: ReactNode; sub: ReactNode; right?: ReactNode }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06]">
      <span className="grid w-6 flex-none place-items-center">{left}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{title}</span>
        <span className="block truncate text-[11px] text-noe-muted">{sub}</span>
      </span>
      {right && <span className="flex-none text-[11px] text-noe-muted tabular">{right}</span>}
    </button>
  );
}

function ResidentList({ v, onSelect }: { v: View; onSelect: (s: Selection) => void }) {
  const rows = useMemo(() => v.state.residents
    .map((r) => ({ r, level: v.levelBy.get(r.id)! }))
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.r.name.localeCompare(b.r.name)), [v.state.residents, v.levelBy]);
  const alerts = rows.filter((x) => x.level === "needs_help" || x.level === "unstable");
  const rest = rows.filter((x) => x.level !== "needs_help" && x.level !== "unstable");
  const sim = v.state.clock.simTime;
  const row = ({ r, level }: { r: Resident; level: ResidentLevel }) => {
    const st = v.statusBy.get(r.id);
    const ex = v.exposureBy.get(`resident:${r.id}`);
    const wet = ex && !(ex.eta && Date.parse(ex.eta) > Date.parse(sim));
    return (
      <Row key={r.id} onClick={() => onSelect({ type: "resident", id: r.id })}
        left={<LevelGlyph level={level} />}
        title={<>{r.name}{level === "needs_help" || level === "unstable" ? <span className="text-noe-muted"> · {LEVEL_LABEL[level].toLowerCase()}</span> : null}</>}
        sub={residentSub(r, st)}
        right={ex ? <span className="text-[#BAE6FD]">{wet ? "wet" : hhmm(ex.eta)}</span> : undefined} />
    );
  };
  return (
    <div className="flex flex-col">
      <div className="ark-cap px-2.5 pb-1 pt-1">Alerts · {alerts.length}</div>
      {alerts.length ? alerts.map(row) : <Empty>No resident has reported a problem yet.</Empty>}
      <div className="ark-cap mt-3 px-2.5 pb-1">Everyone else · {rest.length}</div>
      {rest.map(row)}
    </div>
  );
}

function RescuerList({ v, onSelect }: { v: View; onSelect: (s: Selection) => void }) {
  const busy = new Map(v.activeMissions.map((m) => [m.rescuer_id, m]));
  const rows = v.state.rescuers.slice().sort((a, b) =>
    Number(busy.has(b.id)) - Number(busy.has(a.id)) || Number(b.available) - Number(a.available) || b.tier.localeCompare(a.tier));
  return (
    <div className="flex flex-col">
      {rows.map((r) => {
        const m = busy.get(r.id);
        return (
          <Row key={r.id} onClick={() => onSelect({ type: "rescuer", id: r.id })}
            left={<span className={`ark-rescuer !size-6 !text-[8px]${r.available ? "" : " is-off"}${m ? " is-busy" : ""}`}>{r.tier}</span>}
            title={r.name} sub={[r.org, r.country].filter(Boolean).join(" · ") || "—"}
            right={m ? `#${missionNumber(m.id)} · ${STEP_LABEL[m.status]}` : r.available ? "Available" : "Off duty"} />
        );
      })}
    </div>
  );
}

function MissionList({ v, onSelect }: { v: View; onSelect: (s: Selection) => void }) {
  const list = v.state.missions.slice().sort((a, b) => b.id - a.id);
  if (!list.length) return <Empty>No mission yet. Send one from a Copilot suggestion: a human always gives the order.</Empty>;
  return (
    <div className="flex flex-col gap-1.5">
      {list.map((m) => {
        const r = v.rescuerBy.get(m.rescuer_id);
        const target = m.target_type === "resident" ? v.residentBy.get(m.target_id)?.name : v.siteBy.get(m.target_id)?.name;
        const step = STEPS.indexOf(m.status);
        return (
          <button key={m.id} onClick={() => onSelect({ type: m.target_type, id: m.target_id })}
            className="ark-tile w-full p-3.5 text-left transition-colors hover:bg-white/[0.06]">
            <div className="flex items-center justify-between text-[12px]">
              <span>Mission <span className="tabular">{missionNumber(m.id)}</span></span>
              <span className={m.status === "backup" ? "text-noe-warn" : m.status === "done" ? "text-noe-muted" : "text-[#BAE6FD]"}>{STEP_LABEL[m.status]}</span>
            </div>
            <div className="mt-1 truncate text-[12px] text-noe-muted">{r ? shortName(r.name) : m.rescuer_id} → {target ?? m.target_id} · {m.required_tier}</div>
            <div className="mt-2.5 flex gap-1">
              {STEPS.map((s, k) => <span key={s} className={`h-0.5 flex-1 rounded-full ${k <= step ? "bg-white" : "bg-white/15"}`} />)}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function CopilotList({ v, onSelect }: { v: View; onSelect: (s: Selection) => void }) {
  if (!v.state.insights.length) return <Empty>No open suggestion. They appear when residents are exposed or ask for help.</Empty>;
  return (
    <div className="flex flex-col gap-1.5">
      {v.state.insights.map((i) => (
        <article key={i.id} className="ark-tile p-3.5">
          <div className="flex items-center justify-between text-[10px] text-noe-muted">
            <span className="ark-cap">{KIND_LABEL[i.kind]}</span>
            <span className="tabular">{hhmm(i.sim_time)}</span>
          </div>
          <button className="mt-1.5 block text-left" onClick={() => {
            const t = i.action.payload.targetId, tt = i.action.payload.targetType;
            if (t && tt) onSelect({ type: tt, id: t });
          }}>
            <div className="text-[13px] leading-snug">{i.title}</div>
            <div className="mt-1 text-[11px] leading-relaxed text-noe-muted">{i.detail}</div>
          </button>
          <InsightActions i={i} v={v} />
        </article>
      ))}
    </div>
  );
}

function ActivityFeed({ logs }: { logs: AgentLog[] }) {
  const list = logs.slice().reverse();
  if (!list.length) return <Empty>Agents have not logged anything yet. Start the replay.</Empty>;
  return (
    <ol className="flex flex-col px-2">
      {list.map((l) => (
        <li key={l.id} className="flex gap-3 border-b border-white/[0.05] py-2.5 last:border-0">
          <span className="w-10 flex-none pt-px text-[11px] text-noe-muted tabular">{hhmm(l.sim_time ?? l.ts)}</span>
          <div className="min-w-0">
            <span className="ark-cap">{l.agent}</span>
            <p className="text-[12px] leading-snug">{l.message}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- selection card (floats on the map) + white action pill

export function SelectionCard({ sel, v, onClose, onSelect }: { sel: NonNullable<Selection>; v: View; onClose: () => void; onSelect: (s: Selection) => void }) {
  const s = v.state;
  let title = "", tag = "", status: ReactNode = null;
  let rows: [string, string][] = [];
  let pill: ReactNode = null;

  if (sel.type === "resident") {
    const r = v.residentBy.get(sel.id);
    if (!r) return null;
    const level = v.levelBy.get(r.id)!;
    const st = v.statusBy.get(r.id);
    const call = v.callBy.get(r.id);
    const ex = v.exposureBy.get(`resident:${r.id}`);
    const mission = v.activeMissions.find((m) => m.target_type === "resident" && m.target_id === r.id);
    const sugg = s.insights.find((i) => i.action.type === "assign_mission" && i.action.payload.targetType === "resident" && i.action.payload.targetId === r.id);
    title = r.name;
    tag = [r.age ? `${r.age}` : null, r.language.toUpperCase(), r.persona ? "demo persona" : null].filter(Boolean).join(" · ");
    status = (
      <span className="flex items-center gap-2">
        <LevelGlyph level={level} />{LEVEL_LABEL[level]}
        {st && <span className="text-noe-muted">· {st.channel === "voice" ? "DOVE voice" : "DOVE button"}</span>}
        {!st && call && <span className="flex items-center gap-1 text-noe-muted">· <PhoneIcon size={11} />{call.state}</span>}
      </span>
    );
    rows = [
      ...(said(st) ? [["Said", `“${said(st)}”`] as [string, string]] : []),
      ["Mobility", `${mobilityLabel(r)}${st?.can_climb_stairs === false ? " · can't climb stairs" : ""}`],
      ...(r.address ? [["Address", r.address] as [string, string]] : []),
    ];
    pill = mission
      ? <InfoPill label={`Mission ${missionNumber(mission.id)}`} value={`${STEP_LABEL[mission.status]} · ${shortName(v.rescuerBy.get(mission.rescuer_id)?.name ?? mission.rescuer_id)}`} onPress={() => onSelect({ type: "rescuer", id: mission.rescuer_id })} />
      : sugg
        ? <SendPill key={sugg.id} i={sugg} v={v} />
        : <InfoPill label="Water" value={waterText(ex, s)} hint={ex ? "approx. model" : undefined} />;
  } else if (sel.type === "site") {
    const site = v.siteBy.get(sel.id);
    if (!site) return null;
    title = site.name;
    tag = `${site.kind.replace("_", " ")} · OSM`;
    rows = [["Capacity", site.capacity != null ? String(site.capacity) : "unknown"]];
    pill = <InfoPill label="Water" value={waterText(v.exposureBy.get(`site:${site.id}`), s)} hint={v.exposureBy.has(`site:${site.id}`) ? "approx. model" : undefined} />;
  } else if (sel.type === "rescuer") {
    const r = v.rescuerBy.get(sel.id);
    if (!r) return null;
    const m = v.activeMissions.find((x) => x.rescuer_id === r.id);
    title = r.name;
    tag = [r.org, r.country, r.persona ? "demo persona" : null].filter(Boolean).join(" · ");
    status = <span>{r.tier === "T3" ? "T3 · swiftwater certified" : r.tier}</span>;
    rows = [];
    const target = m ? (m.target_type === "resident" ? v.residentBy.get(m.target_id)?.name : v.siteBy.get(m.target_id)?.name) : null;
    pill = m
      ? <InfoPill label={`Mission ${missionNumber(m.id)}`} value={`${STEP_LABEL[m.status]} → ${target ?? m.target_id}`} onPress={() => onSelect({ type: m.target_type, id: m.target_id })} />
      : <InfoPill label="Status" value={r.available ? "Available" : "Off duty"} />;
  } else {
    const st = s.stations.find((x) => x.code === sel.id);
    if (!st) return null;
    const lvl = v.levels[st.code];
    title = stationShort(st.name);
    tag = `Hub'Eau gauge ${st.code}`;
    rows = st.threshold_m != null ? [["Threshold", `${st.threshold_m.toFixed(1)} m · ${st.threshold_label ?? ""}`]] : [["Role", st.role]];
    pill = <InfoPill label="Level now" value={lvl != null ? `${lvl.toFixed(2)} m` : "—"} />;
  }

  return (
    <div className="flex w-[280px] flex-col items-stretch gap-2">
      <div className="ark-glass p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[17px] leading-tight">{title}</div>
            {tag && <div className="mt-0.5 truncate text-[11px] text-noe-muted">{tag}</div>}
          </div>
          <Button isIconOnly size="sm" variant="tertiary" aria-label="Close" className="ark-pill !size-7 !min-w-7" onPress={onClose}>
            <CloseIcon size={12} />
          </Button>
        </div>
        {status && <div className="mt-3 text-[13px]">{status}</div>}
        {rows.length > 0 && (
          <dl className="mt-3 flex flex-col gap-1.5 text-[12px]">
            {rows.map(([k, val]) => (
              <div key={k} className="flex gap-3">
                <dt className="ark-cap w-16 flex-none pt-0.5">{k}</dt>
                <dd className="min-w-0 flex-1 leading-snug">{val}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {pill}
    </div>
  );
}

function InfoPill({ label, value, hint, onPress }: { label: string; value: string; hint?: string; onPress?: () => void }) {
  const body = (
    <>
      <span className="text-[11px] text-black/55">{label}{hint ? <span className="text-black/35"> · {hint}</span> : null}</span>
      <span className="ml-auto truncate text-[13px] font-medium tabular">{value}</span>
    </>
  );
  return onPress ? (
    <button onClick={onPress} className="ark-white-pill flex items-center gap-3 text-left">{body}<ArrowUpRightIcon size={14} className="flex-none" /></button>
  ) : (
    <div className="ark-white-pill flex items-center gap-3">{body}</div>
  );
}

function SendPill({ i, v }: { i: Insight; v: View }) {
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const r = i.action.payload.rescuerId ? v.rescuerBy.get(i.action.payload.rescuerId) : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="ark-white-pill flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] text-black/55">Copilot suggests</span>
          <span className="block truncate text-[13px] font-medium">{r ? `${shortName(r.name)} · ${r.tier}` : "a rescuer"}</span>
        </span>
        <Button size="sm" className="!h-8 rounded-full bg-noe-bg px-4 text-white" isPending={pending}
          onPress={async () => { setPending(true); setErr(null); const res = await sendMission(i); setPending(false); if (!res.ok) setErr(res.message ?? "Failed"); }}>
          Send
        </Button>
      </div>
      {err && <p className="ark-glass !rounded-2xl px-3 py-2 text-[11px] text-noe-danger">{err}</p>}
    </div>
  );
}
