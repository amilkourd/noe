# RAVEN design system: "ink & cream"

RAVEN is the rescuer's phone app in NOÉ (Expo SDK 58, HeroUI Native 1.x, Uniwind, Jost). It is **one screen**: a dark
*instrument* on top and a cream *card* at the bottom, both driven by the polled `RavenView`
(`GET /api/raven/[rescuerId]`, contract in `../lib/types.ts`). The visual language comes from a minimal
espresso-machine concept: a near-black body, a tick-ring gauge with a bright "head", an organic blob with a knob,
tiny letter-spaced uppercase labels, light geometric numerals with superscript units, and a cream card ending in two dark pills.

## Principles

1. **One screen, one primary action.** No navigation. The phase decides what the instrument and the card show. The card never shows more than one primary button.
2. **Monochrome, one signal.** Ink, cream and paper do everything. `ember` is used *only* for flood danger (alert ticks, hazard tags, backup). `water` and `sage` are reserved for small accents and are never used for large fills.
3. **Numbers are the interface.** Big hairline numerals with a superscript unit (`46%`, `1:40 h`, `0.8 m`) and a tiny label under each one.
4. **Readable in the field.** Primary pills are 56 pt tall and the full gauge is visible at arm's length. Body text is ≥ 13 pt, except the tiny uppercase labels, which are decoration and are never the only carrier of meaning.

## Tokens (`global.css` @theme, hex mirror in `src/ds/tokens.ts`)

| token (class suffix) | hex | use |
|---|---|---|
| `ink` | #242424 | app background, the instrument |
| `ink-raised` | #2c2c2c | toggle track |
| `pill` | #303030 | dark pills on cream (primary button, step pill) |
| `pill-active` | #484848 | selected circle inside a pill |
| `pill-faint` | #5a5a5a | faint marks on a pill (steps still to come) |
| `tick` | #3d3d3d | idle gauge ticks |
| `ash` | #949089 | muted text on ink (4.9:1 on ink) |
| `paper` | #f2eee9 | text on ink, knob, bright ticks |
| `cream` | #e8e5dd | card |
| `cream-deep` | #dedad1 | pressed / inset on cream |
| `cream-line` | #d2cdc3 | hairlines and tag borders on cream |
| `taupe` | #66615a | muted text on cream (4.9:1 on cream) |
| `coal` | #262626 | text on cream |
| `mauve` | #706161 | blob rim / outer gradient |
| `cocoa` | #322f2e | blob core |
| `ember` | #e07a5f | flood danger, the only loud color |
| `water` | #8fb3c4 | water accent (small dots only) |
| `sage` | #a3b79c | done / safe accent (small) |

The HeroUI semantic variables are mapped in `global.css`: `background`=ink, `foreground`=paper, `surface`=cream (with coal
foreground), `overlay`=cream (so Dialog and Toast are cream sheets), `accent`=#2a2a2a (with paper foreground), `default`=pill,
`danger`=ember, `muted`=#7a746c. The app is dark-only: `Uniwind.setTheme("dark")`, and both variants hold the same values.

**Known HeroUI quirks (verified in Expo Go):**
- `Card.Title` / `Card.Description` default to the paper `foreground` color, so on the cream card always pass `className="text-coal"` / `"text-taupe"`, or use the RAVEN text components instead.
- `flex-1` on a `Button` inside a column container collapses it to 0 height. Use `self-stretch` or put it in a `flex-row` parent.

App shell (`App.tsx`): `global.css` is the first import. Then `GestureHandlerRootView` > `SafeAreaProvider` > `HeroUINativeProvider`.
The safe-area provider is required because HeroUI only listens for insets, while its toasts and the screen read them.
A plain `bg-ink` view shows while the fonts load. If the fonts fail, the app falls back to the system font.

### Typography (Jost, loaded with `@expo-google-fonts/jost` in `App.tsx`)

Font families are separate per weight. Use the family classes, never a numeric `font-weight`:
`font-hair` (200), `font-light` (300), `font-normal` (400), `font-medium` (500), `font-semibold` (600), `font-bold` (700).

| role | family | size / tracking | color |
|---|---|---|---|
| Display (gauge numeral) | hair | 76 / -1 | paper |
| Display unit (superscript) | normal | 14, raised to the numeral's cap height | ash |
| Gauge caption | normal | 11 | ash |
| Eyebrow (tiny caps) | semibold | 9, tracking 2, uppercase | ash on ink · taupe on cream · ember for danger |
| Card title | semibold | 26, at most 2 lines (shrinks to ×0.75 first) | coal |
| Card subtitle | light | 24, at most 2 lines (shrinks to ×0.75 first) | taupe |
| Stat value | light | 30 | coal |
| Stat unit (superscript) | normal | 11 | taupe |
| Stat label | medium | 11 | coal |
| Tag (needs, hazards) | medium | 11 / tracking 1, uppercase | coal (never ember text: ember on cream is 2.3:1) |
| Body / note | normal | 13–14 | taupe |
| Pill label | normal | 18 | paper |

