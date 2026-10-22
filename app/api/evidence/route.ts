// Evidence numbers for the pitch, computed from the DB. Every number is labelled with the data mode.
import { connection } from "next/server";
import { query, one } from "@/lib/db";
import { getClock } from "@/lib/replay";
import { guard } from "@/lib/state";

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const SCENARIO_SIM = "SCENARIO · simulated personas";
const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

export async function GET() {
  await connection();
  return guard(async () => {
    const clock = getClock();
    const label = clock.mode === "SCENARIO" ? "SCENARIO" : clock.mode === "LIVE" ? "LIVE" : "REPLAY";

    // 1) lead time: first exposure flag of each site -> model water arrival (first run where it is wet, else latest ETA)
    const lead = await query<{ id: string; name: string; kind: string; first_flag: string; first_wet: string | null; latest_eta: string | null }>(
      `select x.target_id as id, s.name, s.kind, min(f.sim_time) as first_flag,
              min(f.sim_time) filter (where x.eta <= f.sim_time) as first_wet,
              (array_agg(x.eta order by f.sim_time desc))[1] as latest_eta
       from exposures x join forecasts f on f.id = x.forecast_id join sites s on s.id = x.target_id
       where x.target_type = 'site' group by x.target_id, s.name, s.kind order by min(f.sim_time)`,
    );
    const leadSites = lead.map((l) => {
      const arrival = l.first_wet ?? l.latest_eta;
      const leadMin = arrival ? Math.max(0, (Date.parse(arrival) - Date.parse(l.first_flag)) / 60_000) : null;
      return { id: l.id, name: l.name, kind: l.kind, firstFlag: l.first_flag, waterArrival: arrival, observedInModel: !!l.first_wet, leadMin: r1(leadMin) };
    });
    const leads = leadSites.map((s) => s.leadMin).filter((x): x is number => x != null);

    // 2) contact speed (sim): first exposure of a resident -> call placed; call -> answer
    const contacts = await query<{ resident_id: string; first_exposed: string | null; call_sim: string | null; status_sim_real: string | null; status_sim_simulated: string | null; state: string }>(
      `select d.resident_id, d.state,
              (select min(f.sim_time) from exposures x join forecasts f on f.id = x.forecast_id
                where x.target_type = 'resident' and x.target_id = d.resident_id) as first_exposed,
              (select min(sim_time) from agent_log where agent = 'voice' and data->>'event' = 'call' and data->>'residentId' = d.resident_id) as call_sim,
              (select min(sim_time) from agent_log where agent = 'voice' and data->>'event' = 'status' and data->>'residentId' = d.resident_id
                and data->>'simulated' is null) as status_sim_real,
              (select min(sim_time) from agent_log where agent = 'voice' and data->>'event' = 'status' and data->>'residentId' = d.resident_id
                and data->>'simulated' is not null) as status_sim_simulated
       from dove_calls d order by d.id`,
    );
    const toCall = contacts
      .filter((c) => c.first_exposed && c.call_sim)
      .map((c) => (Date.parse(c.call_sim!) - Date.parse(c.first_exposed!)) / 1000);
    // answers: real (DOVE page) vs simulated personas (seeded outcomes) are reported separately
    const answerS = (pick: (c: (typeof contacts)[number]) => string | null) => contacts
      .filter((c) => c.call_sim && pick(c))
      .map((c) => (Date.parse(pick(c)!) - Date.parse(c.call_sim!)) / 1000);
    const toAnswerReal = answerS((c) => c.status_sim_real);
    const toAnswerSim = answerS((c) => c.status_sim_simulated);

    // 3) assignment speed (real seconds): needs_help report -> mission sent for that resident
    const assign = await query<{ mission_id: number; resident_id: string; seconds: number; simulated: boolean }>(
      `select m.id as mission_id, m.target_id as resident_id,
              exists (select 1 from status_reports sr where sr.resident_id = m.target_id and sr.notes = 'simulated persona') as simulated,
              extract(epoch from (m.created_at - (select min(sr.created_at) from status_reports sr
                where sr.resident_id = m.target_id and sr.status = 'needs_help' and sr.created_at <= m.created_at)))::float8 as seconds
       from missions m where m.target_type = 'resident'`,
    );
    const secs = (xs: typeof assign) => xs.map((a) => a.seconds).filter((x) => x != null && Number.isFinite(x));
    const assignReal = assign.filter((a) => !a.simulated);
    const assignSim = assign.filter((a) => a.simulated);

    // 4) coverage
    const cov = await one<Record<string, number>>(
      `select
         (select count(distinct x.target_id) from exposures x where x.target_type = 'resident')::int as residents_exposed,
         (select count(distinct x.target_id) from exposures x where x.target_type = 'site')::int as sites_exposed,
         (select count(*) from dove_calls)::int as contacted,
         (select count(*) from (select distinct on (resident_id) status from status_reports order by resident_id, created_at desc, id desc) s where s.status = 'safe')::int as safe,
         (select count(*) from (select distinct on (resident_id) status from status_reports order by resident_id, created_at desc, id desc) s where s.status = 'unstable')::int as unstable,
         (select count(*) from (select distinct on (resident_id) status from status_reports order by resident_id, created_at desc, id desc) s where s.status = 'needs_help')::int as need_help,
         (select count(*) from dove_calls where state = 'missed')::int as no_answer,
         (select count(*) from missions)::int as missions_sent,
         (select count(*) from rescuers where available)::int as rescuers_available`,
    );

    // 5) learner: ETA error per model vs the actual crossing in the gauge data
    const target = await one<{ code: string; threshold_m: number | null }>("select code, threshold_m from stations where role = 'target' limit 1");
    let etaError: { actualCrossing: string | null; threshold_m: number; models: Record<string, { n: number; meanAbsErrMin: number | null }> } | null = null;
    if (target) {
      const thr = target.threshold_m ?? 2.0;
      // interpolate between the last sample below and the first sample at/above the threshold
      const hit = await one<{ ts: string; h_m: number }>(
        "select ts, h_m from observations_raw where station_code = $1 and h_m >= $2 and ts >= $3 order by ts limit 1",
        [target.code, thr, clock.start],
      );
      const prev = hit
        ? await one<{ ts: string; h_m: number }>(
          "select ts, h_m from observations_raw where station_code = $1 and ts < $2 order by ts desc limit 1",
          [target.code, hit.ts],
        )
        : null;
      let actualTs: string | null = hit?.ts ?? null;
      if (hit && prev && hit.h_m > prev.h_m && prev.h_m < thr) {
        const t0 = Date.parse(prev.ts), t1 = Date.parse(hit.ts);
        actualTs = new Date(t0 + ((thr - prev.h_m) * (t1 - t0)) / (hit.h_m - prev.h_m)).toISOString();
      }
      const actual = { ts: actualTs };
      const models: Record<string, { n: number; meanAbsErrMin: number | null }> = {};
      if (actual?.ts) {
        const rows = await query<{ model: string; eta_crossing: string }>(
          "select model, eta_crossing from forecasts where station_code = $1 and eta_crossing is not null and sim_time < $2",
          [target.code, actual.ts],
        );
        for (const m of ["trend_v0", "lag_v1"]) {
          const errs = rows.filter((r) => r.model === m).map((r) => Math.abs(Date.parse(r.eta_crossing) - Date.parse(actual.ts!)) / 60_000);
          models[m] = { n: errs.length, meanAbsErrMin: errs.length ? r1(errs.reduce((a, b) => a + b, 0) / errs.length) : null };
        }
      }
      etaError = { actualCrossing: actual?.ts ?? null, threshold_m: thr, models };
    }

    return Response.json(
      {
        label,
        badge: label === "REPLAY" ? "REPLAY · real data 19–20 Oct 2026" : label,
        simTime: clock.simTime,
        leadTime: { label, unit: "min (sim)", medianMin: r1(median(leads)), minMin: leads.length ? r1(Math.min(...leads)) : null, sites: leadSites },
        contactSpeed: {
          label, unit: "s (sim)",
          medianExposureToCallS: r1(median(toCall)), calls: contacts.length,
          medianCallToAnswerS: r1(median(toAnswerReal)), answers: toAnswerReal.length,
          simulated: { label: SCENARIO_SIM, medianCallToAnswerS: r1(median(toAnswerSim)), answers: toAnswerSim.length },
        },
        assignmentSpeed: {
          label, unit: "s (real)", medianS: r1(median(secs(assignReal))), missions: assignReal,
          simulated: { label: SCENARIO_SIM, medianS: r1(median(secs(assignSim))), missions: assignSim },
        },
        // answers (safe / unstable / needs help / no answer) come mostly from the seeded persona simulation
        coverage: { label: SCENARIO_SIM, ...(cov ?? {}) },
        etaError: etaError ? { label, ...etaError } : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}
