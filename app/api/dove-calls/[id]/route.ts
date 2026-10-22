import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { one } from "@/lib/db";
import type { DoveCall } from "@/lib/types";


const Body = z.object({ state: z.enum(["ringing", "accepted", "declined", "ended", "missed"]) });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const callId = Number(id);
  if (!Number.isInteger(callId) || callId <= 0) return NextResponse.json({ error: "bad id" }, { status: 400 });

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "body must be { state: ringing|accepted|declined|ended|missed }" }, { status: 400 });
  }

  try {
    const row = await one<DoveCall>(
      "update dove_calls set state = $2 where id = $1 returning id, resident_id, created_at, state",
      [callId, parsed.state],
    );
    if (!row) return NextResponse.json({ error: "unknown call" }, { status: 404 });
    return NextResponse.json({ ...row, id: Number(row.id), created_at: new Date(row.created_at).toISOString() });
  } catch (e) {
    return NextResponse.json({ error: "database unavailable", detail: String((e as Error)?.message ?? e) }, { status: 503 });
  }
}
