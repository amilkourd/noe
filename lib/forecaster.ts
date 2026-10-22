// NOÉ Watcher + Forecaster (spec §7.2). Pure and deterministic: no DB, no LLM.
//   trend_v0: linear trend over the last 60 sim-min of the target gauge.
//   lag_v1:   learned upstream lag (Quissac or Vic-le-Fesq -> Sommières), h_t(t) = a*h_up(t-L) + b.
import type { Forecast, Observation, Station } from "./types";
import { clamp, linreg, MIN } from "./geo";

export type ForecastDraft = Omit<Forecast, "id" | "created_at">;
export interface Projection { t: string /*ISO*/; h: Record<string, number> /*station code -> m*/ }

export const DEMO_THRESHOLD_M = 2.0;
const STEP_MIN = 15;
const MAX_RISE_M_PER_H = 1.5;
const TREND_DECAY_MIN = 150; // trend persistence fades with this time constant

type Pt = { t: number; h: number };

function toPts(obs: Observation[] | undefined, until: number): Pt[] {
  if (!obs) return [];
  const out: Pt[] = [];
  for (const o of obs) {
    const t = Date.parse(o.ts);
    if (!isNaN(t) && t <= until && Number.isFinite(o.h_m)) out.push({ t, h: o.h_m });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Linear interpolation of a sorted series; null outside its range. */
function valueAt(s: Pt[], t: number): number | null {
  if (!s.length || t < s[0].t || t > s[s.length - 1].t) return null;
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = s[lo], b = s[hi];
  if (b.t === a.t) return a.h;
  return a.h + ((b.h - a.h) * (t - a.t)) / (b.t - a.t);
}

/** Slope (m/h) and r2 of a linear fit over the last `windowMin` minutes. */
function trend(s: Pt[], now: number, windowMin = 60): { rate: number; r2: number } | null {
  const pts = s.filter((p) => p.t >= now - windowMin * MIN);
  if (pts.length < 3) return null;
  const f = linreg(pts.map((p) => (p.t - now) / 3_600_000), pts.map((p) => p.h));
  return { rate: f.a, r2: f.r2 };
}

/** Last upward crossing of T in the observed series (interpolated), if currently >= T. */
function observedCrossing(s: Pt[], T: number): number | null {
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i].h >= T && s[i - 1].h < T) {
      const a = s[i - 1], b = s[i];
      return a.t + ((T - a.h) * (b.t - a.t)) / (b.h - a.h);
    }
  }
  return s.length && s[0].h >= T ? s[0].t : null;
}

/** First crossing of T in a projected series (interpolated). */
function projectedCrossing(series: Pt[], T: number): number | null {
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1].h < T && series[i].h >= T) {
      const a = series[i - 1], b = series[i];
      return a.t + ((T - a.h) * (b.t - a.t)) / (b.h - a.h);
    }
  }
  return null;
}

/** Decaying trend persistence from (now, h0) with rate (m/h). Never negative, rise capped. */
function persist(h0: number, rateMH: number, dtMin: number, floor = 0): number {
  const r = Math.min(rateMH, MAX_RISE_M_PER_H);
  const tauH = TREND_DECAY_MIN / 60;
  const dh = r * tauH * (1 - Math.exp(-dtMin / TREND_DECAY_MIN));
  return Math.max(floor, Math.max(0, h0 + dh));
}

interface LagFit { upCode: string; lagSteps: number; a: number; r2: number }

const LAG_WINDOW_MIN = 8 * 60;
const LAG_MAX_STEPS = 16;      // 15 min .. 4 h
const LAG_HALF_LIFE_MIN = 60;  // recency weighting: the river's response changes during the event

/**
 * Learn lag L (15-min steps) and gain a between an upstream gauge and the target:
 * h_t(t) = a*h_up(t-L) + b, fitted on 15-min increments (recency-weighted) so the intercept b is
 * anchored on the latest observation. Keeps the upstream gauge + lag with the best R².
 */
