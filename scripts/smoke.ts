// Smoke test against a running NOÉ server with a live DB.
// Usage: npm run dev (or start) in another terminal, then: npx tsx scripts/smoke.ts [baseUrl]
import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = process.argv[2] || process.env.SMOKE_URL || "http://localhost:3000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch {}
  const ok = res.ok;
  if (!ok) failures++;
  console.log(`${ok ? "OK " : "ERR"} ${method} ${path} -> ${res.status} (${Date.now() - t0} ms)${ok ? "" : " " + text.slice(0, 300)}`);
  return json;
}

async function sse(seconds: number) {
  const ctrl = new AbortController();
  const counts: Record<string, number> = {};
  try {
    const res = await fetch(BASE + "/api/stream", { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const stop = Date.now() + seconds * 1000;
    let buf = "";
    while (Date.now() < stop) {
      const r = await Promise.race([reader.read(), sleep(stop - Date.now()).then(() => null)]);
      if (!r || r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try { const e = JSON.parse(line.slice(6)); counts[e.table] = (counts[e.table] ?? 0) + 1; } catch {}
      }
    }
  } catch (e: any) {
    if (e?.name !== "AbortError") { failures++; console.log("ERR SSE", e?.message); }
  } finally {
    ctrl.abort();
  }
  console.log(`SSE ${seconds}s events by table:`, counts);
}

function summary(s: any) {
  const f = s.latestForecast;
  console.log(
    `  sim ${s.clock.simTime} running=${s.clock.running} ×${s.clock.speed} ${s.clock.mode} | obs ${s.observations.length}` +
      ` | forecast ${f ? `${f.model} h=${f.h_now_m} eta=${f.eta_crossing} conf=${f.confidence}` : "none"}` +
      ` | exposures ${s.exposures.length} | flood cells ${s.flood?.cells.length ?? 0}` +
      ` | calls ${s.doveCalls.length} | statuses ${s.statuses.length} | rescuers avail ${s.rescuers.filter((r: any) => r.available).length}/${s.rescuers.length}` +
      ` | insights ${s.insights.length} | missions ${s.missions.length} | perimeter ${s.perimeter.active}`,
  );
}

async function main() {
  console.log("NOÉ smoke test against", BASE);
  const t0 = Date.now();
  await call("POST", "/api/replay", { action: "reset" });
  console.log(`  reset took ${Date.now() - t0} ms (target < 1000)`);
  const terrain = await call("GET", "/api/terrain");
  if (terrain?.grid) console.log(`  terrain ${terrain.grid.cols}x${terrain.grid.rows}, roads ${terrain.roads.length}, river pts ${terrain.river.length}`);
  await call("POST", "/api/replay", { action: "start" });
  await call("POST", "/api/replay", { action: "speed", speed: 600 });
  const ssePromise = sse(8);
  for (let i = 0; i < 6; i++) {
    await sleep(10_000);
    const s = await call("GET", "/api/state");
    if (s?.clock) summary(s);
  }
  await ssePromise;

  // RAVEN: Karim says he's available
  await call("PATCH", "/api/rescuers/rb-karim", { available: true });
  // DOVE: Mrs Garcia cannot climb the stairs
  await call("POST", "/api/status", { residentId: "res-garcia", status: "needs_help", can_climb_stairs: false, notes: "smoke test", channel: "button" });
  await sleep(15_000);
  const s = await call("GET", "/api/state");
  if (s?.clock) summary(s);
  for (const i of s?.insights ?? []) console.log(`  insight [${i.origin}] p${i.priority} ${i.title} · ${i.action?.type}`);
  const assign = (s?.insights ?? []).find((i: any) => i.action?.type === "assign_mission" && i.action.payload?.rescuerId);
  if (assign) {
    const p = assign.action.payload;
    const m = await call("POST", "/api/missions", {
      rescuerId: p.rescuerId, targetType: p.targetType, targetId: p.targetId, routeNote: p.routeNote ?? null,
      requiredTier: p.requiredTier ?? "T3", insightId: assign.id,
    });
    if (m?.id) {
      const rv = await call("GET", `/api/raven/${p.rescuerId}`);
      console.log("  raven:", JSON.stringify({ alert: rv?.alert, mission: rv?.mission && { number: rv.mission.number, target: rv.mission.target.name, water: rv.mission.waterNowM, eta: rv.mission.etaMin, hazards: rv.mission.hazards } }));
      await call("PATCH", `/api/missions/${m.id}`, { status: "en_route" });
    }
  } else {
    console.log("  (no assign_mission insight yet)");
  }
  // safety check: a non-T3 rescuer to a wet target should be refused (409) if any target is wet
  const rv = await call("GET", "/api/raven/rb-karim");
  console.log("  raven rb-karim alert:", JSON.stringify(rv?.alert));
  const ev = await call("GET", "/api/evidence");
  console.log("  evidence:", JSON.stringify({ lead: ev?.leadTime?.medianMin, contact: ev?.contactSpeed, assign: ev?.assignmentSpeed?.medianS, coverage: ev?.coverage, eta: ev?.etaError }, null, 0));
  await call("POST", "/api/replay", { action: "pause" });
  console.log(failures ? `\n${failures} request(s) failed` : "\nall requests OK");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
