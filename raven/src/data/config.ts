import Constants from "expo-constants";

// Expo inlines EXPO_PUBLIC_* only on static property access, so no destructuring or dynamic keys here.
export const RESCUER_ID: string = process.env.EXPO_PUBLIC_RESCUER_ID?.trim() || "rb-karim";
export const DEMO: boolean = process.env.EXPO_PUBLIC_RAVEN_DEMO === "1";
// Off by default: a real position outside the Vidourle perimeter would hide the alert.
export const SEND_GPS: boolean = process.env.EXPO_PUBLIC_RAVEN_GPS === "1";

/** In development hostUri is the Metro address ("192.168.0.188:8082"); NOÉ runs on the same machine, port 3000. */
function devServerUrl(): string | null {
  const hostUri = Constants.expoConfig?.hostUri;
  if (!hostUri) return null;
  const host = hostUri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0].replace(/:\d+$/, "");
  return host ? `http://${host}:3000` : null;
}

// The hosted web build sits behind a proxy that forwards /api to NOÉ: same origin, so no CORS.
const SAME_ORIGIN = process.env.EXPO_PUBLIC_NOE_SAME_ORIGIN === "1";

export const NOE_URL: string = SAME_ORIGIN
  ? ""
  : (process.env.EXPO_PUBLIC_NOE_URL?.trim() || devServerUrl() || "http://localhost:3000").replace(/\/+$/, "");
