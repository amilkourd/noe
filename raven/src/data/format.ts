// Display formatting. Times are always relative to view.clock.simTime (the replay clock), never the phone clock.
import type { Mobility, Rescuer } from "./types";

type Parts = { value: string; unit: string };
const NONE: Parts = { value: "—", unit: "" };

/** Time left until `targetIso`: "1:40" h, "38" min, "Now" once passed, "—" when unknown. */
export function countdown(targetIso: string | null, nowIso: string): Parts {
  const t = targetIso ? Date.parse(targetIso) : NaN;
  const n = Date.parse(nowIso);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return NONE;
  const min = Math.ceil((t - n) / 60_000); // round up: never show "0 min" while time is left
  if (min <= 0) return { value: "Now", unit: "" };
  if (min < 60) return { value: String(min), unit: "min" };
  return { value: `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`, unit: "h" };
}

/** A countdown in words for screen readers, which read "1:40 h" badly: "1 hour 40 minutes", "38 minutes", "now"; "" when unknown. */
export function spokenCountdown({ value, unit }: Parts): string {
  const n = (x: number, w: string) => `${x} ${w}${x === 1 ? "" : "s"}`;
  if (unit === "h") {
    const [h, m] = value.split(":").map(Number);
    return `${n(h, "hour")}${m ? ` ${n(m, "minute")}` : ""}`;
  }
  if (unit === "min") return n(Number(value), "minute");
  return value === "Now" ? "now" : "";
}

// Hermes may lack time zone data or silently ignore timeZone, so the formatter must prove itself on two known
// instants (winter and summer time) before it is trusted; otherwise the EU rule below is used.
let paris: Intl.DateTimeFormat | null | undefined;
function parisFormatter(): Intl.DateTimeFormat | null {
  if (paris !== undefined) return paris;
  try {
    const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const ok = f.format(Date.UTC(2026, 0, 15, 12, 5)) === "13:05" && f.format(Date.UTC(2026, 6, 15, 12, 5)) === "14:05";
    paris = ok ? f : null;
  } catch {
    paris = null;
  }
  return paris;
}

/** UTC ms of the last Sunday of `month` (0-based) at 01:00 UTC, when EU clocks change. */
function lastSundayUtc(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1);
}

function parisFallback(ms: number): string {
  const y = new Date(ms).getUTCFullYear();
  const summer = ms >= lastSundayUtc(y, 2) && ms < lastSundayUtc(y, 9);
  const d = new Date(ms + (summer ? 2 : 1) * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Paris wall-clock time, "20:14". */
export function parisClock(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "--:--";
  const f = parisFormatter();
  return f ? f.format(ms) : parisFallback(ms);
}

/** "850" m below 1 km, "2.4" km below 10 km, "12" km beyond. */
export function distance(m: number): Parts {
  if (!Number.isFinite(m) || m < 0) return NONE;
  if (Math.round(m) < 1000) return { value: String(Math.round(m)), unit: "m" };
  const km = m / 1000;
  return { value: km < 9.95 ? km.toFixed(1) : String(Math.round(km)), unit: "km" };
}

/** Water depth, "0.8" m. */
export function depth(m: number | null): Parts {
  if (m == null || !Number.isFinite(m)) return NONE;
  return { value: Math.max(0, m).toFixed(1), unit: "m" };
}

/** 0..1 -> "82" %. Values above 1 are taken as already in percent. */
export function percent(x: number): Parts {
  if (!Number.isFinite(x)) return NONE;
  return { value: String(Math.round(x <= 1 ? x * 100 : x)), unit: "%" };
}

const LANGUAGES: Record<string, string> = {
  ar: "Arabic", ca: "Catalan", de: "German", en: "English", es: "Spanish", fr: "French", it: "Italian", nl: "Dutch",
  oc: "Occitan", pl: "Polish", pt: "Portuguese", ro: "Romanian", ru: "Russian", tr: "Turkish", uk: "Ukrainian", zh: "Chinese",
};

/** "es" -> "Spanish"; unknown codes come back uppercased, null as "". */
export function languageName(code: string | null): string {
  const c = code?.trim();
  if (!c) return "";
  return LANGUAGES[c.toLowerCase().split(/[-_]/)[0]] ?? c.toUpperCase();
}

/** Tags for the mission card, e.g. ["REDUCED MOBILITY", "NO STAIRS"]. */
export function mobilityTag(m: Mobility | null, canClimbStairs: boolean | null): string[] {
  const tags: string[] = [];
  if (m === "reduced") tags.push("REDUCED MOBILITY");
  else if (m === "bedridden") tags.push("BEDRIDDEN");
  if (canClimbStairs === false) tags.push("NO STAIRS");
  return tags;
}

/** Initial great-circle bearing in degrees, 0 = north, clockwise. */
export function bearing(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const p1 = from.lat * rad, p2 = to.lat * rad, dl = (to.lon - from.lon) * rad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** Same rule as the server: live position, else home. */
export function rescuerPosition(r: Rescuer): { lat: number; lon: number } | null {
  if (r.lat != null && r.lon != null) return { lat: r.lat, lon: r.lon };
  if (r.home_lat != null && r.home_lon != null) return { lat: r.home_lat, lon: r.home_lon };
  return null;
}
