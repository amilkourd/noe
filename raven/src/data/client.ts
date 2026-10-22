// NOÉ API for this rescuer, over HTTP or against the scripted in-app backend (EXPO_PUBLIC_RAVEN_DEMO=1).
import type { MissionStatus, RavenView } from "./types";
import { DEMO, NOE_URL, RESCUER_ID } from "./config";
import { demoClient } from "./demo";

export interface RavenClient {
  getView(signal?: AbortSignal): Promise<RavenView>;
  setAvailable(available: boolean, pos?: { lat: number; lon: number } | null): Promise<void>;
  setMissionStatus(missionId: number, status: MissionStatus): Promise<void>;
}

const TIMEOUT_MS = 4000;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

async function call(method: "GET" | "PATCH", path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  // RN has no AbortSignal.any/timeout: one controller, aborted by the timer or by the caller's signal
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, TIMEOUT_MS);
  const forward = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener("abort", forward);
  try {
    const res = await fetch(NOE_URL + path, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: method === "GET" ? "no-store" : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: a proxy or HTML error page, reported by status below
    }
    if (!res.ok) throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : `NOÉ answered HTTP ${res.status}`);
    return data;
  } catch (err) {
    if (timedOut) throw new Error(`NOÉ did not answer within ${TIMEOUT_MS / 1000} s`);
    if (signal?.aborted) throw err;
    if (err instanceof TypeError) throw new Error(`Cannot reach NOÉ at ${NOE_URL}`); // RN: "Network request failed"
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

const httpClient: RavenClient = {
  async getView(signal) {
    const data = await call("GET", `/api/raven/${encodeURIComponent(RESCUER_ID)}`, undefined, signal);
    // something else may listen on :3000; fail loudly instead of rendering garbage
    if (!isRecord(data) || !isRecord(data.clock) || !isRecord(data.rescuer)) throw new Error(`Unexpected response from ${NOE_URL}`);
    return data as unknown as RavenView;
  },
  async setAvailable(available, pos) {
    await call("PATCH", `/api/rescuers/${encodeURIComponent(RESCUER_ID)}`, pos ? { available, lat: pos.lat, lon: pos.lon } : { available });
  },
  async setMissionStatus(missionId, status) {
    await call("PATCH", `/api/missions/${missionId}`, { status });
  },
};

export const client: RavenClient = DEMO ? demoClient : httpClient;
