import { connection } from "next/server";
import { loadRiver, loadRoads, loadTerrain } from "@/lib/terrain";

export async function GET() {
  await connection();
  try {
    return Response.json(
      { grid: loadTerrain(), roads: loadRoads(), river: loadRiver() },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  } catch (err: any) {
    return Response.json({ error: `Terrain data not built yet: ${err?.message ?? err}` }, { status: 503 });
  }
}
