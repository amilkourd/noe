// SSE: Postgres NOTIFY rows + in-memory events (clock, flood, reset). One JSON NoeEvent per `data:` line.
import { connection } from "next/server";
import { bus, ensureListener } from "@/lib/bus";
import { getClock } from "@/lib/replay";

export async function GET(req: Request) {
  await connection();
  try {
    await ensureListener();
  } catch (err: any) {
    console.error("[stream] LISTEN unavailable:", err?.message); // in-memory events still flow; bus retries
  }
  // Optional ?tables=dove_calls,reset,clock filter: resident phones (DOVE) must not receive health data
  // (status_reports, agent_log, insights). ARK uses the full stream.
  const tablesParam = new URL(req.url).searchParams.get("tables");
  const allow = tablesParam ? new Set(tablesParam.split(",").map((t) => t.trim()).filter(Boolean)) : null;
  const passes = (p: string) => {
    if (!allow) return true;
    const m = /"table"\s*:\s*"([^"]+)"/.exec(p);
    return !!m && allow.has(m[1]);
  };
  const enc = new TextEncoder();
  let onEvent: ((p: string) => void) | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  const cleanup = () => {
    if (onEvent) bus.off("event", onEvent);
    if (hb) clearInterval(hb);
    onEvent = null;
    hb = null;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (s: string) => {
        try {
          ctrl.enqueue(enc.encode(s));
        } catch {
          cleanup();
        }
      };
      onEvent = (p: string) => {
        if (passes(p)) send(`data: ${p}\n\n`);
      };
      bus.on("event", onEvent);
      hb = setInterval(() => send(`: hb\n\n`), 15_000);
      send(`retry: 2000\n: connected\n\n`);
      send(`data: ${JSON.stringify({ table: "clock", op: "TICK", row: getClock() })}\n\n`);
      req.signal?.addEventListener("abort", () => {
        cleanup();
        try {
          ctrl.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
