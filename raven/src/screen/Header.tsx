import { View } from "react-native";
import { DutyToggle, Eyebrow, Glass, glassTint, LiveDot } from "../ds";
import { parisClock } from "../data/format";
import type { RavenView } from "../data/types";
import type { Raven } from "../data/useRaven";

function status(view: RavenView | null, online: boolean): string {
  if (!view) return online ? "RAVEN · CONNECTING" : "RAVEN · OFFLINE";
  const { simTime, mode, speed, running } = view.clock;
  const state = !online ? "OFFLINE" : !running ? `${mode} PAUSED` : speed === 1 ? mode : `${mode} ×${speed}`;
  return `${parisClock(simTime)} · ${state}`;
}

export function Header({ raven, locked, onDuty }: { raven: Raven; locked: boolean; onDuty: (next: boolean) => void }) {
  const { view, online, phase } = raven;
  const live = !online ? "offline" : view ? "online" : "connecting";
  const text = status(view, online);
  return (
    <View className="h-11 flex-row items-center justify-between px-4">
      <View className="h-[34px] flex-row items-center gap-2 px-3.5" accessible accessibilityLabel={`${live === "online" ? "Connected" : live === "offline" ? "Offline" : "Connecting"}. ${text}`}>
        <Glass fill radius={17} tint={glassTint.clear} />
        <LiveDot state={live} />
        <Eyebrow tone="ash">{text}</Eyebrow>
      </View>
      <DutyToggle isOn={view?.rescuer.available ?? false} onChange={onDuty} isDisabled={locked || phase === "connecting"} />
    </View>
  );
}
