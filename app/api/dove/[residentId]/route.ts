import { NextResponse, connection } from "next/server";
import { one } from "@/lib/db";
import { getClock } from "@/lib/replay";
import type { DoveCall } from "@/lib/types";
import { doveLang, firstMessage, humanEta, INSTRUCTION, type DoveInfo } from "@/lib/dove-copy";


const TOWN = "Sommières";

interface ResidentRow { id: string; name: string; language: string | null; age: number | null; persona: boolean | null }
interface ExposureRow { eta: Date | string | null; depth_m: number | null; sim_time: Date | string }

function simNow(fallback: Date | string | null | undefined): Date {
  try {
    const c = getClock();
    if (c?.simTime) return new Date(c.simTime);
  } catch { /* replay engine not available: fall back to the forecast's sim time */ }
  return fallback ? new Date(fallback) : new Date();
}

export async function GET(_req: Request, { params }: { params: Promise<{ residentId: string }> }) {
  await connection(); // always run at request time (cacheComponents is on)
  const { residentId } = await params;
  try {
    const r = await one<ResidentRow>(
      "select id, name, language, age, persona from residents where id = $1",
      [residentId],
    );
    if (!r) return NextResponse.json({ error: "unknown resident" }, { status: 404 });

    const lang = doveLang(r.language);

    // Latest exposure of this resident, only if it belongs to the latest forecast that produced exposures.
    const exp = await one<ExposureRow>(
      `select e.eta, e.depth_m, f.sim_time
         from exposures e join forecasts f on f.id = e.forecast_id
        where e.target_type = 'resident' and e.target_id = $1
          and e.forecast_id = (select max(forecast_id) from exposures)
        order by e.id desc limit 1`,
      [residentId],
    );
    const latestForecast = exp ? null : await one<{ sim_time: Date | string }>(
      "select sim_time from forecasts order by id desc limit 1",
    );
    const now = simNow(exp?.sim_time ?? latestForecast?.sim_time);

    let eta: string | null = null;
    if (exp) {
      // eta null on an exposed row = water already there (or no arrival time): say "a few minutes" rather than nothing.
      const mins = exp.eta ? (new Date(exp.eta).getTime() - now.getTime()) / 60000 : 0;
      eta = humanEta(lang, Math.max(0, mins));
    }

    const latestCall = await one<DoveCall>(
      "select id, resident_id, created_at, state from dove_calls where resident_id = $1 order by id desc limit 1",
      [residentId],
    );

    const body: DoveInfo = {
      resident: { id: r.id, name: r.name, language: lang, age: r.age ?? null, persona: r.persona ?? true },
      town: TOWN,
      instruction: INSTRUCTION[lang],
      eta,
      firstMessage: firstMessage(lang, r.name, TOWN, now),
      latestCall: latestCall
        ? { ...latestCall, id: Number(latestCall.id), created_at: new Date(latestCall.created_at).toISOString() }
        : null,
      agentId: process.env.ELEVENLABS_AGENT_ID || process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID || null,
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: "database unavailable", detail: String((e as Error)?.message ?? e) }, { status: 503 });
  }
}
