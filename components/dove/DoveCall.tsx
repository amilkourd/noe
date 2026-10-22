"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { Button } from "@heroui/react";
import type { DoveCall as DoveCallRow, NoeEvent, ResidentStatus } from "@/lib/types";
import {
  doveLang, isRtl, ETA_UNKNOWN, INSTRUCTION, SPEECH_LANG, UI, firstMessage,
  type DoveInfo, type DoveLang,
} from "@/lib/dove-copy";
import { DotRing } from "./DotRing";
import { Ringtone } from "./ringtone";
import { MicIcon, PhoneIcon, ShieldIcon, TriangleIcon } from "./icons";

type Phase = "arm" | "armed" | "ringing" | "call" | "after";
type VoiceState = "idle" | "connecting" | "live" | "unavailable";
type Bubble = { id: string; role: "user" | "agent"; text: string };

const STALE_RING_MS = 10 * 60 * 1000; // ignore "ringing" rows older than this on (re)load

export default function DoveCall({ residentId, demo = false }: { residentId: string; demo?: boolean }) {
  return (
    <ConversationProvider>
      <DoveScreen residentId={residentId} demo={demo} />
    </ConversationProvider>
  );
}

function normalizeCall(row: DoveCallRow): DoveCallRow {
  return { ...row, id: Number(row.id), created_at: String(row.created_at) };
}

function callKey(c: { id: number; created_at: string }): string {
  // SSE rows (row_to_json, microseconds + offset) and API rows (ISO Z) differ textually: compare as ms
  const t = Date.parse(c.created_at);
  return `${c.id}|${Number.isFinite(t) ? t : c.created_at}`;
}

function demoInfo(residentId: string): DoveInfo {
  const lang: DoveLang = "en";
  const name = "Mrs Garcia";
  return {
    resident: { id: residentId, name, language: lang, age: 84, persona: true },
    town: "Sommières", instruction: INSTRUCTION[lang], eta: null,
    firstMessage: firstMessage(lang, name, "Sommières", new Date("2026-10-19T21:00:00Z")),
    latestCall: null,
  };
}

function speak(text: string, lang: DoveLang) {
  try {
    const s = window.speechSynthesis;
    if (!s) return;
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = SPEECH_LANG[lang];
    u.rate = 0.95;
    s.speak(u);
  } catch { /* no speech synthesis */ }
}