### Shape and space
- Card: `rounded-[36px]`, 10 pt from the screen edges and above the bottom safe area, padding 24 (top 28), content **centered**.
- Pills: `rounded-full`, height 56. Step circles are 44.
- Toggle: 64×34 track, 28 thumb.
- The spacing scale is multiples of 4. The instrument takes all the remaining height and is vertically centered.

## Components (`src/ds/`, barrel `src/ds/index.ts`)

All of them are thin wrappers over HeroUI Native or RN primitives, styled with Uniwind classes. Colors that SVG needs come from `tokens.ts`.

```ts
// Text.tsx
// Display: hair numeral + superscript unit + caption. One accessible text: accessibilityLabel, else "{value} {unit}, {caption}".
export function Display(p: { value: string; unit?: string; caption?: string; accessibilityLabel?: string }): JSX.Element
export function Eyebrow(p: { children: string; tone?: "ash" | "taupe" | "ember" | "paper"; className?: string }): JSX.Element
// Title and Subtitle hold at most 2 lines and shrink to ×0.75 before truncating: names come straight from the data.
export function Title(p: { children: React.ReactNode; className?: string }): JSX.Element        // on cream
export function Subtitle(p: { children: React.ReactNode; className?: string }): JSX.Element     // on cream
export function Note(p: { children: React.ReactNode; className?: string; numberOfLines?: number }): JSX.Element  // body on cream

// Stat.tsx
// Spoken as "{label}: {value} {unit}" unless accessibilityLabel is given (countdowns pass words: "Water in: 1 hour 40 minutes").
export function Stat(p: { value: string; unit?: string; label: string; dot?: "water" | "ember" | "sage"; accessibilityLabel?: string }): JSX.Element
export function StatRow(p: { children: React.ReactNode }): JSX.Element   // evenly spaced, 2 or 3 stats

// TickRing.tsx: react-native-svg + reanimated. A ring of `ticks` radial ticks (idle: tick color, len 12, width 1.5).
// A "head" sits at angle progress*360 (0 = top, clockwise) and lights the 7 ticks ending at the head with a taper:
// length 12→24, width 1.5→4, opacity .35→1 (paper or ember). mode "sweep" rotates the head continuously (one
// turn every 2.4 s, linear) and ignores progress. Children are absolutely centered inside the ring.
// The head snaps to whole ticks. Tail colors are pre-blended over ink, so the ring assumes the ink background.
// With accessibilityLabel the whole gauge is one accessible text (the screen passes "1 hour 40 minutes until overflow").
export function TickRing(p: { size: number; progress?: number; tone?: "paper" | "ember"; mode?: "static" | "sweep"; ticks?: number; children?: React.ReactNode; accessibilityLabel?: string }): JSX.Element

// Approach.tsx: the blob instrument for missions. An organic, slightly asymmetric closed blob (smooth cubic path,
// ~0.8 of size), filled with a radial gradient (cocoa center → mauve edge), with a thin paper rim (1.5, opacity .85).
// Tiny eyebrow labels NORTH (top), SOUTH (bottom), WEST (left, rotated -90°), EAST (right, rotated 90°) outside the blob.
// A 6 pt ash dot marks the center ("you"). The knob (44 pt paper circle with a 6 pt ink dot) sits on the blob at
// `bearing` degrees (0 = north, clockwise) at ~0.72 of the radius; hidden when bearing is null. When `active`, the knob
// breathes (scale 1↔1.06, 1.6 s). The whole instrument is pressable (onPress, e.g. open Maps), with a
// "Navigate to target" accessibility label.
export function Approach(p: { size: number; bearing: number | null; active?: boolean; onPress?: () => void }): JSX.Element

// ActionButton.tsx: HeroUI Button, h-14 rounded-full, label 18 font-normal.
// primary: bg-pill / paper text · secondary: transparent with a 1.5 pt pill border / coal text · danger: bg-ember / coal text.
// block = full width (self-stretch). isLoading shows a HeroUI Spinner over the hidden label (the pill keeps its width,
// presses are ignored, no disabled dimming).
export function ActionButton(p: { label: string; onPress: () => void; variant?: "primary" | "secondary" | "danger"; block?: boolean; isLoading?: boolean; isDisabled?: boolean }): JSX.Element

// StepPill.tsx: dark pill (bg-pill, h-14, rounded-full, px-1.5, flex-row, gap) of `steps.length` 44 pt circles,
// like the "1x + +" segment in the reference. index < current: done, a sage check drawn in SVG (Jost has no "✓" glyph);
// index == current: bg-pill-active circle with the step number in paper; index > current: a faint "+" in pill-faint.
// accessibilityLabel = `Step ${current+1} of ${n}: ${steps[current]}`.
export function StepPill(p: { steps: string[]; current: number; className?: string }): JSX.Element

// DutyToggle.tsx: HeroUI Switch (64×34, track ink-raised) whose thumb (28) carries a tiny label:
// on → thumb right, bg paper, "ON" in coal · off → thumb left, bg pill-active, "OFF" in ash. Light haptic on change.
export function DutyToggle(p: { isOn: boolean; onChange: (next: boolean) => void; isDisabled?: boolean }): JSX.Element

// CreamCard.tsx: HeroUI Card (bg-cream rounded-[36px], no shadow) with an optional centered eyebrow and an
// optional `corner` node pinned to the top-right (e.g. the BACKUP text button). Children are stacked and centered.
// The eyebrow is inset by the corner's measured width on both sides, so at large text sizes it wraps instead of running under it.
export function CreamCard(p: { eyebrow?: string; eyebrowTone?: "taupe" | "ember"; corner?: React.ReactNode; children: React.ReactNode }): JSX.Element

// Tag.tsx: HeroUI Chip restyled: rounded-full, 1 pt cream-line border, transparent bg, coal text (medium 11 / tracking 1, uppercase).
// Tags are the only carrier of needs and hazards, so the text is always coal. tone "ember" (hazard) = ember border plus a 6 pt
// ember dot before the label, spoken as "Hazard: {label}".
export function Tag(p: { label: string; tone?: "coal" | "ember" }): JSX.Element
export function TagRow(p: { children: React.ReactNode }): JSX.Element   // centered wrap, gap 6

// LiveDot.tsx: 6 pt dot. online = paper (static) · offline = ember, blinking · connecting = ash, blinking (each blink restarts from full opacity).
export function LiveDot(p: { state: "online" | "offline" | "connecting" }): JSX.Element
```

