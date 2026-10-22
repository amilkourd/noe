// Pure geo / math / time helpers shared by NOÉ's agent modules (no DB, no fs).

export interface LatLon { lat: number; lon: number }

const R = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** (Weighted) least squares y = a*x + b. Returns r2 = squared (weighted) Pearson correlation. */
export function linreg(xs: number[], ys: number[], ws?: number[]): { a: number; b: number; r2: number; n: number } {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { a: 0, b: n ? ys[0] : 0, r2: 0, n };
  const w = (i: number) => (ws ? ws[i] : 1);
  let sx = 0, sy = 0, sw = 0;
  for (let i = 0; i < n; i++) { sx += w(i) * xs[i]; sy += w(i) * ys[i]; sw += w(i); }
  const mx = sx / sw, my = sy / sw;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += w(i) * dx * dx; sxy += w(i) * dx * dy; syy += w(i) * dy * dy;
  }
  if (sxx === 0) return { a: 0, b: my, r2: 0, n };
  const a = sxy / sxx;
  const b = my - a * mx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { a, b, r2, n };
}

/** HH:mm in Europe/Paris. */
export function parisHHmm(t: string | Date | number | null | undefined): string {
  if (t === null || t === undefined) return "--:--";
  const d = t instanceof Date ? t : new Date(t);
  if (isNaN(d.getTime())) return "--:--";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

/** "DD HH:mm" in Europe/Paris (for logs spanning midnight). */
export function parisDayHHmm(t: string | Date | number): string {
  const d = t instanceof Date ? t : new Date(t);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", day: "2-digit" }).format(d);
  return `${day} ${parisHHmm(d)}`;
}

export const MIN = 60_000;

/** Short display distance: "900 m" / "2.4 km". */
export function fmtDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 50) * 50} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** Point-to-segment distance in metres (equirectangular, fine at this scale). */
export function pointSegDistM(p: LatLon, a: LatLon, b: LatLon): number {
  const kx = Math.cos(toRad(p.lat)) * 111320, ky = 110540;
  const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
  t = clamp(t, 0, 1);
  const x = ax + t * dx, y = ay + t * dy;
  return Math.sqrt(x * x + y * y);
}
