import { z } from "zod";
import type { Mission, Rescuer } from "@/lib/types";
import { one } from "@/lib/db";
import { getRuntime, logAgent, notifyNeed, resumeAfterDispatch, safeTerrain } from "@/lib/replay";
import { missionNumber, shortName } from "@/lib/sim";
import { guard, hNowFromDb, jsonError, loadTarget, parseBody, waterAt } from "@/lib/state";

const Tier = z.enum(["T1", "T2", "T3"]);
const Body = z.object({
  rescuerId: z.string().min(1),
  targetType: z.enum(["site", "resident"]),
  targetId: z.string().min(1),
  routeNote: z.string().max(500).nullish(),
  requiredTier: Tier,
  insightId: z.number().int().nullish(),
});

export async function POST(req: Request) {
  return guard(async () => {
    const body = await parseBody(req, Body);
    if (body instanceof Response) return body;
    const rescuer = await one<Rescuer>("select * from rescuers where id = $1", [body.rescuerId]);
    if (!rescuer) return jsonError(404, `Rescuer ${body.rescuerId} not found`);
    const target = await loadTarget(body.targetType, body.targetId);
    if (!target) return jsonError(404, `Target ${body.targetType} ${body.targetId} not found`);

    // SAFETY CHECK (server-side, non-negotiable): water at the target now, or due within 30 sim-min -> T3 swiftwater only.
    // If the water model is not ready (e.g. right after a server restart), fail safe: require T3.
    const rt = getRuntime();
    const hNow = Object.keys(rt.hNow).length ? rt.hNow : await hNowFromDb();
    const modelReady = !!safeTerrain() && Object.keys(hNow).length > 0;
    const water = waterAt(target.lat, target.lon, hNow);
    const soon = water.eta != null && Date.parse(water.eta) - rt.simMs <= 30 * 60_000;
    const needT3 = !modelReady || water.hasWater || soon || body.requiredTier === "T3";
    if (needT3 && rescuer.tier !== "T3") {
      const why = !modelReady
        ? "water model not ready"
        : water.hasWater ? `${target.name} already has water (approximate flood model)`
        : soon ? `water expected at ${target.name} within 30 min (approximate flood model)`
        : "this mission requires T3";
      return jsonError(
        409,
        `${why}: only T3 swiftwater-certified rescuers may be sent. ${shortName(rescuer.name)} is ${rescuer.tier}.`,
        { code: "T3_REQUIRED", waterNowM: water.nowM, reason: why },
      );
    }

    // Idempotent send + rescuer state checks (double-click on ARK must not create two missions).
    const open = await one<Mission>(
      "select * from missions where rescuer_id = $1 and status <> 'done' order by id desc limit 1",
      [rescuer.id],
    );
    if (open) {
      if (open.target_type === target.type && open.target_id === target.id) return Response.json(open, { status: 200 });
      return jsonError(409, `${shortName(rescuer.name)} is already on mission ${missionNumber(open.id)}`, { code: "RESCUER_BUSY", missionId: open.id });
    }
    if (!rescuer.available) {
      return jsonError(409, `${shortName(rescuer.name)} is not available`, { code: "RESCUER_UNAVAILABLE" });
    }

    const requiredTier = needT3 ? "T3" : body.requiredTier;
    const m = await one<Mission>(
      `insert into missions (rescuer_id, target_type, target_id, route_note, required_tier, insight_id, status)
       values ($1,$2,$3,$4,$5,$6,'sent') returning *`,
      [rescuer.id, target.type, target.id, body.routeNote ?? null, requiredTier, body.insightId ?? null],
    );
    if (!m) return jsonError(500, "Mission insert failed");
    if (body.insightId != null) await one("update insights set status = 'accepted' where id = $1 returning id", [body.insightId]);
    await logAgent("dispatcher", `Mission ${missionNumber(m.id)} sent to ${shortName(rescuer.name)} · ${target.name}`, {
      event: "mission_sent", missionId: m.id, rescuerId: rescuer.id, targetType: target.type, targetId: target.id, insightId: body.insightId ?? null,
    });
    notifyNeed("rescuer_available"); // refresh suggestions: this rescuer and target are now taken
    await resumeAfterDispatch(target.type, target.id);
    return Response.json(m, { status: 201 });
  });
}
