// Thin-stroke icons for ARK (1.5px, currentColor).
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
      {children}
    </svg>
  );
}

export const PlayIcon = (p: P) => <Svg {...p}><path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none" /></Svg>;
export const PauseIcon = (p: P) => <Svg {...p}><path d="M8.5 5.5v13M15.5 5.5v13" strokeWidth={2.2} /></Svg>;
export const ResetIcon = (p: P) => <Svg {...p}><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4.5V9h4.5" /></Svg>;
export const PlusIcon = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const MinusIcon = (p: P) => <Svg {...p}><path d="M5 12h14" /></Svg>;
export const LocateIcon = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="6.5" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" /></Svg>;
export const CubeIcon = (p: P) => <Svg {...p}><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z M4 7.5 12 12l8-4.5M12 12v9" /></Svg>;
export const WavesIcon = (p: P) => <Svg {...p}><path d="M3 9c2 0 2-1.5 4.5-1.5S9.5 9 12 9s2.5-1.5 4.5-1.5S19 9 21 9M3 15c2 0 2-1.5 4.5-1.5S9.5 15 12 15s2.5-1.5 4.5-1.5S19 15 21 15" /></Svg>;
export const ArrowUpRightIcon = (p: P) => <Svg {...p}><path d="M7 17 17 7M9 7h8v8" /></Svg>;
export const CloseIcon = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>;
export const SparkIcon = (p: P) => <Svg {...p}><path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7z" /></Svg>;
export const PhoneIcon = (p: P) => <Svg {...p}><path d="M6.5 3.5h3l1.5 4-2 1.3a10 10 0 0 0 6.2 6.2l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16 16 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z" /></Svg>;

/** Filled warning triangle for lists (colour via currentColor). */
export function TriangleGlyph({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 22" className={`ark-tri ${className}`} aria-hidden>
      <path d="M12 2 L22.5 20 H1.5 Z" />
    </svg>
  );
}

/** ARK brand mark: three stacked hull lines. */
export function ArkMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
      <path d="M3 9.5c3 2.4 15 2.4 18 0M5 14c2.6 2 11.4 2 14 0M7.5 18.3c2 1.2 7 1.2 9 0" />
      <path d="M12 3v6" />
    </svg>
  );
}
