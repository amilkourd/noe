import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";

// iOS 26 gets native Liquid Glass; older iOS and Android get a blur + tint that reads the same on OLED black.
const LIQUID = isLiquidGlassAvailable();

export const glassTint = {
  cream: "rgba(232,229,221,0.86)", // the card: frosted cream, coal text stays readable
  smoke: "rgba(0,0,0,0.55)",       // dark pills and capsules
  clear: "rgba(255,255,255,0.04)",
} as const;

/** A glass surface. Pass `fill` to use it as an absolute background layer behind sibling content. */
export function Glass({ tint = glassTint.smoke, radius, fill = false, interactive = false, style, children }: {
  tint?: string; radius: number; fill?: boolean; interactive?: boolean; style?: StyleProp<ViewStyle>; children?: ReactNode;
}) {
  const shape: StyleProp<ViewStyle> = [{ borderRadius: radius, overflow: "hidden" }, fill && StyleSheet.absoluteFill, style];
  if (LIQUID) {
    return (
      <GlassView glassEffectStyle="regular" colorScheme="dark" tintColor={tint} isInteractive={interactive} pointerEvents={fill ? "none" : "auto"} style={shape}>
        {children}
      </GlassView>
    );
  }
  return (
    <View pointerEvents={fill ? "none" : "auto"} style={shape}>
      <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: tint, borderRadius: radius }]} />
      <View style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.18)" }]} />
      {children}
    </View>
  );
}
