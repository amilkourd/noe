import { z } from "zod";
import type { Insight } from "@/lib/types";
import { one } from "@/lib/db";
import { guard, jsonError, parseBody } from "@/lib/state";

const Body = z.object({ status: z.enum(["accepted", "dismissed"]) });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await params;
    const n = Number(id);
    if (!Number.isInteger(n)) return jsonError(400, "Invalid insight id");
    const body = await parseBody(req, Body);
    if (body instanceof Response) return body;
    const row = await one<Insight>("update insights set status = $2 where id = $1 returning *", [n, body.status]);
    if (!row) return jsonError(404, `Insight ${id} not found`);
    return Response.json(row);
  });
}
