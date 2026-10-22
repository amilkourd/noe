import { z } from "zod";
import { control } from "@/lib/replay";
import { guard, parseBody } from "@/lib/state";

const Body = z.object({
  action: z.enum(["start", "pause", "reset", "speed"]),
  speed: z.number().positive().optional(),
});

export async function POST(req: Request) {
  return guard(async () => {
    const body = await parseBody(req, Body);
    if (body instanceof Response) return body;
    if (body.action === "speed" && body.speed == null) return Response.json({ error: "speed required" }, { status: 400 });
    const clock = await control(body.action, body.speed);
    return Response.json(clock);
  });
}
