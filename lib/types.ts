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

export interface Station {
  code: string; name: string; river: string | null; role: StationRole;
  lat: number; lon: number; threshold_m: number | null; threshold_label: string | null;
}
export interface Observation { station_code: string; ts: string; h_m: number; source: string }
export interface Site {
  id: string; kind: SiteKind; name: string; capacity: number | null;
  lat: number; lon: number; elevation_m: number | null; source: string;
}
export interface Resident {
  id: string; name: string; age: number | null; language: string; mobility: Mobility; floor: number;
  address: string | null; lat: number; lon: number; elevation_m: number | null; persona: boolean;
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
export interface InsightSource { type: "gauge" | "site" | "resident" | "rescuer" | "road" | "model"; id: string }
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

export interface ReplayClock {
  simTime: string;      // ISO UTC
  speed: number;        // e.g. 60 = 1 real second -> 60 sim seconds
  running: boolean;
  start: string; end: string;
  mode: DataMode;
}

// Flooded cells of the terrain grid at the current sim time (indexes into terrain-grid.json arrays)
export interface FloodState { simTime: string; hTarget: number; cells: number[]; depths: number[] }

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
}

// One SSE message on GET /api/stream. DB rows come from pg_notify; clock/flood are in-memory.
export type NoeEvent =
  | { table: "observations"; op: "INSERT" | "UPDATE"; row: Observation }
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
  | { table: "reset"; op: "RESET"; row: Record<string, never> };

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
