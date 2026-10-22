# ElevenLabs agent for DOVE (Noé · Sommières flood line)

Create this agent via the ElevenLabs MCP (or the dashboard: Agents → New agent → Blank). DOVE (`/dove/[residentId]`) starts it in the browser over WebRTC with `@elevenlabs/react` (`useConversation().startSession({ agentId, connectionType: "webrtc", dynamicVariables, overrides })`). No phone number is needed.

**Created on 2026-10-22 via the API:** agent `agent_5801m5hqx580e8vsr5g7bkkzd33n`, client tool `report_status` = `tool_8701m5hqwscjf4sa1hj0jrh738nx`, voice Sarah (`EXAVITQu4vr4xnSDxMaL`), LLM `claude-haiku-5-5`. Inline `prompt.tools` is deprecated: the tool is its own resource, attached with `prompt.tool_ids`.

The agent speaks **English** to every resident. `FORCE_LANG` in `app/api/dove/[residentId]/route.ts` sets this; set it to `null` to go back to each resident's own language (copy exists for fr/es/ar/pt/en, see §4).

## 1. Agent

| Setting | Value |
|---|---|
| Name | `Noé · Sommières flood line` |
| Default language | `en` (English) |
| Additional languages | none |
| LLM | `claude-haiku-5-5` (fast, reliable tool calls; low latency matters more than depth) |
| Temperature | 0.25 |
| Voice | Sarah, "Mature, Reassuring, Confident" (`EXAVITQu4vr4xnSDxMaL`), TTS model `eleven_flash_v2`. ElevenLabs requires English agents to use a turbo/flash **v2** model; multilingual needs `eleven_flash_v2_5`. |
| Max call duration | 300 s |
| Authentication | OFF (public agent, demo only) |

## 2. System prompt (paste as is; the `{{...}}` are dynamic variables)

```
You are Noé, the flood safety assistant of the town of {{town}}.
The river is rising. Water may reach {{name}}'s home in {{eta}}.
Official instruction to pass on: {{instruction}}
Rules: always speak English. Speak calmly, short sentences, one question at a time.
Give NO safety advice other than the official instruction. Never promise an arrival time.
Find out: 1) are you safe right now, 2) can you go upstairs on your own,
3) is anything making it harder (alone, health, someone else at home, water already inside).
Judge the urgency from everything the person says and how they say it, then call the tool report_status:
- urgent: in danger now or cannot reach safety alone. Water inside or at the door, cannot move or climb
  the stairs, hurt, trapped, medical emergency, panicking or confused.
- unstable: OK right now but fragile. Upstairs or dry, but alone and frail, reduced mobility, worried or
  unsure, needs medication or powered medical equipment, someone at home may need help, water very close.
- ok: safe and calm, upstairs or on high ground, can manage on their own.
Call report_status as soon as you have a first answer, and call it again whenever the situation changes.
If urgent: tell them the rescue team has been notified and stay on the line.
If life is in immediate danger, tell them to call 112.
```

Note: we send `eta` already phrased with its own "about" (e.g. `about 1 hour 20 minutes`), so the prompt says "in {{eta}}" to avoid "about about". When the model has no ETA for that home, DOVE sends `the coming hours`.

### Dynamic variables (sent by DOVE on every call)

| Variable | Example (res-garcia) | Placeholder default to set in the agent (for dashboard tests) |
|---|---|---|
| `town` | `Sommières` | `Sommières` |
| `name` | resident name from the DB (`Mrs Garcia`) | `Mrs Martin` |
| `eta` | `about 1 hour 20 minutes` | `about 1 hour` |
| `instruction` | `Go upstairs now and do not go down to the garage or basement.` | `Go upstairs now and do not go down to the garage or basement.` |

## 3. First message

Default (used only when no override is sent):

```
Good evening, {{name}}. This is Noé, calling for the town of {{town}}. The river is rising. {{instruction}} Are you safe right now?
```

DOVE always overrides it (built in `lib/dove-copy.ts` → `firstMessage()`) so the greeting matches the simulated time of day (Good morning / afternoon / evening).

## 4. Security tab → Overrides (REQUIRED, otherwise the session is rejected)

Enable the override for:
- **First message**

Only if you set `FORCE_LANG` back to `null` (multilingual), also enable **Language** and add `fr`, `es`, `ar`, `pt` as additional languages, then change "always speak English" in the prompt to "always answer in the person's language". DOVE sends the language override only for non-English residents.

No allowlist is required for the demo; if you add one, include the host serving DOVE (the Aiven Runtime URL).

## 5. Client tool `report_status`

Tools → Add tool → **Client** tool:

| Field | Value |
|---|---|
| Name | `report_status` |
| Description | `Record how urgent the resident's situation is, for the rescue team. Call it as soon as you have a first answer, and again whenever the situation changes. Judge urgency from the whole conversation.` |
| **Wait for response** | **ON** |
| Response timeout | 10 s |

