// Getting the rescuer's attention: haptics + vibration on a new alert or mission, screen kept on while engaged.
import { useEffect, useRef } from "react";
import { Platform, Vibration } from "react-native";
import * as Haptics from "expo-haptics";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { Phase } from "./useRaven";

const KEEP_AWAKE_TAG = "raven-duty";
// Android reads [wait, buzz, wait, buzz, ...]. iOS ignores durations: every buzz is a fixed ~400 ms, and each entry
// after a leading 0 is the wait before the next one, so its patterns hold only the gaps (2 and 3 pulses).
const ALERT_PATTERN = Platform.OS === "ios" ? [0, 600] : [0, 400, 200, 400];
const MISSION_PATTERN = Platform.OS === "ios" ? [0, 550, 550] : [0, 600, 150, 600, 150, 600];

function buzz(type: Haptics.NotificationFeedbackType, pattern: number[]) {
  Haptics.notificationAsync(type).catch(() => {});
  Vibration.vibrate(pattern);
}

/** `missionKey` must stay unique across replay resets, which restart mission ids at 1 (e.g. "7@{created_at}"). */
export function useAttention(phase: Phase, missionKey: string | null): void {
  const prevPhase = useRef<Phase | null>(null);
  // last mission seen, kept through null so a reverted optimistic "done" does not buzz again
  const lastMission = useRef<string | null>(null);

  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = phase;
    // Only an alert that is new to this rescuer: coming back to alert from standby or a mission is their own doing
    // (stand down, off duty, a reverted "I'm available") and must not fire the flood signal.
    const alerted = phase === "alert" || phase === "standby";
    if (alerted && (prev === null || prev === "connecting" || prev === "calm")) buzz(Haptics.NotificationFeedbackType.Warning, ALERT_PATTERN);
  }, [phase]);

  useEffect(() => {
    if (missionKey == null) return;
    if (missionKey !== lastMission.current) buzz(Haptics.NotificationFeedbackType.Error, MISSION_PATTERN);
    lastMission.current = missionKey;
  }, [missionKey]);

  const awake = phase === "alert" || phase === "standby" || phase === "mission";
  useEffect(() => {
    if (!awake) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [awake]);
}
