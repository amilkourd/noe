// Small client-side formatters for ARK (no server imports: lib/sim.ts pulls in the DB).
import type { DoveCall, Resident, ResidentStatus, StatusReport } from "@/lib/types";

const PARIS_HHMM = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hour12: false });
const PARIS_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", day: "2-digit", month: "short" });

export function hhmm(iso: string | null | undefined): string {
  if (!iso) return "--:--";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? PARIS_HHMM.format(t) : "--:--";
}

export function day(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? PARIS_DAY.format(t) : "";
}

/** "Karim Becker" -> "K. Becker" */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

export function missionNumber(id: number): string {
  return String(id).padStart(2, "0");
}

/** Minutes from sim time `nowIso` to `iso` (negative = past). */
export function minutesUntil(iso: string | null | undefined, nowIso: string): number | null {
  if (!iso) return null;
  const a = Date.parse(iso), b = Date.parse(nowIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 60_000);
}

export function relMinutes(min: number | null): string {
  if (min == null) return "";
  if (min <= 0) return "now";
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `in ${h} h ${m}` : `in ${h} h`;
}

/** Splits 1.84 into ["1", ".84"] so the decimals can be dimmed. */
export function splitNum(n: number, digits = 2): [string, string] {
  const s = n.toFixed(digits);
  const i = s.indexOf(".");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i)];
}

// ---------------------------------------------------------------- resident marker level

/** What the map shows for a resident: a DOVE report wins; otherwise the call state. */
export type ResidentLevel = ResidentStatus | "calling" | "no_answer" | "not_called";

export function residentLevel(status: StatusReport | undefined, call: DoveCall | undefined): ResidentLevel {
  if (status) return status.status;
  if (!call) return "not_called";
  if (call.state === "ringing" || call.state === "accepted") return "calling";
  return "no_answer"; // missed, declined, or ended without a report
}

export const LEVEL_LABEL: Record<ResidentLevel, string> = {
  needs_help: "Needs help",
  unstable: "Unstable",
  safe: "Safe",
  calling: "On the line",
  no_answer: "No answer",
  not_called: "Not called",
};

export const LEVEL_RANK: Record<ResidentLevel, number> = {
  needs_help: 0, unstable: 1, calling: 2, no_answer: 3, safe: 4, not_called: 5,
};

export function mobilityLabel(r: Pick<Resident, "mobility" | "floor">): string {
  const m = r.mobility === "ok" ? "Mobile" : r.mobility === "reduced" ? "Reduced mobility" : "Bedridden";
  const f = r.floor === 0 ? "ground floor" : r.floor === 1 ? "1st floor" : `floor ${r.floor}`;
  return `${m} · ${f}`;
}

/** "Le Vidourle à Sommières [Mairie]" -> "Sommières" */
export function stationShort(name: string): string {
  return name.replace(/^.*?\sà\s/, "").replace(/\s*\[.*\]$/, "");
}
