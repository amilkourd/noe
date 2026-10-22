// NOÉ Copilot (spec §7.5): LLM turns the deterministic state into <= 4 cited insights.
// On any failure / missing key -> templateInsights() so the demo never shows an empty copilot.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Forecast, Insight, InsightSource, Tier } from "./types";
import type { ForecastDraft } from "./forecaster";
import type { ExposureDraft } from "./exposure";
import type { DraftAssignment, Need, RoadCut } from "./dispatcher";
import { fmtDistance, parisHHmm } from "./geo";

export type InsightDraft = Omit<Insight, "id" | "created_at" | "status">;
export interface CopilotInput {
  simTime: string;
  forecasts: ForecastDraft[] | Forecast[];
  topExposures: (ExposureDraft & { label: string; capacity?: number | null /* OSM value or null */ })[];
  openNeeds: Need[];
  availableRescuers: { id: string; name: string; tier: Tier; org: string | null; distanceToNearestNeedM: number | null }[];
  drafts: DraftAssignment[];
  roadCuts: RoadCut[];
}

export const SYSTEM_PROMPT = `You are NOÉ, the decision copilot for a flood incident commander (fire service + mayor).
Use ONLY the JSON state provided. Never invent people, places, roads, numbers or capacities.
Every insight cites the ids it relies on. Give an honest confidence (0–1).
Max 4 insights, most urgent first, short and concrete, in English.
Safety: only T3 swiftwater-certified rescuers may be assigned to a target that already has water.
You suggest; the human commander decides. Never phrase an insight as an order already given.`;

