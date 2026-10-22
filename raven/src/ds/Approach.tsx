import { useEffect, useMemo, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import Svg, { Circle, Defs, Path, RadialGradient, Stop } from "react-native-svg";
import { Eyebrow } from "./Text";
import { color } from "./tokens";

// Blob anchors traced from the reference's second phone, clockwise from north, around the "you" point (0, 0).
// Unit = half the instrument size. The big upper-right lobe is where the knob usually rides.
const ANCHORS: readonly (readonly [number, number])[] = [
  [0, -0.613], [0.318, -0.787], [0.658, -0.785], [0.825, -0.516], [0.79, -0.139], [0.671, 0.18], [0.522, 0.438],
  [0.315, 0.676], [0, 0.777], [-0.368, 0.637], [-0.655, 0.305], [-0.705, -0.062], [-0.513, -0.296], [-0.301, -0.43],
];
const KNOB = 44;
const RIM_GAP = 6; // min clearance between the knob and the rim
const SEG_SAMPLES = 16;
const LABEL_H = 13; // line box of a 9 pt eyebrow
const LABEL_W = 120;
const WINDS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/**
 * Closed Catmull-Rom spline through the anchors, emitted as cubic Béziers (smooth everywhere, no corners), plus a
 * per-degree table of where the knob center sits: 0.72 of the rim radius on that bearing, pulled in until the whole
 * knob clears the rim (the concave upper-left flank is too narrow for 0.72).
 */
function blobGeometry(size: number) {
  const c = size / 2;
  const p = ANCHORS.map(([x, y]) => [c + x * c, c + y * c] as const);
  const n = p.length, f = (v: number) => v.toFixed(2);
  const pts: [number, number][] = [];
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i + n - 1) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
    for (let k = 0; k < SEG_SAMPLES; k++) {
      const t = k / SEG_SAMPLES, u = 1 - t, a = u * u * u, b = 3 * u * u * t, e = 3 * u * t * t, g = t * t * t;
      pts.push([a * p1[0] + b * c1[0] + e * c2[0] + g * p2[0], a * p1[1] + b * c1[1] + e * c2[1] + g * p2[1]]);
    }
  }
  d += "Z";

  // The blob is star-shaped around the center, so sample bearings increase monotonically along the curve.
  const pol = pts.map(([x, y]) => [((Math.atan2(x - c, c - y) * 180) / Math.PI + 360) % 360, Math.hypot(x - c, y - c)] as const);
  const rim: number[] = [];
  for (let deg = 0, j = 0; deg < 360; deg++) {
    while (j < pol.length - 1 && pol[j + 1][0] <= deg) j++;
    const [b0, r0] = pol[j];
    const [b1, r1] = j + 1 < pol.length ? pol[j + 1] : [pol[0][0] + 360, pol[0][1]];
    rim.push(r0 + ((r1 - r0) * (deg - b0)) / (b1 - b0));
  }
  const clear2 = (KNOB / 2 + RIM_GAP) ** 2;
  const knob = rim.map((r, deg) => {
    const a = (deg * Math.PI) / 180, sx = Math.sin(a), sy = -Math.cos(a);
    let dist = 0.72 * r;
    // never closer than the "you" dot
    while (dist > KNOB / 2 + 6 && pts.some(([x, y]) => (x - c - sx * dist) ** 2 + (y - c - sy * dist) ** 2 < clear2)) dist -= 1;
    return dist;
  });
  return { d, knob, glow: 0.75 * c };
}

/**
 * The mission instrument: an organic blob (cocoa core, mauve edge, paper rim) around the rescuer, with compass labels
 * and a knob on the bearing to the target. Pressing it opens navigation.
 */