Parameters:

| Name | Type | Required | Description |
|---|---|---|---|
| `urgency` | string, enum `ok` \| `unstable` \| `urgent` | yes | `urgent`: in danger now or cannot reach safety alone. `unstable`: OK right now but fragile (alone and frail, reduced mobility, worried, medical needs, water very close). `ok`: safe, calm, can manage alone. |
| `can_climb_stairs` | boolean | no | Whether the person can go upstairs on their own. |
| `notes` | string | no | Short English note for rescuers (e.g. "cannot climb stairs, alone, ground floor"). |

The browser handler maps `urgency` to the stored status and POSTs `/api/status {residentId, status, can_climb_stairs, notes, channel: "voice"}`, then returns `"recorded"` (or a short "not recorded: ask the person to press the button on their screen"). The latest report wins, so a second call with a new urgency updates the map.

| `urgency` | stored `status` | ARK map | What NOÉ does |
|---|---|---|---|
| `urgent` | `needs_help` | blinking red triangle | copilot drafts a rescuer immediately (T3 if water is there) |
| `unstable` | `unstable` | blinking yellow triangle | shown to the commander to watch |
| `ok` | `safe` | yellow dot | nothing more |

JSON shape for the MCP / API (`conversation_config.agent.prompt.tools[]`):

```json
{
  "type": "client",
  "name": "report_status",
  "description": "Record how urgent the resident's situation is, for the rescue team. Call it as soon as you have a first answer, and again whenever the situation changes. Judge urgency from the whole conversation.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "required": ["urgency"],
    "properties": {
      "urgency": {
        "type": "string",
        "enum": ["ok", "unstable", "urgent"],
        "description": "urgent: in danger now or cannot reach safety alone. unstable: OK right now but fragile (alone and frail, reduced mobility, worried, medical needs, water very close). ok: safe, calm, can manage alone."
      },
      "can_climb_stairs": { "type": "boolean", "description": "Whether the person can go upstairs on their own" },
      "notes": { "type": "string", "description": "Short English note for rescuers" }
    }
  }
}
```

Overrides in the API shape: `platform_settings.overrides.conversation_config_override.agent = { "first_message": true }`.

## 6. Env var

The created agent's id is the default in `app/api/dove/[residentId]/route.ts` (`DEFAULT_AGENT_ID`; it is public, every DOVE browser receives it), so nothing has to be set on Aiven. To use another agent, set its id where the server runs (Aiven Runtime service env vars, or `.env.local` locally), then restart (no rebuild needed: `GET /api/dove/[residentId]` reads it on the server at request time and returns it as `agentId`):

```
ELEVENLABS_AGENT_ID=agent_xxxxxxxxxxxxxxxxxxxxxxxx
```

`NEXT_PUBLIC_ELEVENLABS_AGENT_ID` is still honoured (server-side first, then the build-time client value), but a `NEXT_PUBLIC_` value is frozen at `next build`, so prefer `ELEVENLABS_AGENT_ID`.

If it is missing or the session fails, DOVE stays on the call screen with "Voice unavailable · use the buttons", reads the first message with the browser's speech synthesis, and the buttons still report to `/api/status` (channel `button`): **I'm safe** → `safe` (yellow dot), **I need help** → `needs_help` (blinking red triangle).

## 7. Test call script (demo: `/dove/res-garcia`)

Pre-req: HTTPS (the Aiven Runtime URL), phone opened on `/dove/res-garcia`, tap **Arm**. For a UI-only test without the backend, open `/dove/res-garcia?demo=1` and use "Simulate alert (demo)".

1. NOÉ inserts a `dove_calls` row (`state='ringing'`) → the phone rings → tap **Accept**.
2. Agent: "Good evening, Mrs Garcia. This is Noé, calling for the town of Sommières. The river is rising. Go upstairs now and do not go down to the garage or basement. Are you safe right now?"
3. Presenter: **"I can't climb the stairs."**
4. Expected: the agent calls `report_status { urgency: "urgent", can_climb_stairs: false, notes: "cannot climb stairs" }` → DOVE shows "Your answer reached the rescue team." → ARK shows a blinking red triangle on Mrs Garcia and the copilot proposes a rescuer. The agent says the rescue team has been notified, stays on the line and gives **no arrival time**.
5. Variants to try:
   - "Yes, I'm fine, I'm upstairs with my son." → `ok` → yellow dot.
   - "I'm upstairs, but I'm alone and my oxygen machine needs power." → `unstable` → blinking yellow triangle.
   - Escalation: start with "I'm upstairs, I'm fine", then "wait, water is coming under the door and my husband is still downstairs" → a second `report_status` with `urgent` → the dot turns into a blinking red triangle.
   - "I'm stuck, the water is coming in!" → `urgent` immediately, mentions 112.