## Data (`src/data/`)

```ts
// types.ts: the single shared contract (type-only re-export, erased by Babel, so Metro never resolves it)
export type { RavenView, Rescuer, Mission, MissionStatus, Mobility, ReplayClock } from "../../../lib/types";

// config.ts
export const RESCUER_ID: string   // EXPO_PUBLIC_RESCUER_ID || "rb-karim"
export const DEMO: boolean        // EXPO_PUBLIC_RAVEN_DEMO === "1": run against the in-app scripted backend
export const SEND_GPS: boolean    // EXPO_PUBLIC_RAVEN_GPS === "1" (off by default: a real position outside the Vidourle perimeter hides the alert)
export const NOE_URL: string      // EXPO_PUBLIC_NOE_URL || `http://${host of Constants.expoConfig?.hostUri}:3000` || "http://localhost:3000"

// client.ts
export interface RavenClient {
  getView(signal?: AbortSignal): Promise<RavenView>;
  setAvailable(available: boolean, pos?: { lat: number; lon: number } | null): Promise<void>;   // PATCH /api/rescuers/:id
  setMissionStatus(missionId: number, status: MissionStatus): Promise<void>;                    // PATCH /api/missions/:id
}
export const client: RavenClient    // DEMO ? demoClient : httpClient (4 s timeout; Error.message = server's {error} when present)

// demo.ts: scripted in-memory backend, same interface. Sim clock starts 2026-10-19T19:30:00Z and runs at ×60.
// t+6 s real: perimeter alert (overflowEta = start + 100 sim min, confidence 0.82, distance 3.2 km).
// 4 s after setAvailable(true) during the alert: mission 7 (status "sent") for resident "res-garcia", "Señora García", 84, "es",
// mobility "reduced", canClimbStairs false, "4 rue du Pont, Sommières", ~2.4 km NE of the rescuer; hazards Moving water / Debris / Power lines;
// waterNowM rising 0→1.1 over 90 sim min from 10 sim min after dispatch (so the card shows "Water in" first), peak 1.4,
// routeNote "Avenue Emile Jamais is cut, go in via the Rue de la Taillade". The rescuer sits 3.2 km SW of the perimeter centre.
// Status PATCHes are applied as is; "done" clears the mission (rescuer stays available, so the screen returns to standby).
// One mission per run: no re-dispatch after "done". The demo always plays rb-karim.
export const demoClient: RavenClient
export function createDemoClient(o?: { now?: () => number; latencyMs?: number }): RavenClient   // for node tests

