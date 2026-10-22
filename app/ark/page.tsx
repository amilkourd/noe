import type { Metadata, Viewport } from "next";
import ArkApp from "@/components/ark/ArkApp";

export const metadata: Metadata = {
  title: "Noé · ARK",
  description: "ARK: flood incident command for Sommières (demo)",
};

export const viewport: Viewport = {
  themeColor: "#0E0F11",
  width: "device-width",
  initialScale: 1,
};

export default function ArkPage() {
  return <ArkApp />;
}
