// NOÉ runtime: replay clock + agent pipeline (watcher -> forecaster -> exposure -> voice playbook -> dispatcher/copilot).
// Singleton on globalThis so it survives dev HMR and is shared by every route handler of this Node process.
import type {
  AgentName, DataMode, DoveCall, Exposure, FloodState, Forecast, HistoricFlood, Insight, Mission, NoeEvent, Observation,
  RainObs, RainStation, ReplayClock, Rescuer, Resident, Site, Station, StatusReport,
} from "./types";
import { hasDb, one, query } from "./db";
import { emitEvent } from "./bus";
import { loadRoads, loadTerrain, type TerrainGrid } from "./terrain";
import { runForecast, type Projection } from "./forecaster";
import { computeExposures, floodAt } from "./exposure";
import { draftAssignments, roadCuts, type Need } from "./dispatcher";
import { runCopilot, summarizeRain, templateInsights, type CopilotContext, type CopilotInput, type InsightDraft } from "./copilot";
import {
  PERIMETER_CENTER, PERIMETER_RADIUS_KM, REAL_PHONE_RESIDENT, haversineM, hhmm, processSim,
  scheduleResidentOutcome, scheduleRescuers, type SimItem,
} from "./sim";

const MIN = 60_000;
const SLOT_MS = 15 * MIN; // pipeline every 15 sim-minutes
const COPILOT_MIN_GAP_MS = 20_000; // real time
const CALL_WINDOW_MS = 90 * MIN;

interface Engine {
  simMs: number; speed: number; running: boolean; timer: ReturnType<typeof setInterval> | null;
  startMs: number; endMs: number; mode: DataMode; modeChecked: boolean;
  primed: boolean; lastCopiedMs: number; tickBusy: boolean;
  hNow: Record<string, number>;
  flood: FloodState | null; projection: Projection[]; lastForecasts: Forecast[]; bestForecastId: number | null;
  lastSlot: number; pipelineRunning: boolean;
  perimeterActive: boolean; perimeterSimMs: number | null;
  simQueue: SimItem[];
  epoch: number;
  copilot: { running: boolean; pending: boolean; dirty: boolean; lastRunReal: number };
  cache: { stations?: Station[]; sites?: Site[]; residents?: Resident[] };
}

const g = globalThis as unknown as { __noeEngine?: Engine; __noeTick?: () => void };

function envMs(name: string, fallback: string): number {
  const v = Date.parse(process.env[name] || fallback);
  return Number.isFinite(v) ? v : Date.parse(fallback);
}

function eng(): Engine {
  if (!g.__noeEngine) {
    const startMs = envMs("REPLAY_START", "2026-10-19T18:00:00Z");
    const endMs = envMs("REPLAY_END", "2026-10-20T12:00:00Z");
    g.__noeEngine = {
      simMs: startMs, speed: clampSpeed(Number(process.env.REPLAY_SPEED) || 60), running: false, timer: null,
      startMs, endMs, mode: "REPLAY", modeChecked: false,
      primed: false, lastCopiedMs: startMs, tickBusy: false,
      hNow: {}, flood: null, projection: [], lastForecasts: [], bestForecastId: null,
      lastSlot: -1, pipelineRunning: false,
      perimeterActive: false, perimeterSimMs: null,
      simQueue: [], epoch: 0,
      copilot: { running: false, pending: false, dirty: false, lastRunReal: 0 },
      cache: {},
    };
  }
  return g.__noeEngine;
}

function clampSpeed(s: number): number {
  return Math.max(10, Math.min(600, Math.round(s)));
}
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------- public API

export function getClock(): ReplayClock {
  const e = eng();
  return { simTime: iso(e.simMs), speed: e.speed, running: e.running, start: iso(e.startMs), end: iso(e.endMs), mode: e.mode };
}

export function getFlood(): FloodState | null {
  return eng().flood;
}

