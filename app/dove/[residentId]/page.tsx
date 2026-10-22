import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import DoveCall from "@/components/dove/DoveCall";

export const metadata: Metadata = {
  title: "Noé · Flood line",
  description: "Town of Sommières flood alert line (demo)",
};

export const viewport: Viewport = {
  themeColor: "#0E0F11",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

type Params = Promise<{ residentId: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

// cacheComponents is on: runtime params/searchParams must be read inside <Suspense>.
export default function DovePage({ params, searchParams }: { params: Params; searchParams: Search }) {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-noe-bg" />}>
      <DoveRoute params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function DoveRoute({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { residentId } = await params;
  const sp = await searchParams;
  const demo = sp.demo === "1" || sp.demo === "true";
  return <DoveCall residentId={decodeURIComponent(residentId)} demo={demo} />;
}
