import { View } from "react-native";
import { Button, cn, Spinner } from "heroui-native";
import { Glass } from "./Glass";
import { color } from "./tokens";

const look = {
  primary: { variant: "primary", root: "bg-transparent", label: "text-paper", spinner: color.paper },
  secondary: { variant: "outline", root: "border-[1.5px] border-pill bg-transparent", label: "text-coal", spinner: color.coal },
  danger: { variant: "danger", root: "bg-ember", label: "text-coal", spinner: color.coal },
} as const;

/**
 * The card's pill button (56 pt). While loading, the label keeps its place (invisible) under a spinner, so the pill
 * does not change width, and presses are ignored without dimming it like a disabled button.
 */
export function ActionButton({ label, onPress, variant = "primary", block = false, isLoading = false, isDisabled = false }: {
  label: string; onPress: () => void; variant?: keyof typeof look; block?: boolean; isLoading?: boolean; isDisabled?: boolean;
}) {
  const l = look[variant];
  const button = (
    <Button
      variant={l.variant}
      size="lg"
      className={cn("h-14 overflow-hidden rounded-full px-8", l.root, block && "self-stretch")}
      onPress={isLoading ? undefined : onPress}
      isDisabled={isDisabled}
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: isLoading }}
    >
      <Button.Label maxFontSizeMultiplier={1.3} className={cn("font-normal text-[18px]", l.label, isLoading && "opacity-0")}>{label}</Button.Label>
      {isLoading ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <Spinner size="sm" color={l.spinner} />
        </View>
      ) : null}
    </Button>
  );
  if (variant !== "primary") return button;
  // smoked glass behind the pill: HeroUI's own `background` slot needs its internal context, so it is layered here
  return (
    <View className={cn("rounded-full", block && "self-stretch")}>
      <Glass fill radius={28} tint="rgba(0,0,0,0.82)" />
      {button}
    </View>
  );
}
