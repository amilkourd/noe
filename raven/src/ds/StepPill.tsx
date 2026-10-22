import { Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { cn } from "heroui-native";
import { Glass } from "./Glass";
import { color } from "./tokens";

// Jost has no check glyph (U+2713 falls back to the system font), so it is drawn, sized like Jost's "+".
function Check() {
  return (
    <Svg width={14} height={14} viewBox="0 0 14 14">
      <Path d="M2.75 7.5 5.75 10.25 11.25 3.75" fill="none" stroke={color.sage} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/**
 * The "1x + +" segment of the reference: a dark pill of 44 pt circles, one per step.
 * Done steps show a sage check, the current one a lit circle with its number, later ones a faint plus.
 */
export function StepPill({ steps, current, className }: { steps: string[]; current: number; className?: string }) {
  const n = steps.length;
  const label = current < n ? `Step ${current + 1} of ${n}: ${steps[current]}` : `All ${n} steps done`;
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} className={cn("h-14 flex-row items-center gap-3 rounded-full px-1.5", className)}>
      <Glass fill radius={28} tint="rgba(0,0,0,0.82)" />
      {steps.map((step, i) => (
        <View key={step + i} className={cn("size-11 items-center justify-center rounded-full", i === current && "bg-pill-active")}>
          {i < current ? <Check />
            : i === current ? <Text allowFontScaling={false} className="font-normal text-[16px] text-paper">{i + 1}</Text>
            : <Text allowFontScaling={false} className="font-light text-[20px] text-pill-faint">+</Text>}
        </View>
      ))}
    </View>
  );
}
