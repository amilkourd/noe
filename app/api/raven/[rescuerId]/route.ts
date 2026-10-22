// Compact view for the RAVEN phone app (poll every 1-2 s).
import { connection } from "next/server";
import type { Mission, RavenView, Rescuer, StatusReport } from "@/lib/types";
import { one } from "@/lib/db";
import { PERIMETER, getClock, isPerimeterActive } from "@/lib/replay";
import { haversineM, missionNumber } from "@/lib/sim";
import { etaMinutes } from "@/lib/dispatcher";
import { guard, jsonError, latestBestForecast, loadTarget, waterAt } from "@/lib/state";


export async function GET(_req: Request, { params }: { params: Promise<{ rescuerId: string }> }) {
  await connection();
  return guard(async () => {
    const { rescuerId } = await params;
    const rescuer = await one<Rescuer>("select * from rescuers where id = $1", [rescuerId]);
    if (!rescuer) return jsonError(404, `Rescuer ${rescuerId} not found`);
    const [perimeterActive, forecast, m] = await Promise.all([
      isPerimeterActive(),
      latestBestForecast(),
      one<Mission>("select * from missions where rescuer_id = $1 and status <> 'done' order by id desc limit 1", [rescuerId]),
    ]);
    const pos = rescuer.lat != null && rescuer.lon != null
      ? { lat: rescuer.lat, lon: rescuer.lon }
      : rescuer.home_lat != null && rescuer.home_lon != null ? { lat: rescuer.home_lat, lon: rescuer.home_lon } : null;

    let alert: RavenView["alert"] = null;
    if (perimeterActive && pos) {
      const distanceKm = haversineM(pos, PERIMETER.center) / 1000;
      if (distanceKm <= PERIMETER.radiusKm) {
        alert = {
          title: "Flood emergency · Vidourle",
          distanceKm: Math.round(distanceKm * 10) / 10,
          overflowEta: forecast?.eta_crossing ?? null,
          confidence: forecast?.confidence ?? 0,
        };
      }
    }

    let mission: RavenView["mission"] = null;
    if (m) {
      const t = await loadTarget(m.target_type, m.target_id);
      if (t) {
        // personal details are only exposed here, to the rescuer this target is assigned to
        const st = t.type === "resident"
          ? await one<StatusReport>("select * from status_reports where resident_id = $1 order by created_at desc, id desc limit 1", [t.id])
          : null;
        const water = waterAt(t.lat, t.lon);
        const distanceM = pos ? Math.round(haversineM(pos, t)) : 0;
        const hazards = [...(water.hasWater ? ["Moving water"] : []), "Debris", "Power lines"];
        mission = {
          mission: m,
          number: missionNumber(m.id),
          target: {
            type: t.type, id: t.id, name: t.name, age: t.age, language: t.language, mobility: t.mobility,
            canClimbStairs: st?.can_climb_stairs ?? null, address: t.address, lat: t.lat, lon: t.lon, persona: t.persona,
          },
          waterNowM: water.nowM,
          waterPeakM: water.peakM,
          waterEta: water.eta,
          routeNote: m.route_note,
          distanceM,
          etaMin: etaMinutes(distanceM), // same formula as the ARK draft
          hazards,
        };
      }
    }
    const view: RavenView = { clock: getClock(), rescuer, alert, mission };
    return Response.json(view, { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  });
}
