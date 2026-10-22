import { Children, type ReactNode } from "react";
import { Text, View } from "react-native";
import { Figure } from "./Text";

const dotTone = { water: "bg-water", ember: "bg-ember", sage: "bg-sage" } as const;

/**
 * A light numeral with a superscript unit and a small label under it ("15 ml / Espresso"). Spoken as "{label}: {value} {unit}"
 * unless `accessibilityLabel` gives a better reading (countdowns like "1:40 h").
 */
export function Stat({ value, unit, label, dot, accessibilityLabel }: {
  value: string; unit?: string; label: string; dot?: keyof typeof dotTone; accessibilityLabel?: string;
}) {
  return (
    <View className="items-center" accessible accessibilityRole="text" accessibilityLabel={accessibilityLabel ?? `${label}: ${unit ? `${value} ${unit}` : value}`}>
      <Figure value={value} unit={unit} size={30} unitSize={11} className="font-light text-coal" unitClassName="font-normal text-taupe" />
      <View className="mt-2.5 flex-row items-center gap-1.5">
        {dot ? <View className={`size-1.5 rounded-full ${dotTone[dot]}`} /> : null}
        <Text maxFontSizeMultiplier={1.4} className="font-medium text-[11px] text-coal">{label}</Text>
      </View>
    </View>
  );
}

/** Two or three stats on equal-width columns, so their centers are evenly spaced across the card. */
export function StatRow({ children }: { children: ReactNode }) {
  return (
    <View className="flex-row self-stretch px-4">
      {Children.toArray(children).map((child, i) => <View key={i} className="flex-1 items-center">{child}</View>)}
    </View>
  );
}