async function patchCall(id: number, state: DoveCallRow["state"]) {
  if (!(id > 0)) return; // simulated call (demo mode)
  try {
    await fetch(`/api/dove-calls/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }),
    });
  } catch { /* best effort */ }
}

function DoveScreen({ residentId, demo }: { residentId: string; demo: boolean }) {
  const [info, setInfo] = useState<DoveInfo | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [call, setCall] = useState<DoveCallRow | null>(null);          // latest row seen for this resident
  const [activeCall, setActiveCall] = useState<DoveCallRow | null>(null); // the call ringing / in progress
  const [phase, setPhase] = useState<Phase>("arm");
  const [armed, setArmed] = useState(false);
  const [micOk, setMicOk] = useState<boolean | null>(null);
  const [voice, setVoice] = useState<VoiceState>("idle");
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [reported, setReported] = useState<ResidentStatus | null>(null);
  const [sendState, setSendState] = useState<"idle" | "sending" | "error">("idle");
  const [afterKind, setAfterKind] = useState<"ended" | "declined">("ended");
  const [callStart, setCallStart] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // keyed by id|created_at: reset truncates dove_calls with RESTART IDENTITY, so ids repeat across rehearsals
  const handled = useRef<Set<string>>(new Set());
  const [mode, setMode] = useState<string | null>(null);
  const [hadCall, setHadCall] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const ringRef = useRef<Ringtone | null>(null);
  const wakeRef = useRef<WakeLockSentinel | null>(null);
  const armedRef = useRef(false);
  const voiceRef = useRef<VoiceState>("idle");
  const endingRef = useRef(false);
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const infoRef = useRef<DoveInfo | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const lastVoiceStatus = useRef<ResidentStatus | null>(null); // level already sent by the agent during this call

  // English until /api/dove answers (DOVE is English-only for now), so a slow load never flashes another language
  const lang: DoveLang = info ? doveLang(info.resident.language) : "en";
  const ui = UI[lang];
  const en = UI.en;

  const setVoiceState = (v: VoiceState) => { voiceRef.current = v; setVoice(v); };

  // ---------- status reporting (voice tool + fallback buttons) ----------
  const postStatus = useCallback(async (
    status: ResidentStatus, canClimb: boolean | null, notes: string | null, channel: "voice" | "button",
  ): Promise<boolean> => {
    setSendState("sending");
    let ok = false;
    try {
      const r = await fetch("/api/status", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ residentId, status, can_climb_stairs: canClimb, notes, channel }),
      });
      ok = r.ok;
    } catch { ok = false; }
    if (ok || demo) { setReported(status); setSendState("idle"); } else setSendState("error");
    return ok || demo;
  }, [residentId, demo]);

  // ---------- ElevenLabs conversation ----------
  const conv = useConversation({
    clientTools: {
      report_status: async (p: { urgency?: string; status?: string }) => {
        // Only the 3-level status leaves the call (urgency ok | unstable | urgent; status is the older param):
        // nothing else from the conversation is stored, and a repeat of the same level is not re-sent.
        const u = p?.urgency ?? p?.status;
        const status: ResidentStatus = u === "ok" || u === "safe" ? "safe" : u === "unstable" ? "unstable" : "needs_help";
        if (status === lastVoiceStatus.current) return "recorded";
        const prev = lastVoiceStatus.current;
        lastVoiceStatus.current = status; // claim before awaiting, so a quick repeat cannot slip through
        const ok = await postStatus(status, null, null, "voice");
        if (!ok && lastVoiceStatus.current === status) lastVoiceStatus.current = prev; // allow a retry
        return ok ? "recorded" : "not recorded: ask the person to press the button on their screen";
      },
    },
    onMessage: (m) => {
      if (!m?.message) return;
      setBubbles((b) => [...b, { id: `${m.role}-${m.event_id}-${b.length}`, role: m.role === "user" ? "user" : "agent", text: m.message }]);
    },
    onConnect: () => {
      if (connectTimer.current) clearTimeout(connectTimer.current);
      setVoiceState("live");
    },
    onError: () => {
      if (voiceRef.current === "connecting" || voiceRef.current === "live") voiceFail();
    },
    onDisconnect: () => {
      // The agent hung up (or the line dropped) while the call was live.
      if (endingRef.current) return;
      if (voiceRef.current === "live") {
        setVoiceState("idle");
        finishCall("ended");
      }
    },
  });

  function voiceFail() {
    if (connectTimer.current) clearTimeout(connectTimer.current);
    if (voiceRef.current === "unavailable") return;
    setVoiceState("unavailable");
    endingRef.current = true;
    try { conv.endSession(); } catch { /* not started */ }
    const i = infoRef.current;
    if (i) speak(i.firstMessage, doveLang(i.resident.language));
  }

  // ---------- data: initial fetch + poll + SSE ----------
  const onCallRow = useCallback((row: DoveCallRow) => {
    if (row.resident_id !== residentId) return;
    setCall(normalizeCall(row));
  }, [residentId]);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/dove/${encodeURIComponent(residentId)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status === 404 ? "Unknown resident" : `Noé unreachable (${r.status})`);
      const d = (await r.json()) as DoveInfo;
      infoRef.current = d;
      setInfo(d);
      setLoadErr(null);
      if (d.latestCall) onCallRow(d.latestCall);
      else handled.current.clear(); // table was reset (possibly while this tab was asleep)
    } catch (e) {
      setLoadErr((e as Error).message || "Noé unreachable");
      if (demo && !infoRef.current) { const d = demoInfo(residentId); infoRef.current = d; setInfo(d); }
    }
  }, [residentId, demo, onCallRow]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  // poll as a safety net for the SSE stream (tunnels sometimes buffer SSE)
  useEffect(() => {
    if (phase === "call") return;
    const t = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(t);
  }, [phase, load]);

  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/stream?tables=dove_calls,reset,clock"); // no health data on resident phones
      es.onopen = () => { void load(); }; // fires again after each reconnect
      es.onmessage = (ev) => {
        let e: NoeEvent;
        try { e = JSON.parse(ev.data) as NoeEvent; } catch { return; }
        if (e.table === "dove_calls") onCallRow(e.row);
        else if (e.table === "reset") { handled.current.clear(); void load(); }
        else if (e.table === "clock") setMode((e.row as { mode?: string }).mode ?? null);
      };
    } catch { /* no SSE: polling covers it */ }
    return () => es?.close();
  }, [load, onCallRow]);

  // ---------- ring decision ----------
  useEffect(() => {
    if (!call) return;
    const fresh = Date.now() - new Date(call.created_at).getTime() < STALE_RING_MS || call.id < 0;
    if (call.state === "ringing" && fresh && !handled.current.has(callKey(call)) && phase !== "ringing" && phase !== "call") {
      setActiveCall(call);
      setPhase("ringing");
    } else if (phase === "ringing" && activeCall && call.id === activeCall.id && call.state !== "ringing") {
      // missed / handled elsewhere
      handled.current.add(callKey(call));
      setPhase(armedRef.current ? "armed" : "arm");
    }
  }, [call, phase, activeCall]);

  // ringtone follows the phase
  useEffect(() => {
    if (phase === "ringing" && armed) ringRef.current?.start();
    else ringRef.current?.stop();
    if (phase === "ringing") {
      const old = document.title;
      document.title = "Flood alert · Noé";
      return () => { document.title = old; };
    }
  }, [phase, armed]);

  // call timer
  useEffect(() => {
    if (phase !== "call") return;
    const t = setInterval(() => setElapsed(callStart ? Math.max(0, Math.floor((Date.now() - callStart) / 1000)) : 0), 1000);
    return () => clearInterval(t);
  }, [phase, callStart]);

  // keep transcript scrolled to the latest bubble
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [bubbles]);

  // ---------- arming: audio unlock, mic permission, wake lock ----------
  const requestWake = useCallback(async () => {
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible") {
        wakeRef.current = await navigator.wakeLock.request("screen");
      }
    } catch { /* not supported / denied */ }
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible" || !armedRef.current) return;
      void requestWake();
      void audioRef.current?.resume().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [requestWake]);

  const arm = async () => {
    // AudioContext must be created/resumed synchronously inside the tap (iOS)
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = audioRef.current ?? new AC();
      audioRef.current = ctx;
      void ctx.resume().catch(() => {});
      ringRef.current ??= new Ringtone(ctx);
      ringRef.current.prime();
    } catch { /* no WebAudio */ }
    armedRef.current = true;
    setArmed(true);
    setPhase((p) => (p === "arm" ? "armed" : p));
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setMicOk(true);
    } catch { setMicOk(false); }
    await requestWake();
  };

  // ---------- call actions ----------
  const accept = () => {
    ringRef.current?.stop();
    const c = activeCall;
    if (c) { handled.current.add(callKey(c)); void patchCall(c.id, "accepted"); }
    setHadCall(true);
    setBubbles([]);
    setReported(null);
    lastVoiceStatus.current = null;
    setSendState("idle");
    setCallStart(Date.now());
    setElapsed(0);
    setPhase("call");
    endingRef.current = false;

    const i = infoRef.current;
    const agentId = i?.agentId || process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;
    if (!agentId || !i) { voiceFail(); return; }
    const l = doveLang(i.resident.language);
    setVoiceState("connecting");
    if (connectTimer.current) clearTimeout(connectTimer.current);
    connectTimer.current = setTimeout(() => { if (voiceRef.current === "connecting") voiceFail(); }, 15000);
    try {
      conv.startSession({
        agentId,
        connectionType: "webrtc",
        dynamicVariables: { name: i.resident.name, town: i.town, instruction: i.instruction, eta: i.eta ?? ETA_UNKNOWN[l] },
        // English is the agent's default language: only other languages need the Language override enabled
        overrides: { agent: l === "en" ? { firstMessage: i.firstMessage } : { language: l, firstMessage: i.firstMessage } },
      });
    } catch { voiceFail(); }
  };

  const decline = () => {
    ringRef.current?.stop();
    const c = activeCall;
    if (c) { handled.current.add(callKey(c)); void patchCall(c.id, "declined"); }
    setHadCall(true);
    setReported(null);
    setAfterKind("declined");
    setPhase("after");
  };

  function finishCall(kind: "ended" | "declined") {
    if (connectTimer.current) clearTimeout(connectTimer.current);
    const c = activeCall;
    if (c) void patchCall(c.id, "ended");
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    setAfterKind(kind);
    setPhase("after");
  }

  const endCall = () => {
    endingRef.current = true;
    try { conv.endSession(); } catch { /* not started */ }
    setVoiceState("idle");
    finishCall("ended");
  };

  const pressStatus = async (status: ResidentStatus) => {
    const prev = lastVoiceStatus.current;
    lastVoiceStatus.current = status; // the agent repeating this level must not add a second row
    const ok = await postStatus(status, null, null, "button");
    if (!ok && lastVoiceStatus.current === status) lastVoiceStatus.current = prev;
    if (ok && voiceRef.current === "live") {
      try {
        conv.sendContextualUpdate(
          status === "safe"
            ? "The person pressed the on-screen button: I'm safe. Status already recorded."
            : "The person pressed the on-screen button: I need help. Status already recorded, the rescue team is notified.",
        );
      } catch { /* ignore */ }
    }
  };

  const simulateRing = () => {
    const fake: DoveCallRow = { id: -Date.now(), resident_id: residentId, created_at: new Date().toISOString(), state: "ringing" };
    setCall(fake);
  };

  // ---------- render ----------
  const persona = info?.resident.persona ?? true;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-noe-bg px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-[max(16px,env(safe-area-inset-top))] text-[18px] leading-snug text-noe-text">
      <TopBar name={info?.resident.name ?? residentId} persona={persona} lang={lang} />

      {phase === "arm" && (
        <section className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
          <DotRing mode="idle" size={240} />
          <div className="flex w-full flex-col items-center gap-3">
            <Button onPress={arm} fullWidth className="h-16 rounded-full bg-white text-[20px] font-medium text-[#0E0F11]">
              <Txt lang={lang}>{ui.armTitle}</Txt>
            </Button>
            {lang !== "en" && <p className="text-[14px] text-noe-muted">{en.armTitle}</p>}
            <Bi lang={lang} text={ui.armHint} en={en.armHint} className="text-[16px] text-noe-muted" />
          </div>
          {loadErr && <p className="text-[14px] text-noe-muted">{loadErr} · retrying</p>}
        </section>
      )}

      {phase === "armed" && (
        <section className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
          <DotRing mode="idle" size={260} />
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-noe-land opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-noe-land" />
              </span>
              <Txt lang={lang} className="text-[22px]">{ui.armed}</Txt>
            </div>
            {lang !== "en" && <p className="text-[14px] text-noe-muted">{en.armed}</p>}
            <Bi lang={lang} text={ui.armedHint} en={en.armedHint} className="mt-2 text-[16px] text-noe-muted" />
            {micOk === false && (
              <p className="mt-2 flex items-center gap-1.5 text-[14px] text-noe-warn"><MicIcon /> Microphone blocked · the buttons will still work</p>
            )}
            {loadErr && <p className="mt-1 text-[14px] text-noe-muted">{loadErr} · retrying</p>}
          </div>
          {hadCall && (
            <div className="w-full">
              <StatusButtons lang={lang} onPress={pressStatus} sendState={sendState} reported={reported} />
            </div>
          )}
          {demo && (
            <Button variant="ghost" onPress={simulateRing} className="rounded-full text-[14px] text-noe-muted">
              Simulate alert (demo)
            </Button>
          )}
        </section>
      )}

      {phase === "ringing" && (
        <section className="flex flex-1 flex-col items-center justify-between gap-6 pt-4 text-center">
          <div className="flex flex-col items-center gap-1">
            <Bi lang={lang} text={ui.from} en={en.from} className="text-[18px] text-noe-muted" />
            <h1 className="mt-2 text-[30px] font-medium leading-tight">
              <Txt lang={lang}>{ui.floodAlert}</Txt>
            </h1>
            {lang !== "en" && <p className="text-[14px] text-noe-muted">{en.floodAlert}</p>}
          </div>
          <DotRing mode="ringing" size={300} />
          <div className="grid w-full grid-cols-2 gap-3">
            <Button onPress={decline} className="h-16 w-full rounded-full border border-noe-line bg-noe-surface-2 text-[20px] text-noe-text">
              <PhoneIcon down color="var(--noe-danger)" />
              <Txt lang={lang}>{ui.decline}</Txt>
            </Button>
            <Button onPress={accept} className="h-16 w-full rounded-full bg-white text-[20px] font-medium text-[#0E0F11]">
              <PhoneIcon color="#0E0F11" />
              <Txt lang={lang}>{ui.accept}</Txt>
            </Button>
          </div>
          {!armed && <p className="-mt-3 text-[14px] text-noe-muted">Device not armed · no ringtone</p>}
        </section>
      )}

      {phase === "call" && (
        <section className="flex min-h-0 flex-1 flex-col gap-4 pt-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-noe-line bg-noe-surface-2 px-3 py-1 text-[14px] font-medium tracking-wide">
                {lang.toUpperCase()}
              </span>
              <VoiceIndicator voice={voice} speaking={conv.isSpeaking} ui={ui} lang={lang} />
            </div>
            <span className="tabular text-[16px] text-noe-muted">
              {String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(elapsed % 60).padStart(2, "0")}
            </span>
          </div>

          {voice === "unavailable" && (
            <p className="rounded-2xl border border-noe-line bg-noe-surface px-4 py-2 text-[14px] text-noe-warn">
              <Txt lang={lang}>{ui.voiceUnavailable}</Txt>
              {lang !== "en" && <span className="block text-noe-muted">{en.voiceUnavailable}</span>}
            </p>
          )}

          <div className="flex items-center gap-4">
            <DotRing mode={voice === "live" ? "call" : "idle"} level={conv.isSpeaking ? 0.6 : 0.12} size={96} />
            <div className="min-w-0 flex-1 rounded-2xl border border-noe-line bg-noe-surface px-4 py-3">
              <p className="text-[12px] uppercase tracking-wider text-noe-muted">
                <Txt lang={lang}>{ui.instruction}</Txt>{lang !== "en" ? ` · ${en.instruction}` : ""}
              </p>
              <Txt lang={lang} className="mt-1 block text-[18px] leading-snug">{info?.instruction ?? INSTRUCTION[lang]}</Txt>
            </div>
          </div>

          <div ref={transcriptRef} className="flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {bubbles.length === 0 && voice !== "unavailable" && (
              <p className="m-auto text-[14px] text-noe-muted">{voice === "connecting" ? ui.connecting : "…"}</p>
            )}
            {bubbles.map((b) => (
              <div
                key={b.id}
                dir="auto"
                className={
                  b.role === "agent"
                    ? "max-w-[85%] self-start rounded-3xl rounded-bl-md border border-noe-line bg-noe-surface-2 px-4 py-2.5 text-[18px]"
                    : "max-w-[85%] self-end rounded-3xl rounded-br-md bg-white px-4 py-2.5 text-[18px] text-[#0E0F11]"
                }
              >
                {b.text}
              </div>
            ))}
          </div>

          {reported && <ReachedCard lang={lang} status={reported} compact />}
          <StatusButtons lang={lang} onPress={pressStatus} sendState={sendState} reported={reported} />
          <Button onPress={endCall} className="h-14 w-full rounded-full bg-noe-danger text-[18px] font-medium text-[#0E0F11]">
            <PhoneIcon down color="#0E0F11" />
            <Txt lang={lang}>{ui.endCall}</Txt>
          </Button>
        </section>
      )}

      {phase === "after" && (
        <section className="flex flex-1 flex-col justify-center gap-5">
          {reported ? (
            <>
              <ReachedCard lang={lang} status={reported} />
              <StatusButtons lang={lang} onPress={pressStatus} sendState={sendState} reported={reported} />
            </>
          ) : (
            <>
              <div className="rounded-3xl border border-noe-line bg-noe-surface p-6 text-center">
                <Bi lang={lang} text={afterKind === "declined" ? ui.declined : ui.callEnded} en={afterKind === "declined" ? en.declined : en.callEnded} className="text-[24px]" />
              </div>
              <StatusButtons lang={lang} onPress={pressStatus} sendState={sendState} reported={reported} />
            </>
          )}
          <Button
            variant="ghost"
            onPress={() => { setPhase(armedRef.current ? "armed" : "arm"); setReported(null); setSendState("idle"); }}
            className="mx-auto rounded-full text-[14px] text-noe-muted"
          >
            Back to standby
          </Button>
        </section>
      )}

      <footer className="flex flex-wrap items-center justify-center gap-2 pt-3 text-center text-[12px] text-noe-muted">
        <span className="rounded-full border border-noe-line bg-noe-surface-2 px-2.5 py-0.5">
          {mode === "SCENARIO" ? "SCENARIO" : mode === "LIVE" ? "LIVE" : "REPLAY · real data 19–20 Oct 2026"}
        </span>
        <span>Noé · Town of Sommières flood line · demo</span>
      </footer>
    </main>
  );
}

// ---------- small subcomponents ----------

function Txt({ lang, children, className }: { lang: DoveLang; children: ReactNode; className?: string }) {
  return <span lang={lang} dir={isRtl(lang) ? "rtl" : undefined} className={className}>{children}</span>;
}

/** Resident-language line, with the English version below (small) when different. */
function Bi({ lang, text, en, className }: { lang: DoveLang; text: string; en: string; className?: string }) {
  return (
    <div className={className}>
      <Txt lang={lang}>{text}</Txt>
      {lang !== "en" && <span className="mt-0.5 block text-[13px] text-noe-muted">{en}</span>}
    </div>
  );
}

function TopBar({ name, persona, lang }: { name: string; persona: boolean; lang: DoveLang }) {
  return (
    <header className="flex items-center justify-between gap-3 pb-2">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-noe-land" />
        <span className="text-[18px] font-medium tracking-wide">Noé</span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[14px] text-noe-muted" dir="auto">{name}</span>
        {persona && (
          <span className="shrink-0 rounded-full border border-noe-line bg-noe-surface-2 px-2.5 py-0.5 text-[11px] text-noe-muted">
            demo persona
          </span>
        )}
        <span className="sr-only">{lang}</span>
      </div>
    </header>
  );
}

function VoiceIndicator({ voice, speaking, ui, lang }: { voice: VoiceState; speaking: boolean; ui: (typeof UI)["en"]; lang: DoveLang }) {
  if (voice === "unavailable") return null;
  const label = voice === "connecting" ? ui.connecting : speaking ? ui.speaking : ui.listening;
  return (
    <span className="flex items-center gap-2 text-[15px] text-noe-muted">
      <span className="flex h-4 items-end gap-[3px]" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="w-[3px] rounded-full bg-noe-land"
            style={{
              height: voice === "live" && speaking ? undefined : 5,
              animation: voice === "live" && speaking ? `dove-eq 0.9s ${i * 0.12}s ease-in-out infinite` : undefined,
              opacity: voice === "connecting" ? 0.4 : 1,
            }}
          />
        ))}
      </span>
      {voice !== "live" || !speaking ? <MicIcon size={14} color="var(--noe-land-4)" /> : null}
      <Txt lang={lang}>{label}</Txt>
      <style>{`@keyframes dove-eq { 0%,100% { height: 4px } 50% { height: 16px } }`}</style>
    </span>
  );
}

function StatusButtons({ lang, onPress, sendState, reported }: {
  lang: DoveLang; onPress: (s: ResidentStatus) => void; sendState: "idle" | "sending" | "error"; reported: ResidentStatus | null;
}) {
  const ui = UI[lang]; const en = UI.en;
  const busy = sendState === "sending";
  const row = (s: ResidentStatus, icon: ReactNode, text: string, enText: string) => (
    <Button
      onPress={() => onPress(s)}
      isDisabled={busy}
      className={`h-16 w-full justify-start gap-3 rounded-full border bg-noe-surface-2 px-5 text-left text-noe-text ${reported === s ? "border-white/40" : "border-noe-line"}`}
    >
      {icon}
      <span className="flex min-w-0 flex-col leading-tight">
        <Txt lang={lang} className="text-[20px] font-medium">{text}</Txt>
        {lang !== "en" && <span className="text-[12px] text-noe-muted">{enText}</span>}
      </span>
    </Button>
  );
  return (
    <div className="flex flex-col gap-3">
      {row("safe", <ShieldIcon size={26} color="var(--noe-safe)" />, ui.imSafe, en.imSafe)}
      {row("needs_help", <TriangleIcon size={26} color="var(--noe-warn)" />, ui.needHelp, en.needHelp)}
      {busy && <p className="text-center text-[14px] text-noe-muted">{ui.sending}</p>}
      {sendState === "error" && <p className="text-center text-[14px] text-noe-warn">Not sent · check the connection and tap again</p>}
    </div>
  );
}

function ReachedCard({ lang, status, compact = false }: { lang: DoveLang; status: ResidentStatus; compact?: boolean }) {
  const ui = UI[lang]; const en = UI.en;
  const icon = status === "safe"
    ? <ShieldIcon size={compact ? 22 : 36} color="var(--noe-safe)" />
    : <TriangleIcon size={compact ? 22 : 36} color="var(--noe-warn)" />;
  const statusLabel = status === "safe" ? ui.imSafe : status === "unstable" ? ui.watching : ui.needHelp;
  return (
    <div className={`flex items-center gap-4 rounded-3xl border border-noe-line bg-noe-surface ${compact ? "px-4 py-3" : "flex-col p-7 text-center"}`}>
      {icon}
      <div className="min-w-0">
        <Txt lang={lang} className={compact ? "text-[18px]" : "text-[26px] leading-tight"}>{ui.reached}</Txt>
        {lang !== "en" && <span className={`block text-noe-muted ${compact ? "text-[12px]" : "mt-1 text-[16px]"}`}>{en.reached}</span>}
        {!compact && <span className="mt-3 block text-[14px] text-noe-muted"><Txt lang={lang}>{statusLabel}</Txt></span>}
      </div>
    </div>
  );
}
