import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, { Easing, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { color } from "./tokens";

export type AmbientTone = "connecting" | "calm" | "alert" | "standby" | "mission";

type Glow = { cx: string; cy: string; r: string; c: string; o: number };

// Soft light pooled on OLED black: it is what the glass refracts. Ember only when there is danger.
const GLOWS: Record<AmbientTone, Glow[]> = {
  connecting: [{ cx: "50%", cy: "36%", r: "50%", c: color.ash, o: 0.16 }],
  calm: [{ cx: "50%", cy: "36%", r: "58%", c: color.mauve, o: 0.5 }, { cx: "88%", cy: "92%", r: "46%", c: color.water, o: 0.22 }],
  alert: [{ cx: "50%", cy: "38%", r: "60%", c: color.ember, o: 0.42 }, { cx: "10%", cy: "95%", r: "50%", c: color.mauve, o: 0.35 }],
  standby: [{ cx: "50%", cy: "36%", r: "58%", c: color.mauve, o: 0.45 }, { cx: "90%", cy: "90%", r: "45%", c: color.ember, o: 0.2 }],
  mission: [{ cx: "60%", cy: "30%", r: "58%", c: color.mauve, o: 0.55 }, { cx: "12%", cy: "88%", r: "48%", c: color.water, o: 0.28 }],
};

export function Ambient({ tone }: { tone: AmbientTone }) {
  const drift = useSharedValue(0);
  useEffect(() => {
    drift.value = withRepeat(withTiming(1, { duration: 7000, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, [drift]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: drift.value * 18 - 9 }, { scale: 1 + drift.value * 0.04 }] }));
  const glows = GLOWS[tone];
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Animated.View key={tone} entering={FadeIn.duration(600)} exiting={FadeOut.duration(600)} style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%">
          <Defs>
            {glows.map((g, i) => (
              <RadialGradient key={i} id={`glow${i}`} cx={g.cx} cy={g.cy} r={g.r} gradientUnits="userSpaceOnUse">
                <Stop offset="0" stopColor={g.c} stopOpacity={g.o} />
                <Stop offset="1" stopColor={g.c} stopOpacity={0} />
              </RadialGradient>
            ))}
          </Defs>
          {glows.map((_, i) => <Rect key={i} x="0" y="0" width="100%" height="100%" fill={`url(#glow${i})`} />)}
        </Svg>
      </Animated.View>
    </Animated.View>
  );
}
