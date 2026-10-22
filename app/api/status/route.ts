import { z } from "zod";
import type { Resident, StatusReport } from "@/lib/types";
import { one } from "@/lib/db";
import { logAgent, notifyNeed } from "@/lib/replay";
import { guard, jsonError, parseBody } from "@/lib/state";

const Body = z.object({
  residentId: z.string().min(1),
  status: z.enum(["safe", "needs_help"]),
  can_climb_stairs: z.boolean().nullish(),
  notes: z.string().max(1000).nullish(),
  channel: z.enum(["voice", "button"]).default("voice"),
});

export async function POST(req: Request) {
  return guard(async () => {
    const body = await parseBody(req, Body);
    if (body instanceof Response) return body;
    const res = await one<Resident>("select * from residents where id = $1", [body.residentId]);
    if (!res) return jsonError(404, `Resident ${body.residentId} not found`);
    const row = await one<StatusReport>(
      `insert into status_reports (resident_id, status, can_climb_stairs, notes, channel) values ($1,$2,$3,$4,$5) returning *`,
      [res.id, body.status, body.can_climb_stairs ?? null, body.notes ?? null, body.channel],
    );
    // A voice report arrives mid-conversation: the call is still live, DOVE PATCHes 'ended' itself on hang-up.
    if (body.channel === "button") {
      await one(
        `update dove_calls set state = 'ended'
         where id = (select id from dove_calls where resident_id = $1 order by id desc limit 1) and state = 'accepted' returning id`,
        [res.id],
      );
    }
    const stairs = body.can_climb_stairs === false ? " · cannot climb stairs" : body.can_climb_stairs === true ? " · can go upstairs" : "";
    await logAgent("voice", `${res.name}: ${body.status === "needs_help" ? "needs help" : "safe"}${stairs} (${body.channel})`, {
      event: "status", residentId: res.id, status: body.status, channel: body.channel, statusId: row?.id ?? null,
    });
    if (body.status === "needs_help") notifyNeed("needs_help");
    return Response.json(row, { status: 201 });
  });
}
