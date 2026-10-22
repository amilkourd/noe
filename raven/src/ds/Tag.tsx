import type { ReactNode } from "react";
import { View } from "react-native";
import { Chip, cn } from "heroui-native";

/**
 * Outlined capsule for mobility needs and hazards. Read-only: a HeroUI Chip exposed as plain text.
 * Tags carry safety information that appears nowhere else, so the text is always coal at a readable size (ember text
 * on cream is only 2.3:1). A hazard (tone "ember") is marked by an ember border and dot, and spoken as "Hazard: …".
 */
export function Tag({ label, tone = "coal" }: { label: string; tone?: "coal" | "ember" }) {
  const ember = tone === "ember";
  return (
    <Chip
      variant="tertiary"
      size="sm"
      animation="disable-all"
      accessibilityRole="text"
      accessibilityLabel={ember ? `Hazard: ${label}` : label}
      className={cn("gap-1.5 rounded-full border bg-transparent px-2.5 py-1", ember ? "border-ember" : "border-cream-line")}
    >
      {ember ? <View className="size-1.5 rounded-full bg-ember" /> : null}
      <Chip.Label maxFontSizeMultiplier={1.4} className="font-medium text-[11px] leading-[15px] tracking-[1px] uppercase text-coal">
        {label}
      </Chip.Label>
    </Chip>
  );
}

export function TagRow({ children }: { children: ReactNode }) {
  return <View className="flex-row flex-wrap justify-center gap-1.5 self-stretch">{children}</View>;
}
