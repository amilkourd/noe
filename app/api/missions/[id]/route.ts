import { z } from "zod";
import type { Mission, Rescuer } from "@/lib/types";
import { one } from "@/lib/db";
import { logAgent, notifyNeed } from "@/lib/replay";
import { missionNumber, shortName } from "@/lib/sim";
import { guard, jsonError, parseBody } from "@/lib/state";

const Body = z.object({ status: z.enum(["sent", "accepted", "en_route", "on_site", "done", "backup"]) });
const LABEL: Record<string, string> = {
  sent: "sent", accepted: "accepted", en_route: "en route", on_site: "on site", done: "done", backup: "backup requested",
};

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await params;
    const n = Number(id);
    if (!Number.isInteger(n)) return jsonError(400, "Invalid mission id");
    const body = await parseBody(req, Body);
    if (body instanceof Response) return body;
    const m = await one<Mission>("update missions set status = $2 where id = $1 returning *", [n, body.status]);
    if (!m) return jsonError(404, `Mission ${id} not found`);
    const r = await one<Rescuer>("select * from rescuers where id = $1", [m.rescuer_id]);
    await logAgent("dispatcher", `Mission ${missionNumber(m.id)} ${LABEL[m.status]}${r ? ` · ${shortName(r.name)}` : ""}`, {
      event: "mission_status", missionId: m.id, status: m.status, rescuerId: m.rescuer_id,
    });
    if (m.status === "done" || m.status === "backup") notifyNeed("rescuer_available");
    return Response.json(m);
  });
}
