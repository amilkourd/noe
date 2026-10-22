import { Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { cn, Switch } from "heroui-native";
import { Glass, glassTint } from "./Glass";
import { color } from "./tokens";

/** On/off duty switch: a 64×34 ink track whose 28 pt thumb carries its own tiny ON / OFF label. */
export function DutyToggle({ isOn, onChange, isDisabled = false }: { isOn: boolean; onChange: (next: boolean) => void; isDisabled?: boolean }) {
  return (
    <View>
    <Glass fill radius={17} tint={glassTint.clear} />
    <Switch
      isSelected={isOn}
      isDisabled={isDisabled}
      onSelectedChange={(next) => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onChange(next);
      }}
      className="h-[34px] w-16"
      animation={{ backgroundColor: { value: ["transparent", "transparent"] } }}
      accessibilityLabel="On duty"
      hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
    >
      <Switch.Thumb className="size-7" animation={{ left: { value: 3 }, backgroundColor: { value: [color.pillActive, color.paper] } }}>
        <Text allowFontScaling={false} className={cn("font-semibold text-[8px] tracking-[0.5px]", isOn ? "text-coal" : "text-ash")}>
          {isOn ? "ON" : "OFF"}
        </Text>
      </Switch.Thumb>
    </Switch>
    </View>
  );
}
