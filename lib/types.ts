// Shared contracts between NOÉ (server), ARK (web), DOVE (web) and RAVEN (Expo app).
// Row types mirror db/schema.sql. Numeric columns come back from `pg` as strings
// unless converted: lib/db.ts registers parsers so numerics arrive as numbers.

export type StationRole = "upstream" | "mid" | "target" | "downstream";
export type Tier = "T1" | "T2" | "T3";
export type Mobility = "ok" | "reduced" | "bedridden";
export type SiteKind = "care_home" | "school" | "campsite" | "hospital";
export type MissionStatus = "sent" | "accepted" | "en_route" | "on_site" | "done" | "backup";
// Urgency judged from the DOVE call: needs_help = urgent, unstable = OK for now but fragile, safe = not urgent.
export type ResidentStatus = "safe" | "unstable" | "needs_help";
export type DoveCallState = "ringing" | "accepted" | "declined" | "ended" | "missed";
export type AgentName = "watcher" | "forecaster" | "exposure" | "dispatcher" | "voice" | "copilot" | "replay";
export type DataMode = "REPLAY" | "SCENARIO" | "LIVE";
// Géorisques TRI flood-hazard scenarios (EU Floods Directive): 10–30 yr, 100–300 yr ("centennal"), ≥ 1000 yr
export type FloodZoneScenario = "frequent" | "medium" | "extreme";

export interface Station {
  code: string; name: string; river: string | null; role: StationRole;
  lat: number; lon: number; threshold_m: number | null; threshold_label: string | null;
}
export interface Observation { station_code: string; ts: string; h_m: number; source: string }
export interface Site {
  id: string; kind: SiteKind; name: string; capacity: number | null;
  lat: number; lon: number; elevation_m: number | null; source: string;
  // official directories (Annuaire de l'éducation, FINESS); elevation_m is IGN RGE ALTI when available
  category?: string | null; ref?: string | null; address?: string | null; phone?: string | null; capacity_source?: string | null;
  official_zone?: FloodZoneScenario | null;   // most frequent Géorisques scenario covering the site (PostGIS)
  official_depth?: string | null;             // Géorisques water depth class in the medium (100-yr) scenario, e.g. "1–2 m"
}
export interface Resident {
  id: string; name: string; age: number | null; language: string; mobility: Mobility; floor: number;
  address: string | null; lat: number; lon: number; elevation_m: number | null; persona: boolean;
  official_zone?: FloodZoneScenario | null;
}
export interface Rescuer {
  id: string; name: string; org: string | null; country: string | null; tier: Tier; available: boolean;
  lat: number | null; lon: number | null; home_lat: number | null; home_lon: number | null;
  updated_at: string; persona: boolean;
}
export interface Forecast {
  id: number; created_at: string; sim_time: string; station_code: string; h_now_m: number;
  rate_cm_h: number | null; eta_crossing: string | null; peak_h_m: number | null; peak_time: string | null;
  confidence: number; model: "trend_v0" | "lag_v1"; threshold_m: number;
}
export interface Exposure {
  id: number; forecast_id: number; target_type: "site" | "resident"; target_id: string;
  eta: string | null; depth_m: number | null; priority: number;
}
export interface Mission {
  id: number; created_at: string; rescuer_id: string; target_type: "site" | "resident"; target_id: string;
  route_note: string | null; required_tier: Tier; insight_id: number | null; status: MissionStatus;
}
export interface StatusReport {
  id: number; resident_id: string; status: ResidentStatus; can_climb_stairs: boolean | null;
  notes: string | null; channel: "voice" | "button"; created_at: string;
}
// rain = Météo-France station code; official = a public reference ("vigicrues", "georisques", "insee", "ban")
export interface InsightSource { type: "gauge" | "site" | "resident" | "rescuer" | "road" | "model" | "rain" | "official"; id: string }
export interface InsightAction {
  type: "assign_mission" | "approve_preevacuation" | "none";
  payload: { rescuerId?: string; targetType?: "site" | "resident"; targetId?: string; routeNote?: string; requiredTier?: Tier; [k: string]: unknown };
}
export interface Insight {
  id: number; created_at: string; sim_time: string | null; kind: "assignment" | "forecast" | "site" | "route" | "resource";
  priority: number; title: string; detail: string; confidence: number; sources: InsightSource[];
  action: InsightAction; status: "open" | "accepted" | "dismissed"; origin: "llm" | "template";
}
export interface AgentLog { id: number; ts: string; sim_time: string | null; agent: AgentName; message: string; data: unknown }
export interface DoveCall { id: number; resident_id: string; created_at: string; state: DoveCallState }

