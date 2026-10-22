// Realtime bus: Postgres LISTEN noe_events -> in-process EventEmitter -> SSE (/api/stream).
// In-memory events (clock ticks, flood, reset) are emitted on the same bus via emitEvent().
// Every "event" emission carries a JSON string payload (same shape as NoeEvent).
import { Client } from "pg";
import { EventEmitter } from "events";
import type { NoeEvent } from "./types";
import { hasDb, pgConfig } from "./db";

const g = globalThis as unknown as {
  __noeBus?: EventEmitter;
  __noeListening?: boolean;
  __noeListenClient?: Client | null;
  __noeListenRetry?: ReturnType<typeof setInterval> | null;
};

export const bus: EventEmitter = g.__noeBus ?? (g.__noeBus = new EventEmitter());
bus.setMaxListeners(500);

export function emitEvent(e: NoeEvent): void {
  bus.emit("event", JSON.stringify(e));
}

function scheduleReconnect() {
  if (g.__noeListenRetry) return;
  g.__noeListenRetry = setTimeout(() => {
    g.__noeListenRetry = null;
    ensureListener().catch((err) => console.error("[bus] reconnect failed", err?.message));
  }, 2000);
}

export async function ensureListener(): Promise<void> {
  if (g.__noeListening) return;
  if (!hasDb()) return; // no credentials yet: in-memory events still flow
  g.__noeListening = true;
  const c = new Client({ ...pgConfig(), keepAlive: true }); // keepAlive: notice dead sockets, then reconnect
  g.__noeListenClient = c;
  const drop = (why: string) => {
    if (g.__noeListenClient !== c) return;
    console.error("[bus] LISTEN connection lost:", why);
    g.__noeListening = false;
    g.__noeListenClient = null;
    c.removeAllListeners("notification");
    c.end().catch(() => {});
    scheduleReconnect();
  };
  c.on("notification", (m) => {
    if (m.payload) bus.emit("event", m.payload);
  });
  c.on("error", (err) => drop(err.message));
  c.on("end", () => drop("end"));
  try {
    await c.connect();
    await c.query("LISTEN noe_events");
    emitEvent({ table: "resync", op: "RESYNC", row: {} }); // NOTIFYs sent while not listening are lost
  } catch (err: any) {
    drop(err?.message ?? "connect failed");
    throw err;
  }
}
