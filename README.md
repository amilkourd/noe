# NOÉ · flood decision copilot (hackathon demo)

NOÉ is the "brain": a long-running Node process inside this Next.js server. It replays real Hub'Eau gauge data for the Vidourle (19–20 Oct 2026), forecasts the Sommières overflow, maps exposure with an approximate flood model, places DOVE calls, drafts rescuer assignments and produces copilot suggestions. A human always gives the order.

Surfaces:
- **DOVE** (resident, web): `/dove/[residentId]`, which rings in the browser and runs an ElevenLabs Agent over WebRTC.
- **RAVEN** (rescuer, Expo app, built separately): polls `GET /api/raven/[rescuerId]` and uses the PATCH endpoints.
- **ARK** (command, web): not built yet. It consumes `GET /api/state` plus the SSE stream at `GET /api/stream`.

Honesty labels used everywhere:
- "REPLAY · real data 19–20 Oct 2026"
- "demo persona"
- "demo threshold" (2.0 m at Sommières)
- "approximate flood model"

## Runbook

### 1. Env vars (`.env.local`, template in `.env.example`)

| var | purpose |
|---|---|
| `DATABASE_URL` | Aiven PostgreSQL (PostGIS) service URI. Any `sslmode` in the URL is ignored in favour of the CA below. |
| `AIVEN_CA_CERT` | Aiven CA PEM. Real newlines, or a single line with literal `\n`. Not needed on Aiven Runtime, which injects `PROJECT_CA_CERT` (read by `lib/db.ts`). |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Copilot LLM (default `claude-sonnet-5-5`). If either is missing or fails, it falls back to template insights. |
| `ELEVENLABS_AGENT_ID` | DOVE voice agent, read at request time, so a restart is enough. `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` also works but is frozen at build. See `docs/elevenlabs-agent.md`. |
| `REPLAY_START`, `REPLAY_END`, `REPLAY_SPEED` | Default `2026-10-20T01:00:00Z` (03:00 Paris, sized for the 3-minute demo; the gauge history before it is still loaded), `2026-10-20T12:00:00Z`, `60` (1 real s = 60 sim s). `reset` restores this speed. |

### 2. One-time setup

```bash
npm install
# data/*.json is already built from cached raw data; to rebuild: npm run data:gauges && npm run data:osm && npm run data:terrain && npm run data:personas
npm run db:seed            # drops + recreates every table from db/schema.sql, then loads stations, raw observations, sites, personas
                           # (npm run db:seed -- --dry-run to check without a DB)
```

### 3. Run

Production runs on **Aiven Runtime** from the `Dockerfile` (port 3000). Its HTTPS URL is what phones open, so no tunnel is needed (the mic requires HTTPS). Set the env vars above on the Aiven application, and keep it at **one instance**: the replay clock and agent pipeline live in memory, so ARK, DOVE and RAVEN must all hit the same process.

```bash
npm run smoke -- https://<app>.aiven.app   # optional rehearsal against the deployed app (it resets and runs at ×600)
```

Locally:

```bash
npm run build && npm start                     # http://localhost:3000
cloudflared tunnel --url http://localhost:3000 # only for phone tests against a local server
```

Before going on stage, run `POST /api/replay {"action":"reset"}`. A fresh process does not truncate the previous run's data, and reset also restores the ×60 speed.

### 4. Demo URLs

- `/dove/res-garcia` is the resident phone (Mrs Garcia, demo persona; the agent speaks English). Tap once to arm it (audio, mic, wake lock). Add `?demo=1` to get a "Simulate alert" button that works without the backend. The agent rates each call `urgent` / `unstable` / `ok` (stored as `needs_help` / `unstable` / `safe`); see `docs/elevenlabs-agent.md`.
- `/api/raven/rb-karim` is the RAVEN view for Karim Becker (DLRG, T3). The app sends `PATCH /api/rescuers/rb-karim {"available":true}`. Coordinates are ignored for demo personas.
- `/api/state` is the full snapshot for ARK, and `/api/stream` is SSE. Add `?tables=dove_calls,reset,clock` to filter the event types.
- `/api/evidence` gives the pitch numbers, each labelled REPLAY or SCENARIO · simulated personas.
- `/api/terrain` serves the grid, roads and river for the map.

### 5. Replay controls

```bash
curl -X POST $URL/api/replay -H 'content-type: application/json' -d '{"action":"start"}'
curl -X POST $URL/api/replay -H 'content-type: application/json' -d '{"action":"pause"}'
curl -X POST $URL/api/replay -H 'content-type: application/json' -d '{"action":"speed","speed":120}'   # clamped 10..600
curl -X POST $URL/api/replay -H 'content-type: application/json' -d '{"action":"reset"}'
```

The 3-minute demo at ×60 from 03:00 Paris: perimeter alert on RAVEN at 03:15 (0:15), live DOVE call to `res-garcia` at 03:30 (0:30). The call slows the replay to ×10, so the spoken ETA stays true. When ARK sends a rescuer to `res-garcia`, the replay goes back to the speed it had before the call. The river crosses 2 m at 04:10 and the water reaches her door around 04:45, about a minute after the order. Changing the speed by hand during the call cancels the automatic return.

### Other endpoints

- `PATCH /api/rescuers/[id]` with `{available}`
- `POST /api/missions` with `{rescuerId,targetType,targetId,requiredTier,routeNote?,insightId?}`. Returns 409 with `T3_REQUIRED`, `RESCUER_BUSY` or `RESCUER_UNAVAILABLE`, and is idempotent per rescuer and target.
- `PATCH /api/missions/[id]`
- `POST /api/status` with `{residentId,status,can_climb_stairs?,notes?,channel}`
- `PATCH /api/insights/[id]`
- `GET /api/dove/[residentId]`
- `PATCH /api/dove-calls/[id]` with `{state}`

### Offline checks (no DB)

```bash
npx tsc --noEmit
npx tsx scripts/sim-offline.ts   # replays the real data through forecaster, exposure, dispatcher and template copilot
```