/** Read-only view of the in-memory model state, for routes (missions safety check, RAVEN, state). */
export function getRuntime() {
  const e = eng();
  return {
    simMs: e.simMs, hNow: e.hNow, projection: e.projection, bestForecastId: e.bestForecastId,
    lastForecasts: e.lastForecasts, perimeterActive: e.perimeterActive,
  };
}

export const PERIMETER = { center: PERIMETER_CENTER, radiusKm: PERIMETER_RADIUS_KM };

/** Perimeter state survives a server restart: falls back to the agent_log row written when it fired. */
export async function isPerimeterActive(): Promise<boolean> {
  const e = eng();
  if (e.perimeterActive) return true;
  if (!hasDb()) return false;
  const r = await one<{ n: number }>("select count(*)::int as n from agent_log where data->>'perimeter' = 'true'");
  if (r && r.n > 0) {
    e.perimeterActive = true;
    return true;
  }
  return false;
}

/** Write one agent_log row stamped with the current sim time. Never throws. */
export async function logAgent(agent: AgentName, message: string, data?: unknown): Promise<void> {
  try {
    await query("insert into agent_log (sim_time, agent, message, data) values ($1, $2, $3, $4)", [
      iso(eng().simMs), agent, message, JSON.stringify(data ?? null),
    ]);
  } catch (err: any) {
    console.error("[log] failed", agent, message, err?.message);
  }
}

/** Trigger the dispatcher + copilot immediately (still never concurrently). */
export function notifyNeed(_kind: "needs_help" | "rescuer_available"): void {
  requestCopilot(true);
}

export async function control(action: "start" | "pause" | "reset" | "speed", speed?: number): Promise<ReplayClock> {
  const e = eng();
  if (action === "speed") {
    if (speed == null || !Number.isFinite(speed)) throw new Error("speed required");
    e.speed = clampSpeed(speed);
    emitClock();
    await logAgent("replay", `Speed ×${e.speed}`, { speed: e.speed });
    return getClock();
  }
  if (action === "pause") {
    stopTimer(e);
    e.running = false;
    emitClock();
    await logAgent("replay", "Replay paused", null);
    return getClock();
  }
  if (action === "reset") {
    await reset(e);
    return getClock();
  }
  // start
  if (!hasDb()) throw new Error("DATABASE_URL is not set");
  if (e.running) return getClock();
  if (e.simMs >= e.endMs) return getClock(); // finished: reset first
  await detectMode(e);
  if (!e.primed) {
    await query(
      `insert into observations (station_code, ts, h_m, source)
       select station_code, ts, h_m, source from observations_raw
       where ts <= $1 and station_code in (select code from stations)
       on conflict do nothing`,
      [iso(e.simMs)],
    );
    await copyReference(e.lastCopiedMs, e.simMs, true);
    e.lastCopiedMs = e.simMs;
    await refreshHNow(e);
    e.primed = true;
  }
  e.running = true;
  stopTimer(e);
  e.timer = setInterval(() => g.__noeTick?.(), 1000);
  emitClock();
  await logAgent("replay", `Replay started · ×${e.speed} · ${e.mode === "SCENARIO" ? "SCENARIO" : "REPLAY · real data 19–20 Oct 2026"}`, { speed: e.speed });
  e.lastSlot = Math.floor(e.simMs / SLOT_MS) - 1;
  maybePipeline(e);
  return getClock();
}

// ---------------------------------------------------------------- clock

function emitClock() {
  emitEvent({ table: "clock", op: "TICK", row: getClock() });
}

function stopTimer(e: Engine) {
  if (e.timer) clearInterval(e.timer);
  e.timer = null;
}

async function detectMode(e: Engine) {
  if (e.modeChecked) return;
  const r = await one<{ source: string | null }>("select source from observations_raw limit 1");
  e.mode = r?.source === "scenario" ? "SCENARIO" : "REPLAY";
  e.modeChecked = true;
}

