"use client";

import { useEffect, useRef } from "react";

/**
 * Dot-matrix ring: dots on concentric circles, teal, with a wave travelling outward.
 * mode: "idle" (slow, faint), "ringing" (fast, bright pulse), "call" (breathing, driven by `level` 0..1).
 */
export function DotRing({ mode, level = 0, size = 280 }: { mode: "idle" | "ringing" | "call"; level?: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  levelRef.current = level;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    c.width = size * dpr; c.height = size * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const cx = size / 2, cy = size / 2;
    const spacing = 12;
    const rings: { r: number; n: number; k: number }[] = [];
    for (let k = 0, r = 22; r < size / 2 - 4; k++, r += spacing) rings.push({ r, n: Math.max(8, Math.round((2 * Math.PI * r) / 11)), k });

    let raf = 0;
    const t0 = performance.now();
    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, size, size);
      const speed = mode === "ringing" ? 2.2 : mode === "call" ? 0.9 : 0.35;
      const base = mode === "ringing" ? 0.16 : mode === "call" ? 0.14 : 0.1;
      const amp = mode === "ringing" ? 0.85 : mode === "call" ? 0.35 + 0.55 * Math.min(1, levelRef.current * 2.5) : 0.35;
      for (const ring of rings) {
        // wave position in ring units, travelling outward
        const phase = ring.k - t * speed * 2.2;
        const w = Math.max(0, Math.cos(phase * 0.9));
        const wave = Math.pow(w, mode === "ringing" ? 6 : 3);
        const fade = 1 - ring.k / (rings.length + 1);
        const alpha = Math.min(1, (base + amp * wave) * (0.45 + 0.55 * fade));
        const rad = 1.5 + wave * (mode === "ringing" ? 1.3 : 0.7);
        ctx.fillStyle = `rgba(63,209,166,${alpha.toFixed(3)})`;
        for (let i = 0; i < ring.n; i++) {
          const a = (i / ring.n) * Math.PI * 2 + ring.k * 0.21;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * ring.r, cy + Math.sin(a) * ring.r, rad, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // centre dot
      ctx.fillStyle = mode === "idle" ? "rgba(63,209,166,0.55)" : "rgba(166,240,214,0.95)";
      ctx.beginPath(); ctx.arc(cx, cy, mode === "idle" ? 4 : 6, 0, Math.PI * 2); ctx.fill();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [mode, size]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{ width: size, height: size, filter: "drop-shadow(0 0 40px rgba(63,209,166,0.18))" }}
    />
  );
}
