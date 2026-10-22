import { connection } from "next/server";
import { buildState, guard } from "@/lib/state";

export async function GET() {
  await connection();
  return guard(async () => Response.json(await buildState(), { headers: { "Cache-Control": "no-store" } }));
}
