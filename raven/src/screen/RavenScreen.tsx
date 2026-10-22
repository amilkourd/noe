import { useEffect, useRef, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ambient, Glass, glassTint } from "../ds";
import { useAttention } from "../data/attention";
import { useRaven } from "../data/useRaven";
import { BackupDialog } from "./BackupDialog";
import { Header } from "./Header";
import { Instrument } from "./Instrument";
import { useNotice } from "./notices";
import { PhaseCard } from "./PhaseCard";
import { useActions } from "./useActions";

const FADE_MS = 220;
const EDGE = 10; // card margin from the screen edges and above the bottom inset

export function RavenScreen() {
  const raven = useRaven();
  const { phase, view, completed } = raven;
  const mission = view?.mission ?? null;
  // created_at too: a replay reset restarts mission ids at 1, and the next run's mission must buzz again
  useAttention(phase, mission ? `${mission.mission.id}@${mission.mission.created_at}` : null);

  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const notice = useNotice();
  const { pending, run } = useActions();
  const locked = raven.busy || pending !== null;

  const [areaH, setAreaH] = useState(0);
  const size = areaH > 0 ? Math.floor(Math.max(96, Math.min(width - 80, areaH - 40, 300))) : 0;

  // Keyed by mission id, so a dialog left open never pops up again on the next mission.
  const [backupFor, setBackupFor] = useState<number | null>(null);
  const backupOpen = mission != null && backupFor === mission.mission.id;

  // The toast manager changes identity with every toast, so guard on the key, not on effect runs.
  const shownKey = useRef<number | null>(null);
  useEffect(() => {
    if (!completed || shownKey.current === completed.key) return;
    shownKey.current = completed.key;
    notice.done(`Mission ${completed.number} complete`, `done-${completed.key}`);
  }, [completed, notice]);

  const requestBackup = async () => {
    await run("backup", () => raven.requestBackup(), "Backup not requested");
    setBackupFor(null);
  };

  return (
    <View className="flex-1 bg-ink" style={{ paddingTop: insets.top }}>
      <Ambient tone={phase} />
      <Header
        raven={raven}
        locked={locked}
        onDuty={(next) => { void run("toggle", () => raven.setAvailable(next), next ? "Couldn't go on duty" : "Couldn't go off duty"); }}
      />

      <View className="flex-1 items-center justify-center" onLayout={(e) => setAreaH(e.nativeEvent.layout.height)}>
        {size > 0 ? (
          <Animated.View key={phase} entering={FadeIn.duration(FADE_MS)} exiting={FadeOut.duration(FADE_MS)}>
            <Instrument raven={raven} size={size} />
          </Animated.View>
        ) : null}
      </View>

      {/* The cream shell stays put and animates its height; only the content cross-fades inside it. */}
      <Animated.View
        layout={LinearTransition.duration(FADE_MS)}
        style={{ marginHorizontal: EDGE, marginBottom: insets.bottom + EDGE, borderRadius: 36, overflow: "hidden" }}
      >
        <Glass fill radius={36} tint={glassTint.cream} />
        <Animated.View key={phase} entering={FadeIn.duration(FADE_MS)} exiting={FadeOut.duration(FADE_MS)}>
          <PhaseCard
            raven={raven}
            pending={pending}
            locked={locked}
            run={run}
            onBackup={() => mission && setBackupFor(mission.mission.id)}
          />
        </Animated.View>
      </Animated.View>

      <BackupDialog
        isOpen={backupOpen}
        targetName={mission?.target.name ?? "the target"}
        isLoading={pending === "backup"}
        onClose={() => setBackupFor(null)}
        onConfirm={() => { void requestBackup(); }}
      />
    </View>
  );
}
