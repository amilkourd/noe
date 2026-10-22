import { useEffect, useMemo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import Svg, { Line, Path } from "react-native-svg";
import { color } from "./tokens";

const TAIL = 7; // lit ticks, ending at the head
const IDLE = { len: 12, width: 1.5 };
const HEAD = { len: 24, width: 4 };
const TURN_MS = 2400;

/** Opaque blend of `fg` over `bg`: a lit tick must fully hide the idle tick under it, which a translucent stroke would not. */
function mix(bg: string, fg: string, t: number) {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(ch(bg, i) + (ch(fg, i) - ch(bg, i)) * t).toString(16).padStart(2, "0")).join("");
}

/** Point at `deg` (0 = top, clockwise) and radius `r` around (c, c). */
function polar(c: number, r: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  return { x: c + Math.sin(a) * r, y: c - Math.cos(a) * r };
}

/**
 * Ring of radial ticks with a bright tapered "head" (the espresso extraction gauge). The idle ring is one static path;
 * the lit tail is drawn once around the top and rotated on the UI thread, snapped to whole ticks so it always lands
 * exactly on the idle ticks. "sweep" turns it continuously (indeterminate wait) and ignores `progress`.
 * The ring assumes the ink background (the tail colors are pre-blended over it).
 */
export function TickRing({ size, progress = 0, tone = "paper", mode = "static", ticks = 60, children, accessibilityLabel }: {
  size: number; progress?: number; tone?: "paper" | "ember"; mode?: "static" | "sweep"; ticks?: number; children?: ReactNode; accessibilityLabel?: string;
}) {
  const c = size / 2;
  const r = c - HEAD.width / 2; // outer end of every tick: round caps then reach the edge exactly
  const step = 360 / ticks;
  const lit = tone === "ember" ? color.ember : color.paper;

  const ring = useMemo(() => {
    let d = "";
    for (let i = 0; i < ticks; i++) {
      const a = polar(c, r, i * step), b = polar(c, r - IDLE.len, i * step);
      d += `M${a.x.toFixed(2)} ${a.y.toFixed(2)}L${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
    }
    return d;
  }, [c, r, step, ticks]);

  const tail = useMemo(() => Array.from({ length: TAIL }, (_, i) => {
    const t = i / (TAIL - 1), deg = (i - (TAIL - 1)) * step;
    return {
      a: polar(c, r, deg),
      b: polar(c, r - (IDLE.len + (HEAD.len - IDLE.len) * t), deg),
      width: IDLE.width + (HEAD.width - IDLE.width) * t,
      stroke: mix(color.ink, lit, 0.35 + 0.65 * t),
    };
  }), [c, r, step, lit]);

  const target = Math.min(1, Math.max(0, progress)) * 360;
  const angle = useSharedValue(mode === "sweep" ? 0 : target);
  useEffect(() => {
    const cur = angle.get();
    if (mode === "sweep") {
      angle.set(withRepeat(withTiming(cur + 360, { duration: TURN_MS, easing: Easing.linear }), -1, false));
    } else {
      // shortest way round, so leaving a sweep or wrapping past the top never spins the head backwards a full turn
      const delta = ((((target - cur) % 360) + 540) % 360) - 180;
      angle.set(withTiming(cur + delta, { duration: 700, easing: Easing.out(Easing.cubic) }));
    }
    return () => cancelAnimation(angle);
  }, [mode, target, angle]);

  const head = useAnimatedStyle(() => ({ transform: [{ rotate: `${Math.round(angle.get() / step) * step}deg` }] }));

  return (
    <View
      style={{ width: size, height: size }}
      accessible={!!accessibilityLabel}
      accessibilityRole={accessibilityLabel ? "text" : undefined}
      accessibilityLabel={accessibilityLabel}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Svg width={size} height={size}>
          <Path d={ring} stroke={color.tick} strokeWidth={IDLE.width} strokeLinecap="round" fill="none" />
        </Svg>
      </View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, head]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Svg width={size} height={size}>
          {tail.map((t, i) => (
            <Line key={i} x1={t.a.x} y1={t.a.y} x2={t.b.x} y2={t.b.y} stroke={t.stroke} strokeWidth={t.width} strokeLinecap="round" />
          ))}
        </Svg>
      </Animated.View>
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill} className="items-center justify-center">{children}</View>
    </View>
  );
}
