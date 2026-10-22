import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { Approach, Display, TickRing } from "../ds";
import { bearing, countdown, distance, parisClock, rescuerPosition, spokenCountdown } from "../data/format";
import { openDirections } from "../data/maps";
import type { Raven } from "../data/useRaven";

const CAPTION_H = 28; // mission caption under the blob (mt-3 + one 11 pt line), taken out of the gauge size

// The gauge numeral alone ("1:40") reads badly in VoiceOver.
function overflowLabel(c: { value: string; unit: string }): string {
  const s = spokenCountdown(c);
  return s === "now" ? "Overflow now" : s ? `${s} until overflow` : "Overflow time unknown";
}

// The display numerals are a fixed 76 pt: shrink the face with the ring on short screens.
function Face({ size, children }: { size: number; children: ReactNode }) {
  return <View style={{ transform: [{ scale: Math.min(1, size / 260) }] }}>{children}</View>;
}

export function Instrument({ raven, size }: { raven: Raven; size: number }) {
  const { phase, view } = raven;

  if (!view) {
    return (
      <TickRing size={size} mode="sweep" accessibilityLabel="No signal from NOÉ">
        <Face size={size}><Display value="—" caption="No signal" /></Face>
      </TickRing>
    );
  }

  const now = view.clock.simTime;
  const m = view.mission;
  if (phase === "mission" && m) {
    const from = rescuerPosition(view.rescuer);
    const to = { lat: m.target.lat, lon: m.target.lon };
    const d = distance(m.distanceM);
    return (
      <View className="items-center">
        <Approach
          size={size - CAPTION_H}
          bearing={from ? bearing(from, to) : null}
          active={m.mission.status === "en_route"}
          onPress={() => openDirections(to.lat, to.lon, m.target.name)}
        />
        <Text className="mt-3 font-normal text-[11px] text-ash" maxFontSizeMultiplier={1.3} numberOfLines={1}>
          {`${d.value} ${d.unit} · ${m.etaMin} min · Tap to navigate`}
        </Text>
      </View>
    );
  }

  const a = view.alert;
  if ((phase === "alert" || phase === "standby") && a) {
    const c = countdown(a.overflowEta, now);
    const standby = phase === "standby";
    return (
      <TickRing
        size={size}
        tone={standby ? "paper" : "ember"}
        mode={standby ? "sweep" : "static"}
        progress={a.confidence}
        accessibilityLabel={standby ? `Awaiting dispatch. ${overflowLabel(c)}` : overflowLabel(c)}
      >
        <Face size={size}>
          <Display value={c.value} unit={c.unit || undefined} caption={standby ? "Awaiting dispatch" : "Until overflow"} />
        </Face>
      </TickRing>
    );
  }

  // calm: the ring is the minute hand of the sim clock
  const t = new Date(now);
  const minute = (t.getUTCMinutes() + t.getUTCSeconds() / 60) / 60;
  const clock = parisClock(now);
  return (
    <TickRing size={size} progress={Number.isFinite(minute) ? minute : 0} accessibilityLabel={`${clock} in Paris, all clear`}>
      <Face size={size}><Display value={clock} caption="Paris · all clear" /></Face>
    </TickRing>
  );
}