// useRaven.ts
export type Phase = "connecting" | "calm" | "alert" | "standby" | "mission";
//  connecting: no view yet · mission: view.mission · standby: alert && rescuer.available · alert: alert · calm: otherwise
export interface Raven {
  phase: Phase;
  view: RavenView | null;
  online: boolean;                 // false after 3 consecutive failed polls (the last view is kept)
  error: string | null;            // last poll error message
  busy: boolean;                   // an action is in flight
  completed: { number: string; key: number } | null;   // set when a mission we were on disappears or is marked done (toast trigger); a replay reset (clock rewound) completes nothing
  setAvailable(next: boolean): Promise<void>;          // optimistic; with SEND_GPS adds the position (expo-location, Balanced, 5 s timeout, best effort)
  advance(): Promise<void>;        // next step: sent→accepted→en_route (two PATCHes) · accepted→en_route · en_route→on_site · on_site|backup→done
  requestBackup(): Promise<void>; // only while canRequestBackup(status)
  retry(): void;                   // poll now
}
export function useRaven(): Raven
// Polling: one request in flight, setTimeout chain. 1 s in alert/standby/mission, 4 s when calm, 2 s when connecting/offline.
// Paused while AppState is not "active"; polls immediately on return and right after every action.
// Optimistic: actions patch the local view at once, revert on failure and rethrow (the screen toasts the message).
// A second action while one runs resolves without doing anything. createRavenEngine(api, sink, locate) is the
// React-free state machine behind the hook, exported for node tests.

// mission.ts
export function primaryLabel(s: MissionStatus): string | null  // sent "Accept" · accepted "Go" · en_route "On site" · on_site "Done" · backup "Done" · done null
// stepIndex: sent 0 · accepted 0 ("Go" still pending) · en_route 1 · on_site 2 · done 3. "backup" replaces the progress status on
// the server, so it takes the step of `replaced` (the status before the request, remembered by the card), else 1.
// After a backup request the only action left is "Done": any other status would overwrite the "backup" flag ARK shows.
export function stepIndex(s: MissionStatus, replaced?: MissionStatus | null): number
export function canRequestBackup(s: MissionStatus): boolean   // en_route or on_site
export const WET_M = 0.05                                       // the server's wet threshold (lib/state.ts), shared with demo.ts
export const STEPS: string[]                                    // ["Go", "On site", "Done"]
export function statusLabel(s: MissionStatus): string           // "NEW" · "ACCEPTED" · "EN ROUTE" · "ON SITE" · "BACKUP REQUESTED" · "DONE"