async function refreshHNow(e: Engine) {
  const rows = await query<{ station_code: string; h_m: number }>(
    `select distinct on (station_code) station_code, h_m from observations where ts <= $1 order by station_code, ts desc`,
    [iso(e.simMs)],
  );
  e.hNow = Object.fromEntries(rows.map((r) => [r.station_code, r.h_m]));
}

async function tick() {
  const e = eng();
  if (!e.running) return;
  e.simMs = Math.min(e.endMs, e.simMs + e.speed * 1000);
  const finished = e.simMs >= e.endMs;
  if (finished) {
    stopTimer(e);
    e.running = false;
  }
  emitClock();
  if (finished) void logAgent("replay", "Replay finished", null);
  if (e.tickBusy) return;
  e.tickBusy = true;
  const epoch = e.epoch;
  try {
    // 1) copy newly due observations (each INSERT fires NOTIFY per row)
    const to = e.simMs;
    if (to > e.lastCopiedMs) {
      const rows = await query<{ station_code: string; ts: string; h_m: number }>(
        `insert into observations (station_code, ts, h_m, source)
         select station_code, ts, h_m, source from observations_raw
         where ts > $1 and ts <= $2 and station_code in (select code from stations)
         order by ts
         on conflict do nothing
         returning station_code, ts, h_m`,
        [iso(e.lastCopiedMs), iso(to)],
      );
      if (epoch !== e.epoch) return;
      await copyReference(e.lastCopiedMs, to, false);
      if (epoch !== e.epoch) return;
      e.lastCopiedMs = to;
      rows.sort((a, b) => a.ts.localeCompare(b.ts));
      for (const r of rows) e.hNow[r.station_code] = r.h_m;
    }
    // 2) simulated personas
    await processSim(e.simQueue, e.simMs, simCtx(e, epoch));
    // 3) pipeline on 15-min boundaries
    maybePipeline(e);
    // 4) debounced copilot
    if (e.copilot.dirty && Date.now() - e.copilot.lastRunReal >= COPILOT_MIN_GAP_MS) requestCopilot(false, true);
  } catch (err: any) {
    console.error("[replay] tick failed", err?.message);
  } finally {
    e.tickBusy = false;
  }
}
g.__noeTick = () => void tick();

/** Replay Hub'Eau discharge and Météo-France rain like observations (each INSERT fires NOTIFY). Never throws. */
async function copyReference(fromMs: number, toMs: number, prime: boolean) {
  if (prime) fromMs = 0; // first copy: everything up to the start time
  const range = "ts > $1 and ts <= $2";
  try {
    await query(
      `insert into flows (station_code, ts, q_m3s, source)
       select station_code, ts, q_m3s, source from flows_raw
       where ${range} and station_code in (select code from stations) order by ts on conflict do nothing`,
      [iso(fromMs), iso(toMs)],
    );
    await query(
      `insert into rain (station_code, ts, rr1_mm)
       select station_code, ts, rr1_mm from rain_raw
       where ${range} and station_code in (select code from rain_stations) order by ts on conflict do nothing`,
      [iso(fromMs), iso(toMs)],
    );
  } catch (err: any) {
    console.error("[replay] reference copy failed (run db:seed?)", err?.message);
  }
}

function simCtx(e: Engine, epoch: number) {
  return {
    simIso: () => iso(e.simMs),
    log: logAgent,
    notifyNeed,
    stale: () => epoch !== e.epoch,
  };
}

// ---------------------------------------------------------------- reset