export function Approach({ size, bearing, active = false, onPress }: { size: number; bearing: number | null; active?: boolean; onPress?: () => void }) {
  const c = size / 2;
  const geo = useMemo(() => blobGeometry(size), [size]);
  const table = geo.knob;

  // Unwrapped degrees, so the knob glides the short way round and follows the blob's contour while it moves.
  const angle = useSharedValue(bearing ?? 0);
  const shown = useRef(bearing !== null);
  useEffect(() => {
    if (bearing === null) { shown.current = false; return; }
    if (!shown.current) { shown.current = true; cancelAnimation(angle); angle.set(bearing); return; }
    const cur = angle.get();
    const delta = ((((bearing - cur) % 360) + 540) % 360) - 180;
    angle.set(withTiming(cur + delta, { duration: 500, easing: Easing.out(Easing.cubic) }));
  }, [bearing, angle]);

  const breath = useSharedValue(1);
  useEffect(() => {
    if (!active) { breath.set(withTiming(1, { duration: 200 })); return; }
    // settle to 1 first: a reversed repeat swings back to its start value, and a breath restarted before the settle
    // above finished would keep a shrunken range
    breath.set(withSequence(
      withTiming(1, { duration: 150 }),
      withRepeat(withTiming(1.06, { duration: 800, easing: Easing.inOut(Easing.sin) }), -1, true),
    ));
    return () => cancelAnimation(breath);
  }, [active, breath]);

  const knobStyle = useAnimatedStyle(() => {
    const a = ((angle.get() % 360) + 360) % 360;
    const i = Math.floor(a) % 360, t = a - Math.floor(a);
    const dist = table[i] * (1 - t) + table[(i + 1) % 360] * t;
    const rad = (a * Math.PI) / 180;
    return { transform: [{ translateX: Math.sin(rad) * dist }, { translateY: -Math.cos(rad) * dist }, { scale: breath.get() }] };
  });

  const where = bearing === null ? "Target bearing unknown" : `Target to the ${WINDS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]}`;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel="Navigate to target"
      accessibilityValue={{ text: where }}
      style={({ pressed }) => ({ width: size, height: size, opacity: pressed ? 0.85 : 1 })}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id="blob" cx={c} cy={c} r={geo.glow} gradientUnits="userSpaceOnUse">
              <Stop offset={0} stopColor={color.cocoa} />
              <Stop offset={0.25} stopColor={color.cocoa} />
              <Stop offset={1} stopColor={color.mauve} />
            </RadialGradient>
          </Defs>
          <Path d={geo.d} fill="url(#blob)" stroke={color.paper} strokeOpacity={0.85} strokeWidth={1.5} />
          <Circle cx={c} cy={c} r={3} fill={color.ash} />
        </Svg>
        <View className="absolute inset-x-0 top-0 items-center"><Eyebrow tone="paper">North</Eyebrow></View>
        <View className="absolute inset-x-0 bottom-0 items-center"><Eyebrow tone="paper">South</Eyebrow></View>
        <View style={[styles.side, { left: LABEL_H / 2 - LABEL_W / 2, top: c - LABEL_H / 2, transform: [{ rotate: "-90deg" }] }]}>
          <Eyebrow tone="paper">West</Eyebrow>
        </View>
        <View style={[styles.side, { left: size - LABEL_H / 2 - LABEL_W / 2, top: c - LABEL_H / 2, transform: [{ rotate: "90deg" }] }]}>
          <Eyebrow tone="paper">East</Eyebrow>
        </View>
      </View>
      {bearing !== null ? (
        <Animated.View pointerEvents="none" style={[styles.knob, { left: c - KNOB / 2, top: c - KNOB / 2 }, knobStyle]}>
          <View style={styles.knobDot} />
        </Animated.View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // wide box rotated about its own center, so the label never wraps before it turns
  side: { position: "absolute", width: LABEL_W, height: LABEL_H, alignItems: "center", justifyContent: "center" },
  knob: {
    position: "absolute", width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: color.paper,
    alignItems: "center", justifyContent: "center",
    shadowColor: color.ink, shadowOpacity: 0.5, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },
  knobDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.ink },
});
