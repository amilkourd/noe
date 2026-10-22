import { useEffect } from "react";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { color } from "./tokens";

const look = {
  online: { fill: color.paper, label: "Online", blinkMs: 0 },
  offline: { fill: color.ember, label: "Offline", blinkMs: 500 },
  connecting: { fill: color.ash, label: "Connecting", blinkMs: 800 },
} as const;

/** 6 pt connection dot: steady when online, blinking otherwise (faster when offline). */
export function LiveDot({ state }: { state: keyof typeof look }) {
  const { fill, label, blinkMs } = look[state];
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (!blinkMs) { opacity.set(withTiming(1, { duration: 200 })); return; }
    // A reversed repeat swings back to the value it started from, not to 1: restart from full opacity, or a blink
    // restarted mid-fade (connecting -> offline) would stay faint.
    opacity.set(withSequence(
      withTiming(1, { duration: 0 }),
      withRepeat(withTiming(0.2, { duration: blinkMs, easing: Easing.inOut(Easing.quad) }), -1, true),
    ));
    return () => cancelAnimation(opacity);
  }, [blinkMs, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <Animated.View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={[{ width: 6, height: 6, borderRadius: 3, backgroundColor: fill }, style]}
    />
  );
}