function learnLag(target: Pt[], ups: { code: string; s: Pt[] }[], now: number): LagFit | null {
  const steps = Math.floor(LAG_WINDOW_MIN / STEP_MIN);
  const tgtGrid: Pt[] = [];
  for (let k = steps; k >= 0; k--) {
    const t = now - k * STEP_MIN * MIN;
    const h = valueAt(target, t);
    if (h !== null) tgtGrid.push({ t, h });
  }
  if (tgtGrid.length < 12) return null;
  const hs = tgtGrid.map((p) => p.h);
  // need ~3 h of real variation on the target before learning anything
  const recent = tgtGrid.filter((p) => p.t >= now - 3 * 60 * MIN).map((p) => p.h);
  if (Math.max(...hs) - Math.min(...hs) < 0.25 || Math.max(...recent) - Math.min(...recent) < 0.1) return null;
  let best: LagFit | null = null;
  for (const up of ups) {
    if (up.s.length < 4) continue;
    for (let L = 1; L <= LAG_MAX_STEPS; L++) {
      const dx: number[] = [], dy: number[] = [], w: number[] = [];
      let prevX: number | null = null, prevY: number | null = null;
      for (const p of tgtGrid) {
        const x = valueAt(up.s, p.t - L * STEP_MIN * MIN);
        if (x !== null && prevX !== null && prevY !== null) {
          dx.push(x - prevX); dy.push(p.h - prevY);
          w.push(Math.pow(0.5, (now - p.t) / MIN / LAG_HALF_LIFE_MIN));
        }
        prevX = x; prevY = p.h;
      }
      if (dx.length < 10) continue;
      const upRange = Math.max(...dx) - Math.min(...dx);
      if (!(upRange > 0.01)) continue;
      const f = linreg(dx, dy, w);
      if (f.a <= 0) continue; // physically, upstream rise -> downstream rise
      if (!best || f.r2 > best.r2 + 1e-9) best = { upCode: up.code, lagSteps: L, a: f.a, r2: f.r2 };
    }
  }
  return best;
}

