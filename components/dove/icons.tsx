// Stroke icons (status is never color alone: safe = shield, need help = triangle).
type P = { size?: number; className?: string; color?: string };

export const ShieldIcon = ({ size = 24, className, color = "currentColor" }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

export const TriangleIcon = ({ size = 24, className, color = "currentColor" }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M12 3.5L21.5 20h-19L12 3.5z" />
    <path d="M12 10v4.5" />
    <path d="M12 17.3v.2" />
  </svg>
);

export const PhoneIcon = ({ size = 24, className, color = "currentColor", down = false }: P & { down?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden style={down ? { transform: "rotate(135deg)" } : undefined}>
    <path d="M5 4h3l2 5-2.5 1.5a11 11 0 005 5L14 13l5 2v3a2 2 0 01-2 2A15 15 0 013 6a2 2 0 012-2z" />
  </svg>
);

export const MicIcon = ({ size = 16, className, color = "currentColor" }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0014 0M12 18v3" />
  </svg>
);