// ---- public reference data (scripts/fetch-official.ts, fetch-rain.ts, fetch-population.ts, fetch-official-sites.ts)
export interface Flow { station_code: string; ts: string; q_m3s: number; source: string }   // Hub'Eau discharge, m³/s
export interface RainStation {
  code: string; name: string; lat: number; lon: number; alt_m: number | null;
  basin: boolean;      // inside the Vidourle catchment (others: neighbouring basins, storm context only)
  upstream: boolean;   // in the catchment upstream of the Sommières gauge
}
export interface RainObs { station_code: string; ts: string; rr1_mm: number }                // Météo-France: mm in the hour ending at ts
export interface HistoricFlood { station_code: string; label: string; h_m: number | null; q_m3s: number | null } // Vigicrues
export interface Vigilance { code: string; name: string; level: number; label: string; fetched_at: string }   // Vigicrues snapshot
export interface Commune {
  code: string; name: string; population: number | null; lat: number; lon: number;
  flood_disasters: number; last_flood_disaster: string | null;   // Géorisques CatNat "Inondations" declarations
}
export interface DataSource { id: string; name: string; url: string; licence: string; usedFor: string }
/** Real people in a flood footprint: INSEE 2019 200 m grid + BAN addresses, over the approximate flood model. */
export interface PopulationExposed {
  inhabitants: number; aged80p: number; aged65_79: number; under4: number; singlePersonHouseholds: number; addresses: number;
}
/** Static public references for surfaces (polygons are served by GET /api/official). */
export interface OfficialContext {
  historicFloods: HistoricFlood[];
  vigilance: Vigilance | null;   // Vigicrues level at fetch time: no archive exists, so it is NOT the 19–20 Oct level
  communes: Commune[];
  sources: DataSource[];
}

export interface ReplayClock {
  simTime: string;      // ISO UTC
  speed: number;        // e.g. 60 = 1 real second -> 60 sim seconds
  running: boolean;
  start: string; end: string;
  mode: DataMode;
}

// Flooded cells of the terrain grid at the current sim time (indexes into terrain-grid.json arrays)
export interface FloodState {
  simTime: string; hTarget: number; cells: number[]; depths: number[];
  population?: PopulationExposed | null;   // real inhabitants/addresses in `cells` (INSEE + BAN), approximate
}

// Everything a surface needs on load / reconnect: GET /api/state
export interface NoeState {
  clock: ReplayClock;
  stations: Station[];
  observations: Observation[];          // all copied so far (small: 4 gauges x ~15 min steps)
  latestForecast: Forecast | null;
  forecasts: Forecast[];                // last few, both models
  exposures: Exposure[];                // for latestForecast
  flood: FloodState | null;
  sites: Site[];
  residents: Resident[];
  rescuers: Rescuer[];
  missions: Mission[];
  statuses: StatusReport[];             // latest per resident
  insights: Insight[];                  // open
  logs: AgentLog[];                     // last 50
  doveCalls: DoveCall[];
  perimeter: { active: boolean; center: { lat: number; lon: number }; radiusKm: number };
  flows: Flow[];                        // Hub'Eau discharge copied so far (same replay as observations)
  rain: RainObs[];                      // Météo-France hourly rain copied so far
  rainStations: RainStation[];
  official: OfficialContext;
}

// One SSE message on GET /api/stream. DB rows come from pg_notify; clock/flood are in-memory.
export type NoeEvent =
  | { table: "observations"; op: "INSERT" | "UPDATE"; row: Observation }
  | { table: "flows"; op: "INSERT" | "UPDATE"; row: Flow }
  | { table: "rain"; op: "INSERT" | "UPDATE"; row: RainObs }
  | { table: "forecasts"; op: "INSERT" | "UPDATE"; row: Forecast }
  | { table: "exposures"; op: "INSERT" | "UPDATE"; row: Exposure }
  | { table: "missions"; op: "INSERT" | "UPDATE"; row: Mission }
  | { table: "status_reports"; op: "INSERT" | "UPDATE"; row: StatusReport }
  | { table: "insights"; op: "INSERT" | "UPDATE"; row: Insight }
  | { table: "agent_log"; op: "INSERT" | "UPDATE"; row: AgentLog }
  | { table: "rescuers"; op: "INSERT" | "UPDATE"; row: Rescuer }
  | { table: "dove_calls"; op: "INSERT" | "UPDATE"; row: DoveCall }
  | { table: "clock"; op: "TICK"; row: ReplayClock }
  | { table: "flood"; op: "UPDATE"; row: FloodState }
  | { table: "reset"; op: "RESET"; row: Record<string, never> }
  // LISTEN (re)connected: rows written while it was down were never sent, clients should reload GET /api/state
  | { table: "resync"; op: "RESYNC"; row: Record<string, never> };

// Compact view for the RAVEN phone app: GET /api/raven/[rescuerId] (poll every 1-2 s, or use SSE)
export interface RavenView {
  clock: ReplayClock;
  rescuer: Rescuer;
  alert: null | {
    title: string;                 // "Flood emergency · Vidourle"
    distanceKm: number;            // rescuer -> perimeter centre
    overflowEta: string | null;    // ISO
    confidence: number;            // 0..1
  };
  mission: null | {
    mission: Mission;
    number: string;                // "07"
    target: {
      type: "site" | "resident"; id: string; name: string; age: number | null; language: string | null;
      mobility: Mobility | null; canClimbStairs: boolean | null; address: string | null;
      lat: number; lon: number; persona: boolean;
    };
    waterNowM: number | null; waterPeakM: number | null; waterEta: string | null;
    routeNote: string | null; distanceM: number; etaMin: number;
    hazards: string[];
  };
}