export function runForecast(input: {
  simTime: Date; stations: Station[]; obs: Record<string, Observation[]>; horizonMin?: number;
}): { drafts: ForecastDraft[]; best: ForecastDraft; projection: Projection[] } {
  const now = input.simTime.getTime();
  const horizonMin = input.horizonMin ?? 360;
  const nSteps = Math.floor(horizonMin / STEP_MIN);
  const simIso = new Date(now).toISOString();
  const target = input.stations.find((s) => s.role === "target") ?? input.stations[0];
  const T = target?.threshold_m ?? DEMO_THRESHOLD_M;
  const series: Record<string, Pt[]> = {};
  for (const s of input.stations) series[s.code] = toPts(input.obs[s.code], now);
  const tgt = target ? series[target.code] ?? [] : [];
  const hNow = tgt.length ? tgt[tgt.length - 1].h : 0;
  const tr = trend(tgt, now) ?? { rate: 0, r2: 0 };
  const crossedAt = hNow >= T ? observedCrossing(tgt, T) : null;

  // ---- trend_v0 projection (decaying trend persistence)
  const v0Series: Pt[] = [];
  for (let k = 0; k <= nSteps; k++) {
    const dt = k * STEP_MIN;
    v0Series.push({ t: now + dt * MIN, h: persist(hNow, tr.rate, dt) });
  }
  let etaV0: number | null = null;
  if (crossedAt !== null) etaV0 = crossedAt;
  else if (tr.rate > 0.005 && hNow < T) {
    const e = now + ((T - hNow) / tr.rate) * 3_600_000;
    if (e - now <= 2 * horizonMin * MIN) etaV0 = e;
  }

  // ---- lag_v1
  const ups = input.stations
    .filter((s) => s.role === "upstream" || s.role === "mid")
    .map((s) => ({ code: s.code, s: series[s.code] ?? [] }));
  const fit = tgt.length ? learnLag(tgt, ups, now) : null;
  let v1Series: Pt[] | null = null;
  let etaV1: number | null = null;
  if (fit) {
    const up = series[fit.upCode];
    const Lms = fit.lagSteps * STEP_MIN * MIN;
    const upAnchor = valueAt(up, now - Lms) ?? 0;
    v1Series = [{ t: now, h: hNow }];
    let lastT = now, lastH = hNow, lastRate = tr.rate;
    for (let k = 1; k <= nSteps; k++) {
      const t = now + k * STEP_MIN * MIN;
      const src = t - Lms;
      const x = src <= now ? valueAt(up, src) : null;
      let h: number;
      if (x !== null) {
        h = hNow + fit.a * (x - upAnchor);
        // cap physically implausible rise rates
        const maxH = lastH + MAX_RISE_M_PER_H * (STEP_MIN / 60);
        // and cap the total rise: the upstream gain is not capped by itself and over-predicts the peak
        h = Math.max(0, Math.min(h, maxH, hNow + 1.5));
        lastRate = ((h - lastH) / (t - lastT)) * 3_600_000;
      } else {
        // beyond the learned lag there is no upstream information: fade the trend quickly
        h = Math.max(0, lastH + Math.min(lastRate, MAX_RISE_M_PER_H) * (STEP_MIN / 60));
        lastRate = lastRate * Math.exp(-STEP_MIN / 30);
      }
      v1Series.push({ t, h });
      lastT = t; lastH = h;
    }
    etaV1 = crossedAt !== null ? crossedAt : hNow < T ? projectedCrossing(v1Series, T) : null;
  }

  // ---- confidence (per model: the weaker trend model must not borrow the lag model's confidence)
  const r2 = fit ? fit.r2 : tr.r2;
  let conf: number;
  let confV0: number;
  if (fit && etaV0 !== null && etaV1 !== null) {
    const agreement = 1 - Math.min(1, Math.abs(etaV0 - etaV1) / (120 * MIN));
    conf = clamp(r2 * agreement, 0.4, 0.9);
    confV0 = clamp(0.6 * tr.r2 * agreement, 0.3, 0.8);
  } else {
    conf = clamp(0.6 * r2, 0.4, 0.9);
    confV0 = clamp(0.6 * tr.r2, 0.3, 0.8);
  }
  conf = Math.round(conf * 100) / 100;
  confV0 = Math.round(confV0 * 100) / 100;

  const peakOf = (s: Pt[]) => s.reduce((m, p) => (p.h > m.h ? p : m), s[0]);
  const mk = (model: ForecastDraft["model"], s: Pt[], eta: number | null, rateMH: number, confidence: number): ForecastDraft => {
    const pk = peakOf(s);
    return {
      sim_time: simIso,
      station_code: target?.code ?? "",
      h_now_m: round2(hNow),
      rate_cm_h: Math.round(rateMH * 100 * 10) / 10,
      eta_crossing: eta !== null ? new Date(eta).toISOString() : null,
      peak_h_m: pk ? round2(pk.h) : null,
      peak_time: pk ? new Date(pk.t).toISOString() : null,
      confidence,
      model,
      threshold_m: T,
    };
  };
  const d0 = mk("trend_v0", v0Series, etaV0, tr.rate, fit ? confV0 : conf);
  const drafts: ForecastDraft[] = [d0];
  let d1: ForecastDraft | null = null;
  if (fit && v1Series) {
    const s1h = v1Series.find((p) => p.t >= now + 60 * MIN) ?? v1Series[v1Series.length - 1];
    d1 = mk("lag_v1", v1Series, etaV1, s1h.h - hNow, conf);
    drafts.push(d1);
  }
  const useV1 = !!(d1 && fit && fit.r2 > 0.6);
  const best = useV1 ? d1! : d0;
  const bestSeries = useV1 ? v1Series! : v0Series;

  // ---- projection for all stations (15-min steps from simTime)
  const otherTrend: Record<string, { h0: number; rate: number }> = {};
  for (const s of input.stations) {
    if (target && s.code === target.code) continue;
    const ser = series[s.code] ?? [];
    const h0 = ser.length ? ser[ser.length - 1].h : 0;
    otherTrend[s.code] = { h0, rate: trend(ser, now)?.rate ?? 0 };
  }
  const projection: Projection[] = [];
  for (let k = 0; k <= nSteps; k++) {
    const dt = k * STEP_MIN;
    const h: Record<string, number> = {};
    if (target) h[target.code] = round2(bestSeries[k]?.h ?? hNow);
    for (const [code, o] of Object.entries(otherTrend)) h[code] = round2(persist(o.h0, o.rate, dt));
    projection.push({ t: new Date(now + dt * MIN).toISOString(), h });
  }

  return { drafts, best, projection };
}

/** Diagnostics for the evidence panel / offline sim (which upstream gauge and lag were learned). */
export function lagDiagnostics(input: { simTime: Date; stations: Station[]; obs: Record<string, Observation[]> }) {
  const now = input.simTime.getTime();
  const target = input.stations.find((s) => s.role === "target");
  if (!target) return null;
  const tgt = toPts(input.obs[target.code], now);
  const ups = input.stations.filter((s) => s.role === "upstream" || s.role === "mid")
    .map((s) => ({ code: s.code, s: toPts(input.obs[s.code], now) }));
  const fit = learnLag(tgt, ups, now);
  return fit ? { upstream: fit.upCode, lagMin: fit.lagSteps * STEP_MIN, a: fit.a, r2: fit.r2 } : null;
}

function round2(x: number) { return Math.round(x * 100) / 100; }
