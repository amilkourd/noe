import type { MissionStatus } from "./types";

export const STEPS: string[] = ["Go", "On site", "Done"];

/** Water depth (m) above which a point counts as wet: the server's threshold (lib/state.ts), for hasWater and waterEta. */
export const WET_M = 0.05;

const PRIMARY: Record<MissionStatus, string | null> = {
  sent: "Accept", accepted: "Go", en_route: "On site", on_site: "Done", backup: "Done", done: null,
};
// "accepted" still has "Go" pending. "backup" replaces the progress status on the server and is offered from en_route
// on, so only "Go" is certain unless the caller knows the status it replaced.
const STEP: Record<MissionStatus, number> = { sent: 0, accepted: 0, en_route: 1, on_site: 2, backup: 1, done: 3 };
const LABEL: Record<MissionStatus, string> = {
  sent: "NEW", accepted: "ACCEPTED", en_route: "EN ROUTE", on_site: "ON SITE", backup: "BACKUP REQUESTED", done: "DONE",
};

/**
 * Label of the button that moves the mission to its next step; null once done. After a backup request the only step
 * left is "Done": any other status would overwrite "backup", and with it the flag ARK shows the dispatcher.
 */
export function primaryLabel(s: MissionStatus): string | null {
  return PRIMARY[s] ?? null;
}

/** Current index in STEPS (3 = all done). For "backup", pass the status it replaced when known. */
export function stepIndex(s: MissionStatus, replaced?: MissionStatus | null): number {
  if (s === "backup" && replaced && replaced !== "backup") return stepIndex(replaced);
  return STEP[s] ?? 0;
}

/** Backup is asked once under way: before that the rescuer has not accepted, and afterwards it is already requested. */
export function canRequestBackup(s: MissionStatus): boolean {
  return s === "en_route" || s === "on_site";
}

export function statusLabel(s: MissionStatus): string {
  return LABEL[s] ?? String(s).toUpperCase();
}