async function reset(e: Engine) {
  e.epoch++;
  stopTimer(e);
  e.running = false;
  if (hasDb()) {
    await query(
      "truncate observations, flows, rain, forecasts, exposures, missions, status_reports, insights, agent_log, dove_calls restart identity cascade",
    );
    await query("update rescuers set available = false, lat = home_lat, lon = home_lon, updated_at = now()");
  }
  e.simMs = e.startMs;
  e.primed = false;
  e.lastCopiedMs = e.startMs;
  e.hNow = {};
  e.flood = null;
  e.projection = [];
  e.lastForecasts = [];
  e.bestForecastId = null;
  e.lastSlot = -1;
  e.perimeterActive = false;
  e.perimeterSimMs = null;
  e.simQueue = [];
  e.copilot = { running: e.copilot.running, pending: false, dirty: false, lastRunReal: 0 };
  e.cache = {};
  e.modeChecked = false;
  e.speed = clampSpeed(Number(process.env.REPLAY_SPEED) || 60); // rehearsals (smoke: ×600) must not leak into the demo
  emitEvent({ table: "reset", op: "RESET", row: {} } as NoeEvent);
  emitClock();
}

// ---------------------------------------------------------------- cached reference data

async function getStations(e: Engine): Promise<Station[]> {
  if (!e.cache.stations) {
    e.cache.stations = await query<Station>(
      "select code, name, river, role, lat, lon, threshold_m, threshold_label from stations order by code",
    );
  }
  return e.cache.stations;
}
async function getSites(e: Engine): Promise<Site[]> {
  if (!e.cache.sites) {
    e.cache.sites = await query<Site>(
      `select id, kind, name, capacity, lat, lon, elevation_m, source,
              category, ref, address, phone, capacity_source, official_zone, official_depth
       from sites order by id`,
    );
  }
  return e.cache.sites;
}
async function getResidents(e: Engine): Promise<Resident[]> {
  if (!e.cache.residents) {
    e.cache.residents = await query<Resident>(
      "select id, name, age, language, mobility, floor, address, lat, lon, elevation_m, persona from residents order by id",
    );
  }
  return e.cache.residents;
}

let terrainWarned = false;
export function safeTerrain(): TerrainGrid | null {
  try {
    return loadTerrain();
  } catch (err: any) {
    if (!terrainWarned) console.error("[replay] terrain grid unavailable:", err?.message);
    terrainWarned = true;
    return null;
  }
}

// ---------------------------------------------------------------- pipeline

function maybePipeline(e: Engine) {
  const slot = Math.floor(e.simMs / SLOT_MS);
  if (slot > e.lastSlot && !e.pipelineRunning) {
    e.lastSlot = slot;
    void runPipeline(e);
  }
}

