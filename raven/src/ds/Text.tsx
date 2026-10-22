import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { cn } from "heroui-native";

// Jost's vertical metrics are identical across weights (per em: ascender 1.07, descender 0.375, cap height 0.7).
// In a natural line box the cap top sits 0.37 em below the box top; superscript units align on it.
const CAP_TOP = 0.37;
const DESCENDER = 0.375;

/**
 * A numeral with a raised unit ("46%", "1:40 h"). The numeral's line box is trimmed to cap top..baseline so
 * the unit can align with the top of the digits and siblings space off the digits, not the font padding.
 * Font scaling is off: the metrics math needs the exact sizes, and these figures are large already.
 */
export function Figure({ value, unit, size, unitSize, className, unitClassName, tracking = 0 }: {
  value: string; unit?: string; size: number; unitSize: number; className: string; unitClassName: string; tracking?: number;
}) {
  return (
    <View className="flex-row items-start">
      <Text
        allowFontScaling={false}
        className={className}
        style={{ fontSize: size, letterSpacing: tracking, marginTop: -CAP_TOP * size, marginBottom: -DESCENDER * size }}
      >
        {value}
      </Text>
      {unit ? (
        <Text
          allowFontScaling={false}
          className={unitClassName}
          style={{ fontSize: unitSize, marginTop: -CAP_TOP * unitSize, marginLeft: Math.round(unitSize * 0.15) }}
        >
          {unit}
        </Text>
      ) : null}
    </View>
  );
}

/** The gauge numeral: hairline digits, a superscript unit and a caption, exposed to screen readers as one text. */
export function Display({ value, unit, caption, accessibilityLabel }: { value: string; unit?: string; caption?: string; accessibilityLabel?: string }) {
  const spoken = accessibilityLabel ?? [unit ? `${value} ${unit}` : value, caption].filter(Boolean).join(", ");
  return (
    <View className="items-center" accessible accessibilityRole="text" accessibilityLabel={spoken}>
      <Figure value={value} unit={unit} size={76} unitSize={14} tracking={-1} className="font-hair text-paper" unitClassName="font-normal text-ash" />
      {caption ? <Text maxFontSizeMultiplier={1.4} className="mt-3.5 font-normal text-[11px] text-ash">{caption}</Text> : null}
    </View>
  );
}

const eyebrowTone = { ash: "text-ash", taupe: "text-taupe", ember: "text-ember", paper: "text-paper" } as const;

/** Tiny letter-spaced caps. Decoration only: never the sole carrier of meaning. */
export function Eyebrow({ children, tone = "ash", className }: { children: string; tone?: keyof typeof eyebrowTone; className?: string }) {
  return (
    <Text maxFontSizeMultiplier={1.4} className={cn("font-semibold text-[9px] tracking-[2px] uppercase", eyebrowTone[tone], className)}>
      {children}
    </Text>
  );
}

// Titles come straight from the data (some site names run to five lines at 26 pt), and every extra line is taken from
// the instrument: two lines at most, shrinking to 3/4 size before they truncate.
export function Title({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Text numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.75} maxFontSizeMultiplier={1.3} className={cn("text-center font-semibold text-[26px] text-coal", className)}>
      {children}
    </Text>
  );
}

export function Subtitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Text numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.75} maxFontSizeMultiplier={1.3} className={cn("text-center font-light text-[24px] text-taupe", className)}>
      {children}
    </Text>
  );
}

export function Note({ children, className, numberOfLines }: { children: ReactNode; className?: string; numberOfLines?: number }) {
  return (
    <Text numberOfLines={numberOfLines} maxFontSizeMultiplier={1.5} className={cn("text-center font-normal text-[14px] text-taupe", className)}>
      {children}
    </Text>
  );
}