const TOOL_NAME = "emit_insights";
const EMIT_TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description:
    "Emit at most 4 insights for the incident commander, most urgent first (priority 1 = most urgent). " +
    "title <= 80 chars, detail <= 200 chars. Cite ids from the state in sources. For assign_mission, copy rescuerId, targetType, targetId, requiredTier and routeNote from one of state.drafts.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["insights"],
    properties: {
      insights: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "priority", "title", "detail", "confidence", "sources", "action"],
          properties: {
            kind: { type: "string", enum: ["assignment", "forecast", "site", "route", "resource"] },
            priority: { type: "integer" },
            title: { type: "string" },
            detail: { type: "string" },
            confidence: { type: "number" },
            sources: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["type", "id"],
                properties: { type: { type: "string", enum: ["gauge", "site", "resident", "rescuer", "road", "model"] }, id: { type: "string" } },
              },
            },
            action: {
              type: "object", required: ["type"],
              description: "For assign_mission copy rescuerId/targetType/targetId/requiredTier/routeNote from a draft; for approve_preevacuation give targetType/targetId.",
              properties: {
                type: { type: "string", enum: ["assign_mission", "approve_preevacuation", "none"] },
                rescuerId: { type: "string" },
                targetType: { type: "string", enum: ["site", "resident"] },
                targetId: { type: "string" },
                requiredTier: { type: "string", enum: ["T1", "T2", "T3"] },
                routeNote: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

const clip = (n: number) => z.string().transform((s) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s));
const InsightZ = z.object({
  kind: z.enum(["assignment", "forecast", "site", "route", "resource"]),
  priority: z.coerce.number().int().min(1).max(10).catch(5),
  title: clip(80).pipe(z.string().min(3)),
  detail: clip(200),
  confidence: z.coerce.number().min(0).max(1),
  sources: z.array(z.object({ type: z.enum(["gauge", "site", "resident", "rescuer", "road", "model"]), id: z.string().min(1) })).min(1).max(6),
  action: z.object({
    type: z.enum(["assign_mission", "approve_preevacuation", "none"]),
    rescuerId: z.string().nullish(),
    targetType: z.enum(["site", "resident"]).nullish(),
    targetId: z.string().nullish(),
    requiredTier: z.enum(["T1", "T2", "T3"]).nullish(),
    routeNote: z.string().nullish(),
  }).passthrough(),
});
const OutputZ = z.object({ insights: z.array(z.unknown()).transform((a) => a.slice(0, 4)).pipe(z.array(InsightZ)) });

// ---------------------------------------------------------------- helpers
function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full;
  if (/^(mrs?|ms|dr|mme|m\.)\.?$/i.test(parts[0])) return full;
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

function bestForecast(fs: (ForecastDraft | Forecast)[]): ForecastDraft | Forecast | null {
  if (!fs.length) return null;
  const latest = fs.reduce((m, f) => (f.sim_time > m.sim_time ? f : m), fs[0]);
  const same = fs.filter((f) => f.sim_time === latest.sim_time);
  return same[0]; // callers pass the pipeline's chosen (best) forecast first
}

function knownIds(input: CopilotInput) {
  const ids: Record<InsightSource["type"], Set<string>> = {
    gauge: new Set(), site: new Set(), resident: new Set(), rescuer: new Set(), road: new Set(), model: new Set(["trend_v0", "lag_v1"]),
  };
  for (const f of input.forecasts) {
    ids.gauge.add(f.station_code);
    if ("id" in f && f.id !== undefined) ids.model.add(String(f.id));
  }
  for (const e of input.topExposures) ids[e.target_type].add(e.target_id);
  for (const n of input.openNeeds) ids[n.targetType].add(n.targetId);
  for (const r of input.availableRescuers) ids.rescuer.add(r.id);
  for (const d of input.drafts) {
    ids.rescuer.add(d.rescuerId); ids[d.targetType].add(d.targetId);
    for (const c of d.roadCuts) { ids.road.add(c.roadId); if (c.ref) ids.road.add(c.ref); if (c.name) ids.road.add(c.name); }
  }
  for (const c of input.roadCuts) { ids.road.add(c.roadId); if (c.ref) ids.road.add(c.ref); if (c.name) ids.road.add(c.name); }
  return ids;
}

const ROAD_TOKEN = /\b(?:RD|RN|[DNAM])\s?\d+\b/g;
const CAPACITY_TOKEN = /\b(\d+)\s*(?:beds?|places?|pupils?|capacity)\b/gi;
const normRoad = (x: string) => x.toUpperCase().replace(/^RD/, "D").replace(/^RN/, "N").replace(/\s+/g, "");

/** True when the free text cites a road ref or a capacity that is not in the input state. */
function inventsFacts(input: CopilotInput, text: string): boolean {
  const roads = new Set<string>();
  const addRoad = (x: string | null | undefined) => { if (x) for (const m of x.match(ROAD_TOKEN) ?? []) roads.add(normRoad(m)); };
  for (const c of input.roadCuts) { addRoad(c.ref); addRoad(c.name); }
  for (const d of input.drafts) { addRoad(d.routeNote); for (const c of d.roadCuts) { addRoad(c.ref); addRoad(c.name); } }
  for (const m of text.match(ROAD_TOKEN) ?? []) if (!roads.has(normRoad(m))) return true;
  const caps = new Set(input.topExposures.map((e) => e.capacity).filter((c): c is number => typeof c === "number"));
  for (const m of text.matchAll(CAPACITY_TOKEN)) if (!caps.has(Number(m[1]))) return true;
  return false;
}

/** Enforce safety + grounding in code, whatever the LLM said. */
export function postFilter(input: CopilotInput, insights: InsightDraft[]): InsightDraft[] {
  const ids = knownIds(input);
  const tierOf = new Map<string, Tier>();
  for (const r of input.availableRescuers) tierOf.set(r.id, r.tier);
  for (const d of input.drafts) tierOf.set(d.rescuerId, d.tier);
  const out: InsightDraft[] = [];
  for (const ins of insights) {
    if (!ins.sources.length || !ins.sources.every((s) => ids[s.type]?.has(s.id))) continue;
    if (ins.origin === "llm" && inventsFacts(input, `${ins.title} ${ins.detail}`)) continue; // no invented roads / capacities
    if (ins.action.type === "assign_mission") {
      const p = ins.action.payload;
      const d = input.drafts.find((x) => x.rescuerId === p.rescuerId && x.targetId === p.targetId);
      if (!d) continue;
      const tier = tierOf.get(d.rescuerId);
      if (d.targetHasWater && tier !== "T3") continue; // T3 rule
      ins.action = {
        type: "assign_mission",
        payload: { rescuerId: d.rescuerId, targetType: d.targetType, targetId: d.targetId, requiredTier: d.requiredTier, routeNote: d.routeNote ?? undefined },
      };
    } else if (ins.action.type === "approve_preevacuation") {
      const p = ins.action.payload;
      if (!p.targetId || !p.targetType || !ids[p.targetType]?.has(p.targetId)) ins.action = { type: "none", payload: {} };
      else ins.action = { type: "approve_preevacuation", payload: { targetType: p.targetType, targetId: p.targetId } };
    } else {
      ins.action = { type: "none", payload: {} };
    }
    ins.confidence = Math.round(Math.max(0, Math.min(0.95, ins.confidence)) * 100) / 100;
    out.push(ins);
  }
  return out.slice(0, 4).map((x, i) => ({ ...x, priority: i + 1 }));
}

// ---------------------------------------------------------------- templates
export function templateInsights(input: CopilotInput): InsightDraft[] {
  const sim = input.simTime;
  const f = bestForecast(input.forecasts as (ForecastDraft | Forecast)[]);
  const conf = f ? f.confidence : 0.5;
  const out: InsightDraft[] = [];
  const expo = new Map(input.topExposures.map((e) => [e.target_type + ":" + e.target_id, e]));
  const needBy = new Map(input.openNeeds.map((n) => [n.targetType + ":" + n.targetId, n]));

  // 1) assignments (top 2 drafts, in need-priority order)
  for (const d of input.drafts.slice(0, 2)) {
    const key = d.targetType + ":" + d.targetId;
    const e = expo.get(key);
    const need = needBy.get(key);
    const isPersona = d.targetType === "resident" && need?.persona !== false;
    const who = `${d.targetLabel}${isPersona ? " (demo persona)" : ""}`;
    const what = need?.note ? ` ${need.note}` : need?.reason === "needs_help" ? " asked for help" : "";
    const water = d.targetHasWater ? "water already at the door" : e?.eta ? `water at the door ≈${parisHHmm(e.eta)}` : "in the projected flood area";
    const route = d.routeNote ? ` Route: ${d.routeNote}.` : "";
    const sources: InsightSource[] = [{ type: "rescuer", id: d.rescuerId }, { type: d.targetType, id: d.targetId }];
    if (f) sources.push({ type: "gauge", id: f.station_code });
    if (d.roadCuts[0]) sources.push({ type: "road", id: d.roadCuts[0].roadId });
    out.push({
      sim_time: sim, kind: "assignment", priority: 0,
      title: trunc(`Assign ${shortName(d.rescuerName)} (${d.tier}) to ${d.targetLabel} · ${fmtDistance(d.distanceM)}`, 80),
      detail: trunc(`${who}${what}, ${water}.${route}${d.targetHasWater ? " T3 swiftwater required." : ""}`, 200),
      confidence: conf, sources,
      action: { type: "assign_mission", payload: { rescuerId: d.rescuerId, targetType: d.targetType, targetId: d.targetId, requiredTier: d.requiredTier, routeNote: d.routeNote ?? undefined } },
      origin: "template",
    });
  }

  // 2) forecast
  if (f) {
    const crossed = f.h_now_m >= f.threshold_m;
    const title = crossed
      ? `Sommières above demo threshold (${f.threshold_m} m)${f.eta_crossing ? ` since ${parisHHmm(f.eta_crossing)}` : ""} · ${Math.round(f.confidence * 100)}%`
      : f.eta_crossing
        ? `Overflow at Sommières ≈ ${parisHHmm(f.eta_crossing)} · ${Math.round(f.confidence * 100)}%`
        : `Sommières ${f.h_now_m} m · no overflow forecast yet`;
    const rate = f.rate_cm_h !== null ? `, ${f.rate_cm_h >= 0 ? "+" : ""}${f.rate_cm_h} cm/h` : "";
    const peak = f.peak_h_m !== null && f.peak_time ? ` Peak upper bound ≈${f.peak_h_m} m (approximate).` : "";
    out.push({
      sim_time: sim, kind: "forecast", priority: 0, title: trunc(title, 80),
      detail: trunc(`Gauge ${f.h_now_m} m${rate} (demo threshold ${f.threshold_m} m).${peak} Model ${f.model}, replayed real data.`, 200),
      confidence: f.confidence, sources: [{ type: "gauge", id: f.station_code }, { type: "model", id: f.model }],
      action: { type: "none", payload: {} }, origin: "template",
    });
  }

  // 3) most exposed site not already covered by an assignment
  const assigned = new Set(input.drafts.map((d) => d.targetType + ":" + d.targetId));
  const site = input.topExposures.find((e) => e.target_type === "site" && !assigned.has("site:" + e.target_id));
  if (site) {
    out.push({
      sim_time: sim, kind: "site", priority: 0,
      title: trunc(`Pre-evacuate ${site.label} · water ≈${parisHHmm(site.eta)}`, 80),
      detail: trunc(`Approximate flood model: up to ${site.depth_m ?? "?"} m at ${site.label} from ≈${parisHHmm(site.eta)}. Exposure priority ${site.priority}.`, 200),
      confidence: Math.min(conf, 0.8), sources: [{ type: "site", id: site.target_id }, ...(f ? [{ type: "gauge" as const, id: f.station_code }] : [])],
      action: { type: "approve_preevacuation", payload: { targetType: "site", targetId: site.target_id } }, origin: "template",
    });
  }

  // 4) resources gap, else first road cut
  const unassigned = input.openNeeds.filter((n) => !assigned.has(n.targetType + ":" + n.targetId));
  if (unassigned.length && out.length < 4) {
    const n = unassigned[0];
    out.push({
      sim_time: sim, kind: "resource", priority: 0,
      title: trunc(`${unassigned.length} need${unassigned.length > 1 ? "s" : ""} without a matching rescuer`, 80),
      detail: trunc(`No available rescuer meets the tier for ${n.label}. Consider activating more T3 swiftwater teams.`, 200),
      confidence: 0.7, sources: [{ type: n.targetType, id: n.targetId }], action: { type: "none", payload: {} }, origin: "template",
    });
  } else if (input.roadCuts.length && out.length < 4) {
    const c = input.roadCuts[0];
    const l = c.ref || c.name;
    if (l) out.push({
      sim_time: sim, kind: "route", priority: 0,
      title: trunc(`${l} under water ${c.floodedAt ? "≈" + parisHHmm(c.floodedAt) : "now"}`, 80),
      detail: trunc(`Approximate flood model projects water on ${l}${c.floodedAt ? " from ≈" + parisHHmm(c.floodedAt) : ""}. Plan routes around it.`, 200),
      confidence: Math.min(conf, 0.75), sources: [{ type: "road", id: c.roadId }], action: { type: "none", payload: {} }, origin: "template",
    });
  }
  return out.slice(0, 4).map((x, i) => ({ ...x, priority: i + 1 }));
}

function trunc(s: string, n: number) { return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }

// ---------------------------------------------------------------- LLM
let client: Anthropic | null = null;
function getClient(): Anthropic { return (client ??= new Anthropic()); }

export async function runCopilot(input: CopilotInput): Promise<InsightDraft[]> {
  if (!process.env.ANTHROPIC_API_KEY) return templateInsights(input);
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
  const user = `State (JSON):\n${JSON.stringify(input)}\n\nCall ${TOOL_NAME} exactly once with at most 4 insights.`;
  let forced = true; // forced tool_choice; models that reject it (400) get auto + explicit instruction
  let failures = 0;
  while (failures < 2) { // first try + 1 retry
    try {
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model, max_tokens: 2000, system: SYSTEM_PROMPT, tools: [EMIT_TOOL],
        messages: [{ role: "user", content: user }],
        tool_choice: forced ? { type: "tool", name: TOOL_NAME } : { type: "auto", disable_parallel_tool_use: true },
      };
      if (forced && /haiku-5/.test(model)) params.thinking = { type: "disabled" };
      if (!forced) params.output_config = { effort: "low" };
      const res = await getClient().messages.create(params, { timeout: 12_000, maxRetries: 0 });
      const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME);
      if (!block) throw new Error(`no ${TOOL_NAME} call (stop_reason ${res.stop_reason})`);
      const parsed = OutputZ.parse(block.input);
      const drafts: InsightDraft[] = parsed.insights.map((i) => ({
        sim_time: input.simTime, kind: i.kind, priority: i.priority, title: i.title, detail: i.detail, confidence: i.confidence,
        sources: i.sources,
        action: {
          type: i.action.type,
          payload: Object.fromEntries(Object.entries({
            rescuerId: i.action.rescuerId, targetType: i.action.targetType, targetId: i.action.targetId,
            requiredTier: i.action.requiredTier, routeNote: i.action.routeNote,
          }).filter(([, v]) => v !== null && v !== undefined)),
        },
        origin: "llm",
      }));
      const kept = postFilter(input, drafts);
      if (kept.length) return kept;
      throw new Error("all LLM insights failed grounding checks");
    } catch (err) {
      if (forced && err instanceof Anthropic.BadRequestError) { forced = false; continue; }
      failures++;
      if (process.env.NOE_DEBUG) console.warn("[copilot] attempt failed:", (err as Error).message);
    }
  }
  return templateInsights(input);
}