async function runPipeline(e: Engine) {
  e.pipelineRunning = true;
  const epoch = e.epoch;
  const stale = () => epoch !== e.epoch;
  const simMs = e.simMs;
  const simIso = iso(simMs);
  const simTime = new Date(simMs);
  try {
    // --- Watcher
    const stations = await getStations(e);
    const rows = await query<Observation>(
      "select station_code, ts, h_m, source from observations where ts <= $1 order by ts",
      [simIso],
    );
    if (stale()) return;
    const obs: Record<string, Observation[]> = {};
    for (const s of stations) obs[s.code] = [];
    for (const r of rows) (obs[r.station_code] ??= []).push(r);
    const hNow: Record<string, number> = {};
    for (const [code, list] of Object.entries(obs)) if (list.length) hNow[code] = list[list.length - 1].h_m;
    e.hNow = { ...e.hNow, ...hNow };
    const target = stations.find((s) => s.role === "target");
    const tList = target ? obs[target.code] ?? [] : [];
    const tNow = tList.length ? tList[tList.length - 1] : null;
    const tHourAgo = tList.length ? [...tList].reverse().find((o) => Date.parse(o.ts) <= simMs - 60 * MIN) : undefined;
    const trend = tNow && tHourAgo ? Math.round((tNow.h_m - tHourAgo.h_m) * 100) : null;
    if (stale()) return;
    await logAgent(
      "watcher",
      `${Object.keys(hNow).length} gauges read · Sommières ${tNow ? tNow.h_m.toFixed(2) + " m" : "n/a"}${trend != null ? ` · ${trend >= 0 ? "+" : ""}${trend} cm/h` : ""}`,
      { hNow, simTime: simIso },
    );
    if (stale()) return;

    // --- Forecaster
    const fc = runForecast({ simTime, stations, obs });
    const inserted: Forecast[] = [];
    let best: Forecast | null = null;
    for (const d of fc.drafts) {
      if (stale()) return;
      const row = await one<Forecast>(
        `insert into forecasts (sim_time, station_code, h_now_m, rate_cm_h, eta_crossing, peak_h_m, peak_time, confidence, model, threshold_m)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [simIso, d.station_code, d.h_now_m, d.rate_cm_h, d.eta_crossing, d.peak_h_m, d.peak_time, d.confidence, d.model, d.threshold_m],
      );
      if (!row) continue;
      inserted.push(row);
      if (d === fc.best || (!best && d.model === fc.best.model)) best = row;
    }
    if (!best && inserted.length) best = inserted[inserted.length - 1];
    if (stale()) return;
    e.lastForecasts = inserted;
    e.bestForecastId = best?.id ?? null;
    e.projection = fc.projection;
    if (best && !stale()) await logAgent("forecaster", forecastMessage(best, simMs), { forecastId: best.id, model: best.model });

    // --- Exposure (approximate flood model)
    const grid = safeTerrain();
    if (grid) {
      const f = floodAt(grid, e.hNow);
      e.flood = {
        simTime: simIso,
        hTarget: target ? e.hNow[target.code] ?? 0 : 0,
        cells: f.cells,
        depths: f.depths.map((d) => Math.round(d * 100) / 100),
      };
      emitEvent({ table: "flood", op: "UPDATE", row: e.flood });
      const [sites, residents] = await Promise.all([getSites(e), getResidents(e)]);
      const drafts = computeExposures({ g: grid, simTime, hNow: e.hNow, projection: fc.projection, sites, residents });
      if (stale()) return;
      if (best && drafts.length) {
        await query(
          `insert into exposures (forecast_id, target_type, target_id, eta, depth_m, priority)
           select $1::bigint, * from unnest($2::text[], $3::text[], $4::timestamptz[], $5::numeric[], $6::int[])`,
          [
            best.id,
            drafts.map((x) => x.target_type),
            drafts.map((x) => x.target_id),
            drafts.map((x) => x.eta),
            drafts.map((x) => x.depth_m),
            drafts.map((x) => Math.round(x.priority)),
          ],
        );
      }
      if (stale()) return;
      const nSites = drafts.filter((x) => x.target_type === "site").length;
      const nRes = drafts.filter((x) => x.target_type === "resident").length;
      const wetNow = drafts.some((x) => x.eta != null && Date.parse(x.eta) <= simMs); // eta = simTime when already wet
      const etas = drafts.map((x) => (x.eta ? Date.parse(x.eta) : NaN)).filter((t) => Number.isFinite(t) && t > simMs);
      const first = wetNow ? " · water already at some targets" : etas.length ? ` · first water ≈${hhmm(new Date(Math.min(...etas)))}` : "";
      await logAgent("exposure", `${nSites} sites, ${nRes} residents exposed${first} · approximate flood model`, {
        sites: nSites, residents: nRes, forecastId: best?.id ?? null,
      });

      // --- Voice playbook (auto, low-regret): call exposed residents with water < 90 min away
      await runPlaybook(e, epoch, drafts, residents, simMs);
    } else {
      await logAgent("exposure", "Terrain grid not loaded · exposure skipped", null);
    }
    if (stale()) return;

    // --- RAVEN perimeter
    if (!e.perimeterActive && best && best.confidence >= 0.6 && (best.eta_crossing || best.h_now_m >= best.threshold_m)) {
      e.perimeterActive = true;
      e.perimeterSimMs = simMs;
      await logAgent("dispatcher", `Perimeter alert · ${PERIMETER_RADIUS_KM} km around Sommières`, {
        perimeter: true, center: PERIMETER_CENTER, radiusKm: PERIMETER_RADIUS_KM, forecastId: best.id,
      });
      const rescuers = await query<Pick<Rescuer, "id" | "available">>("select id, available from rescuers");
      scheduleRescuers(e.simQueue, rescuers, simMs);
    }

    // new forecast -> copilot (debounced; first one runs immediately)
    requestCopilot(false);
  } catch (err: any) {
    console.error("[replay] pipeline failed", err);
    if (!stale()) await logAgent("replay", `Pipeline error: ${String(err?.message ?? err).slice(0, 160)}`, null);
  } finally {
    e.pipelineRunning = false;
  }
}

function forecastMessage(f: Forecast, simMs: number): string {
  const conf = Math.round(f.confidence * 100);
  if (f.h_now_m >= f.threshold_m) {
    const since = f.eta_crossing ? ` since ${hhmm(f.eta_crossing)}` : "";
    const peak = f.peak_h_m != null ? ` · peak upper bound ≈${f.peak_h_m.toFixed(2)} m (approximate)` : "";
    return `Sommières above demo threshold (${f.threshold_m.toFixed(2)} m)${since}${peak} (${conf}%)`;
  }
  if (f.eta_crossing && Date.parse(f.eta_crossing) >= simMs) return `Sommières overflow ETA ${hhmm(f.eta_crossing)} (${conf}%)`;
  return `No overflow expected in 6 h (${conf}%)`;
}

async function runPlaybook(
  e: Engine, epoch: number, drafts: { target_type: string; target_id: string; eta: string | null; depth_m: number | null }[],
  residents: Resident[], simMs: number,
) {
  const due = drafts.filter(
    (x) => x.target_type === "resident" && x.eta != null && Date.parse(x.eta) - simMs < CALL_WINDOW_MS,
  );
  if (!due.length) return;
  const existing = new Set((await query<{ resident_id: string }>("select distinct resident_id from dove_calls")).map((r) => r.resident_id));
  const byId = new Map(residents.map((r) => [r.id, r]));
  for (const x of due) {
    if (epoch !== e.epoch) return;
    if (existing.has(x.target_id)) continue;
    const res = byId.get(x.target_id);
    if (!res) continue;
    const call = await one<DoveCall>("insert into dove_calls (resident_id) values ($1) returning *", [res.id]);
    if (!call) continue;
    existing.add(res.id);
    const when = x.eta && Date.parse(x.eta) > simMs ? `water ≈${hhmm(x.eta)}` : "water at the door";
    await logAgent(
      "voice",
      `Calling ${res.name} (${res.language}) · ${when}${res.id === REAL_PHONE_RESIDENT ? " · DOVE phone ringing" : ""}`,
      { event: "call", residentId: res.id, doveCallId: call.id, eta: x.eta },
    );
    scheduleResidentOutcome(e.simQueue, res.id, call.id, simMs);
    if (res.id === REAL_PHONE_RESIDENT && e.speed > 10) {
      // keep the spoken ETA true and leave time for RAVEN + ARK before the water arrives
      e.speed = clampSpeed(10);
      emitClock();
      await logAgent("replay", "Live DOVE call · replay slowed to ×10", { speed: e.speed });
    }
  }
}

// ---------------------------------------------------------------- dispatcher + copilot

function requestCopilot(urgent: boolean, fromTick = false) {
  const e = eng();
  if (!hasDb()) return;
  e.copilot.dirty = true;
  const gapOk = Date.now() - e.copilot.lastRunReal >= COPILOT_MIN_GAP_MS;
  if (!urgent && !gapOk && !fromTick) return; // the tick will pick it up
  if (e.copilot.running) {
    if (urgent) e.copilot.pending = true;
    return;
  }
  void copilotCycle(e);
}

/** Public reference data at sim time (Hub'Eau discharge, Météo-France rain, Vigicrues records). Never throws. */
async function copilotContext(simIso: string): Promise<CopilotContext | undefined> {
  try {
    const [flows, historicFloods, rainStations, rain] = await Promise.all([
      query<CopilotContext["flows"][number]>(
        `select distinct on (f.station_code) f.station_code, s.name, f.ts, f.q_m3s
         from flows f join stations s on s.code = f.station_code
         where f.ts <= $1 and f.q_m3s is not null order by f.station_code, f.ts desc`,
        [simIso],
      ),
      query<HistoricFlood>("select station_code, label, h_m, q_m3s from historic_floods order by station_code, q_m3s desc nulls last"),
      query<RainStation>("select code, name, lat, lon, alt_m, basin, upstream from rain_stations where basin"),
      query<RainObs>(
        "select station_code, ts, rr1_mm from rain where ts <= $1 and ts > $1::timestamptz - interval '6 hours' and rr1_mm is not null",
        [simIso],
      ),
    ]);
    return { flows, historicFloods, rain: summarizeRain(rainStations, rain, Date.parse(simIso)) };
  } catch (err: any) {
    console.error("[copilot] reference context unavailable (run db:seed?)", err?.message);
    return undefined;
  }
}

async function copilotCycle(e: Engine) {
  e.copilot.running = true;
  e.copilot.dirty = false;
  e.copilot.lastRunReal = Date.now();
  const epoch = e.epoch;
  const stale = () => epoch !== e.epoch;
  try {
    const simMs = e.simMs;
    const simIso = iso(simMs);
    const [sites, residents, statuses, missions, rescuers] = await Promise.all([
      getSites(e),
      getResidents(e),
      query<StatusReport>("select distinct on (resident_id) * from status_reports order by resident_id, created_at desc, id desc"),
      query<Mission>("select * from missions"),
      query<Rescuer>("select * from rescuers where available = true"),
    ]);
    const exposures = e.bestForecastId
      ? await query<Exposure>("select * from exposures where forecast_id = $1 order by priority desc", [e.bestForecastId])
      : [];
    const context = await copilotContext(simIso);
    if (stale()) return;
    if (!e.lastForecasts.length && !statuses.some((s) => s.status === "needs_help")) return;

    const covered = new Set(missions.map((m) => `${m.target_type}:${m.target_id}`));
    const busy = new Set(missions.filter((m) => m.status !== "done").map((m) => m.rescuer_id));
    const resById = new Map(residents.map((r) => [r.id, r]));
    const siteById = new Map(sites.map((s) => [s.id, s]));

    const needs: Need[] = [];
    // Real reports (DOVE page / buttons) outrank simulated personas; most recent first within a rank.
    // draftAssignments sorts by priority only (stable), so insertion order is the tie-break.
    const helpReports = statuses
      .filter((s) => s.status === "needs_help" && !covered.has(`resident:${s.resident_id}`))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);
    for (const s of helpReports) {
      const r = resById.get(s.resident_id);
      if (!r) continue;
      const simulated = s.notes === "simulated persona";
      needs.push({
        targetType: "resident", targetId: r.id, label: r.name, lat: r.lat, lon: r.lon,
        priority: r.id === REAL_PHONE_RESIDENT ? 1000 : simulated ? 100 : 500,
        reason: "needs_help", persona: r.persona, note: s.can_climb_stairs === false ? "cannot climb stairs" : null,
      });
    }
    const siteExp = exposures
      .filter((x) => x.target_type === "site" && !covered.has(`site:${x.target_id}`) && siteById.has(x.target_id))
      .sort((a, b) => {
        const ca = siteById.get(a.target_id)!.kind === "care_home" ? 0 : 1;
        const cb = siteById.get(b.target_id)!.kind === "care_home" ? 0 : 1;
        return ca - cb || b.priority - a.priority;
      })
      .slice(0, 3);
    for (const x of siteExp) {
      const s = siteById.get(x.target_id)!;
      needs.push({ targetType: "site", targetId: s.id, label: s.name, lat: s.lat, lon: s.lon, priority: x.priority, reason: "exposed_site" });
    }

    const free = rescuers.filter((r) => !busy.has(r.id) && r.lat != null && r.lon != null);
    const grid = safeTerrain();
    let roads: ReturnType<typeof loadRoads> = [];
    try {
      roads = loadRoads();
    } catch {
      roads = [];
    }
    const simTime = new Date(simMs);
    const drafts = grid && needs.length && free.length
      ? draftAssignments({ simTime, g: grid, hNow: e.hNow, projection: e.projection, needs, rescuers: free, roads })
      : [];
    const cuts = grid ? roadCuts({ simTime, g: grid, projection: e.projection, roads }) : [];

    const label = (x: Exposure) =>
      x.target_type === "site" ? siteById.get(x.target_id)?.name ?? x.target_id : resById.get(x.target_id)?.name ?? x.target_id;
    const input: CopilotInput = {
      simTime: simIso,
      forecasts: [...e.lastForecasts].sort(
        (a, b) => (b.id === e.bestForecastId ? 1 : 0) - (a.id === e.bestForecastId ? 1 : 0),
      ),
      // top 10 by priority + the exposed sites taken as needs (their official data must reach the copilot)
      topExposures: [...exposures.slice(0, 10), ...siteExp.filter((x) => !exposures.slice(0, 10).includes(x))].map((x) => {
        const s = x.target_type === "site" ? siteById.get(x.target_id) : undefined;
        return {
          target_type: x.target_type, target_id: x.target_id, eta: x.eta, depth_m: x.depth_m, priority: x.priority, label: label(x),
          capacity: s?.capacity ?? null,
          ...(s && {
            category: s.category ?? null, source: s.source, capacity_source: s.capacity_source ?? null,
            official_zone: s.official_zone ?? null, official_depth: s.official_depth ?? null,
          }),
        };
      }),
      openNeeds: needs,
      availableRescuers: free.map((r) => ({
        id: r.id, name: r.name, tier: r.tier, org: r.org,
        distanceToNearestNeedM: needs.length
          ? Math.round(Math.min(...needs.map((n) => haversineM({ lat: r.lat!, lon: r.lon! }, n))))
          : null,
      })),
      drafts,
      roadCuts: cuts,
      context,
    };
    await logAgent(
      "dispatcher",
      `${needs.length} open needs · ${free.length} rescuers free · ${drafts.length} draft assignments${cuts.length ? ` · ${cuts.length} road cuts` : ""}`,
      { needs: needs.map((n) => n.targetId), drafts: drafts.length, roadCuts: cuts.length },
    );
    let out: InsightDraft[];
    try {
      out = await runCopilot(input);
    } catch (err: any) {
      console.error("[copilot] failed, using templates", err?.message);
      out = templateInsights(input);
    }
    if (stale()) return;
    await query("update insights set status = 'dismissed' where status = 'open'");
    for (const ins of out) {
      if (stale()) return;
      await query(
        `insert into insights (sim_time, kind, priority, title, detail, confidence, sources, action, status, origin)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)`,
        [simIso, ins.kind, ins.priority, ins.title, ins.detail, ins.confidence, JSON.stringify(ins.sources ?? []),
          JSON.stringify(ins.action ?? { type: "none", payload: {} }), ins.origin],
      );
    }
    const origin = out[0]?.origin ?? "template";
    const nAssign = out.filter((i) => i.action?.type === "assign_mission").length;
    await logAgent("copilot", `${out.length} suggestions · ${nAssign} assignment${nAssign === 1 ? "" : "s"} (${origin === "llm" ? "LLM" : "template"})`, {
      origin, count: out.length,
    });
  } catch (err: any) {
    console.error("[copilot] cycle failed", err);
  } finally {
    e.copilot.running = false;
    if (e.copilot.pending) {
      e.copilot.pending = false;
      setTimeout(() => {
        if (!e.copilot.running) void copilotCycle(e);
      }, 0);
    }
  }
}

// Re-exported for routes that need the same row type.
export type { Insight };
