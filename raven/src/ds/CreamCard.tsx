import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { Card } from "heroui-native";
import { Eyebrow } from "./Text";

const PAD_X = 24; // px-6
const CORNER_RIGHT = 20; // right-5
const CORNER_GAP = 8;

/**
 * The cream card at the bottom of the screen. Content is stacked and centered; `corner` (e.g. the BACKUP text button)
 * is pinned top-right in a 44 pt row centered on the eyebrow line, so a text button there keeps a full hit target.
 * The eyebrow stays centered on the card and is inset by the corner's measured width on both sides, so at large text
 * sizes it wraps instead of running under the corner.
 */
export function CreamCard({ eyebrow, eyebrowTone = "taupe", corner, children }: {
  eyebrow?: string; eyebrowTone?: "taupe" | "ember"; corner?: ReactNode; children: ReactNode;
}) {
  const [cornerW, setCornerW] = useState(0);
  const inset = corner ? Math.max(0, cornerW + CORNER_GAP - (PAD_X - CORNER_RIGHT)) : 0;
  return (
    <Card className="rounded-[36px] bg-transparent px-6 pb-6 pt-7">
      {eyebrow ? (
        <Card.Header className="mb-3 items-center" style={{ paddingHorizontal: inset }}>
          <Eyebrow tone={eyebrowTone} className="text-center">{eyebrow}</Eyebrow>
        </Card.Header>
      ) : null}
      <Card.Body className="items-center self-stretch">{children}</Card.Body>
      {corner ? (
        <View className="absolute right-5 top-3 h-11 justify-center" onLayout={(e) => setCornerW(e.nativeEvent.layout.width)}>
          {corner}
        </View>
      ) : null}
    </Card>
  );
}
