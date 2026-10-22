import { z } from "zod";
import type { Rescuer } from "@/lib/types";
import { one } from "@/lib/db";
import { logAgent, notifyNeed } from "@/lib/replay";
import { rescuerLabel } from "@/lib/sim";
import { guard, jsonError, parseBody } from "@/lib/state";

const Body = z.object({
  available: z.boolean(),
  lat: z.number().min(-90).max(90).nullish(),
  lon: z.number().min(-180).max(180).nullish(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await params;
    const body = await parseBody(req, Body);
    if (body instanceof Response) return body;
    const cur = await one<Rescuer>("select * from rescuers where id = $1", [id]);
    if (!cur) return jsonError(404, `Rescuer ${id} not found`);
    // Demo personas keep their seeded position (the demo phone's real GPS is far from Sommières);
    // real coordinates are only accepted inside the demo bbox.
    const inBbox = body.lat != null && body.lon != null && body.lon >= 3.95 && body.lon <= 4.22 && body.lat >= 43.64 && body.lat <= 43.93;
    const useXY = !cur.persona && inBbox;
    const r = await one<Rescuer>(
      `update rescuers set available = $2, lat = coalesce($3, lat, home_lat), lon = coalesce($4, lon, home_lon), updated_at = now()
       where id = $1 returning *`,
      [id, body.available, useXY ? body.lat : null, useXY ? body.lon : null],
    );
    if (!r) return jsonError(404, `Rescuer ${id} not found`);
    await logAgent("dispatcher", `${rescuerLabel(r)} ${r.available ? "available" : "no longer available"}`, {
      event: r.available ? "rescuer_available" : "rescuer_unavailable", rescuerId: r.id, tier: r.tier,
    });
    if (r.available) notifyNeed("rescuer_available");
    return Response.json(r);
  });
}
