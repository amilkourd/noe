# ElevenLabs agent for DOVE (Noé · Sommières flood line)

Create this agent via the ElevenLabs MCP (or the dashboard: Agents → New agent → Blank). DOVE (`/dove/[residentId]`) starts it in the browser over WebRTC with `@elevenlabs/react` (`useConversation().startSession({ agentId, connectionType: "webrtc", dynamicVariables, overrides })`). No phone number is needed.

## 1. Agent

| Setting | Value |
|---|---|
| Name | `Noé · Sommières flood line` |
| Default language | `fr` (French) |
| Additional languages | `es`, `ar`, `pt`, `en` (add them so the per-call language override is accepted) |
| LLM | a fast model (e.g. `gemini-2.5-flash` or `gpt-4o-mini`, whichever is the fastest one offered; low latency matters more than depth) |
| Temperature | 0.2 to 0.3 |
| Voice | a calm, warm voice that works with a **multilingual** TTS model (e.g. `eleven_flash_v2_5` or `eleven_multilingual_v2`; Flash is lower latency). Pick a voice from the library tagged "calm"/"narration", not an energetic one. |
| Max call duration | 300 s |
| Authentication | OFF (public agent, demo only) |

## 2. System prompt (paste as is; the `{{...}}` are dynamic variables)

```
You are Noé, the flood safety assistant of the town of {{town}}.
The river is rising. Water may reach {{name}}'s home in {{eta}}.
Official instruction to pass on: {{instruction}}
Rules: speak calmly, short sentences, one question at a time. Give NO safety advice other than the official instruction.
Ask: 1) are you safe right now, 2) can you go upstairs on your own.
As soon as you know, call the tool report_status.
If the person cannot move, is hurt or panicking: report_status with status=needs_help immediately,
tell them the rescue team has been notified, and stay on the line. Never promise an arrival time.
If life is in immediate danger, tell them to call 112. Always answer in the person's language.
```

Note: the spec text says "in about {{eta}}"; we send `eta` already phrased in the resident's language with its own "about" (e.g. `aproximadamente 1 hora y 20 minutos`, `about 1 hour 20 minutes`), so the prompt says "in {{eta}}" to avoid "about about". When the model has no ETA for that home, DOVE sends "the coming hours" in the resident's language.

### Dynamic variables (sent by DOVE on every call)

| Variable | Example (res-garcia, es) | Placeholder default to set in the agent (for dashboard tests) |
|---|---|---|
| `town` | `Sommières` | `Sommières` |
| `name` | resident name from the DB | `Madame Martin` |
| `eta` | `aproximadamente 1 hora y 20 minutos` | `environ 1 heure` |
| `instruction` | `Suba al piso de arriba ahora y no baje al garaje ni al sótano.` | `Montez à l'étage maintenant et ne descendez pas au garage ni à la cave.` |

## 3. First message

Default (French, used only when no override is sent):

```
Bonsoir, {{name}}. Ici Noé, de la mairie de {{town}}. La rivière monte. {{instruction}} Êtes-vous en sécurité en ce moment ?
```

DOVE always overrides it per language (built in `lib/dove-copy.ts` → `firstMessage()`), e.g. ES:

```
Buenas noches, <name>. Le llama Noé, del Ayuntamiento de Sommières. El río está subiendo. Suba al piso de arriba ahora y no baje al garaje ni al sótano. ¿Está usted a salvo ahora?
```

## 4. Security tab → Overrides (REQUIRED, otherwise the session is rejected)

Enable overrides for:
- **First message**
- **Language**

(Leave the others off.) No allowlist is required for the demo; if you add one, include the tunnel host serving DOVE.

## 5. Client tool `report_status`

Tools → Add tool → **Client** tool:

| Field | Value |
|---|---|
| Name | `report_status` |
| Description | `Record the resident's situation for the rescue team. Call it as soon as you know whether the person is safe and whether they can go upstairs on their own. Call it immediately with status=needs_help if they cannot move, are hurt or panicking.` |
| **Wait for response** | **ON** |
| Response timeout | 10 s |

Parameters:

| Name | Type | Required | Description |
|---|---|---|---|
| `status` | string, enum `safe` \| `needs_help` | yes | `safe` if the person is safe and can go upstairs; otherwise `needs_help`. |
| `can_climb_stairs` | boolean | no | Whether the person can go upstairs on their own. |
| `notes` | string | no | Short English note for rescuers (e.g. "cannot climb stairs, alone, ground floor"). |

The browser handler POSTs `/api/status {residentId, status, can_climb_stairs, notes, channel: "voice"}` and returns `"recorded"` (or a short "not recorded: ask the person to press the button on their screen").

JSON shape for the MCP / API (`conversation_config.agent.prompt.tools[]`):

```json
{
  "type": "client",
  "name": "report_status",
  "description": "Record the resident's situation for the rescue team. Call it as soon as you know whether the person is safe and whether they can go upstairs on their own. Call it immediately with status=needs_help if they cannot move, are hurt or panicking.",
  "expects_response": true,
  "response_timeout_secs": 10,
  "parameters": {
    "type": "object",
    "required": ["status"],
    "properties": {
      "status": { "type": "string", "enum": ["safe", "needs_help"], "description": "safe if the person is safe and can go upstairs; otherwise needs_help" },
      "can_climb_stairs": { "type": "boolean", "description": "Whether the person can go upstairs on their own" },
      "notes": { "type": "string", "description": "Short English note for rescuers" }
    }
  }
}
```

Overrides in the API shape: `platform_settings.overrides.conversation_config_override.agent = { "first_message": true, "language": true }`.

## 6. Env var

Put the agent id in `.env.local`, then restart `npm start` (no rebuild needed: `GET /api/dove/[residentId]` reads it on the server at request time and returns it as `agentId`):

```
ELEVENLABS_AGENT_ID=agent_xxxxxxxxxxxxxxxxxxxxxxxx
```

`NEXT_PUBLIC_ELEVENLABS_AGENT_ID` is still honoured (server-side first, then the build-time client value), but a `NEXT_PUBLIC_` value is frozen at `next build`, so prefer `ELEVENLABS_AGENT_ID`.

If it is missing or the session fails, DOVE stays on the call screen with "Voice unavailable · use the buttons", reads the first message with the browser's speech synthesis, and the I'm safe / I need help buttons still report to `/api/status` (channel `button`).

## 7. Test call script (demo: `/dove/res-garcia`, Spanish)

Pre-req: HTTPS (tunnel), phone opened on `/dove/res-garcia`, tap **Arm**. For a UI-only test without the backend, open `/dove/res-garcia?demo=1` and use "Simulate alert (demo)".

1. NOÉ inserts a `dove_calls` row (`state='ringing'`) → the phone rings → tap **Aceptar**.
2. Agent (ES): "Buenas noches, … Le llama Noé, del Ayuntamiento de Sommières. El río está subiendo. Suba al piso de arriba ahora y no baje al garaje ni al sótano. ¿Está usted a salvo ahora?"
3. Presenter: **"No puedo subir las escaleras."**
4. Expected: the agent calls `report_status { status: "needs_help", can_climb_stairs: false, notes: "cannot climb stairs" }` → DOVE shows "Su respuesta ha llegado al equipo de rescate." → ARK shows a red triangle on Mrs Garcia. The agent says the rescue team has been notified, stays on the line and gives **no arrival time**.
5. Variants to try: "Sí, estoy bien, ya estoy arriba" → `safe`, `can_climb_stairs: true`. In French: "Je suis coincée, l'eau rentre" → `needs_help` immediately, mentions 112.