// format.ts (all times relative to view.clock.simTime, never the phone clock)
export function countdown(targetIso: string | null, nowIso: string): { value: string; unit: string }  // "1:40" "h" · "38" "min" · "Now" "" · "—" ""
export function spokenCountdown(c: { value: string; unit: string }): string    // "1 hour 40 minutes" · "38 minutes" · "now" · "" (unknown)
export function parisClock(iso: string): string                                 // "20:14" (Intl Europe/Paris, fallback EU DST rule)
export function distance(m: number): { value: string; unit: string }           // "850" "m" · "2.4" "km"
export function depth(m: number | null): { value: string; unit: string }       // "0.8" "m" · "—" ""
export function percent(x: number): { value: string; unit: string }            // "82" "%"
export function languageName(code: string | null): string                      // "es" → "Spanish" …, unknown → code uppercased
export function mobilityTag(m: Mobility | null, canClimbStairs: boolean | null): string[]  // e.g. ["REDUCED MOBILITY", "NO STAIRS"]
export function bearing(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number  // degrees, 0 = north
export function rescuerPosition(r: Rescuer): { lat: number; lon: number } | null // lat/lon, else home_lat/home_lon

// maps.ts
export function openDirections(lat: number, lon: number, label: string): void  // iOS: http://maps.apple.com/?daddr=lat,lon&dirflg=d · Android: google.navigation:q=lat,lon

// attention.ts
export function useAttention(phase: Phase, missionKey: string | null): void   // missionKey = `${id}@${created_at}` (ids restart after a replay reset)
// a new alert (alert or standby entered from connecting / calm, never back from standby or a mission, which is the rescuer's own doing)
// → Haptics Warning + 2 vibration pulses; a new mission key → Haptics Error + 3 pulses. Patterns are per platform: Android
// [0,400,200,400] / [0,600,150,600,150,600]; iOS buzzes a fixed ~400 ms per entry, so only the gaps: [0,600] / [0,550,550];
// keep the screen awake (expo-keep-awake activate/deactivate with a tag) while phase is alert, standby or mission.
```

## The screen (`src/screen/`) by phase

The layout never changes: **header** (h 44, px 24), **instrument** (flex 1, centered), **card** (bottom). Phase changes
cross-fade the instrument and the card content (Reanimated `FadeIn`/`FadeOut` 220 ms, keyed by phase), and the card animates
its height (`LinearTransition`).

Header: left, `LiveDot` + an ash eyebrow with `parisClock(simTime)` and the mode, e.g. `20:14 · REPLAY ×60` (`OFFLINE` replaces the mode when offline). Right, `DutyToggle` bound to `rescuer.available`, disabled while busy or connecting.
The eyebrow also has these forms:
- before the first view: `RAVEN · CONNECTING` / `RAVEN · OFFLINE`
- clock stopped: `{MODE} PAUSED`
- speed 1: the mode alone, with no `×1`

Gauge size: `min(width − 80, instrument height − 40, 300)`, at least 96. Below 260, the face inside the ring is scaled down so the
fixed 76 pt numeral stays inside the ticks. In the mission phase, the blob gets `size − 28` so its caption fits under it.

| phase | instrument | card eyebrow | title / subtitle | stats | actions |
|---|---|---|---|---|---|
| connecting | TickRing sweep, Display "—", caption "No signal" | CONNECTING | "RAVEN" / "Reaching NOÉ" | none; Note with `NOE_URL` (1 line) | secondary block "Retry" |
| calm | TickRing static, progress = sim minute / 60, Display `parisClock`, caption "Paris · all clear" | ALL CLEAR | rescuer.name / "{org} · {country}" | Tier (value "T3"), Duty ("On"/"Off") | off duty: primary block "Go on duty" · on duty: Note "You'll be alerted if a flood threatens your area." |
| alert | TickRing static, tone ember, progress = confidence, Display `countdown(overflowEta)`, caption "Until overflow" | FLOOD ALERT (ember) | "Flood emergency" / the river (part after " · " in alert.title) | `distance(km*1000)` "From the zone", `percent(confidence)` "Confidence" | primary block "I'm available" |
| standby | TickRing sweep, tone paper, Display `countdown(overflowEta)`, caption "Awaiting dispatch" | ON STANDBY | "Awaiting dispatch" / "NOÉ is matching you" | same as alert | secondary block "Stand down" |
| mission | Approach, bearing rescuer → target, active when en_route; under it, an ash caption `{distance} · {etaMin} min · Tap to navigate` (demo: `2.4 km · 10 min`) | MISSION {number} · {statusLabel} (ember when backup) with the corner text button BACKUP (ember dot + coal semibold 11 / tracking 1; shown en_route and on_site only) | target.name / "{age} · {languageName}" for residents; sites have no subtitle (the view carries no address or kind for them) | water: "0.8 m" "Water now" (dot water) if waterNowM > WET_M (0.05, the server's threshold), otherwise countdown(waterEta) "Water in", or "Dry" "Water" · peak `depth(waterPeakM)` "Peak" · "{etaMin}" min "Your ETA" | TagRow: mobility tags + hazards (ember) · Note routeNote (2 lines) · StepPill(STEPS, stepIndex(status, replaced)) + primary `primaryLabel` |

Overlays (not screens):
- **Toast** (HeroUI `useToast`, placed at the top, at most 2 visible): "Mission {number} complete" once per `completed.key`.
  An action error shows a danger toast whose title names what failed (e.g. "Mission not updated") and whose description is the message.
  The toast body is custom: coal/taupe text with a small sage or ember dot, because HeroUI's soft success/danger label colors are
  too pale on cream. Every toast is also announced to screen readers.
- **Dialog** (HeroUI): "Request backup?" with "NOÉ will send another team to {target.name}." and the actions Cancel / Request (danger).
  While the request is in flight, Request shows the spinner and the dialog can't be dismissed. It closes when the request settles.
  Which dialog is open is tracked by mission id, so it never reopens on the next mission.

Actions run one at a time (`src/screen/useActions.ts`). Only the control that started an action gets `isLoading`; the others get
`isDisabled` until it settles. The header toggle has its own pending key, so flipping it never spins "Go on duty".

Accessibility: every pressable has an `accessibilityLabel`. The gauge exposes its value as text (`accessibilityLabel="1 hour 40 minutes until overflow"`), and stats holding a countdown or duration are spoken in words (`spokenCountdown`). Hit targets are ≥ 44 pt.
