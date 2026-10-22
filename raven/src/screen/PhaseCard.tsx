import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ActionButton, CreamCard, Note, Stat, StatRow, StepPill, Subtitle, Tag, TagRow, Title } from "../ds";
import { NOE_URL } from "../data/config";
import { countdown, depth, distance, languageName, mobilityTag, percent, spokenCountdown } from "../data/format";
import { STEPS, WET_M, canRequestBackup, primaryLabel, stepIndex, statusLabel } from "../data/mission";
import type { MissionStatus, RavenView } from "../data/types";
import type { Raven } from "../data/useRaven";
import type { ActionKey, Run } from "./useActions";

interface Props {
  raven: Raven;
  pending: ActionKey | null;
  locked: boolean; // an action is in flight
  run: Run;
  onBackup: () => void;
}

type Alert = NonNullable<RavenView["alert"]>;
type MissionView = NonNullable<RavenView["mission"]>;
type Figure = { value: string; unit?: string; label: string; dot?: "water" | "ember" | "sage"; spoken?: string };

function Body({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <View className="items-center self-stretch">
      <Title className="text-center">{title}</Title>
      {subtitle ? <Subtitle className="mt-0.5 text-center">{subtitle}</Subtitle> : null}
      {children}
    </View>
  );
}

function Stats({ items }: { items: Figure[] }) {
  return (
    <View className="mt-5 self-stretch">
      <StatRow>
        {items.map((s) => (
          <Stat key={s.label} value={s.value} unit={s.unit || undefined} label={s.label} dot={s.dot} accessibilityLabel={s.spoken} />
        ))}
      </StatRow>
    </View>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <View className="mt-6 self-stretch">{children}</View>;
}

function alertFigures(a: Alert): Figure[] {
  return [
    { ...distance(a.distanceKm * 1000), label: "From the zone" },
    { ...percent(a.confidence), label: "Confidence" },
  ];
}

function waterFigure(m: MissionView, now: string): Figure {
  // The server's wet threshold: below it the target is dry, waterEta is set and "Moving water" is not a hazard yet.
  if (m.waterNowM != null && m.waterNowM > WET_M) return { ...depth(m.waterNowM), label: "Water now", dot: "water" };
  if (!m.waterEta) return { value: "Dry", label: "Water" };
  const c = countdown(m.waterEta, now);
  return { ...c, label: "Water in", spoken: `Water in: ${spokenCountdown(c) || "unknown"}` };
}

function missionFigures(m: MissionView, now: string): Figure[] {
  const eta = { value: String(m.etaMin), unit: "min" };
  return [
    waterFigure(m, now),
    { ...depth(m.waterPeakM), label: "Peak" },
    { ...eta, label: "Your ETA", spoken: `Your ETA: ${spokenCountdown(eta)}` },
  ];
}

function BackupButton({ onPress, isDisabled }: { onPress: () => void; isDisabled: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Request backup"
      accessibilityState={{ disabled: isDisabled }}
      className="h-11 min-w-11 flex-row items-center justify-center gap-1.5 px-2"
      style={({ pressed }) => ({ opacity: isDisabled ? 0.4 : pressed ? 0.55 : 1 })}
    >
      {/* ember text on cream is 2.3:1, so the danger tone rides on the dot and the label stays coal */}
      <View className="size-1.5 rounded-full bg-ember" />
      <Text maxFontSizeMultiplier={1.3} className="font-semibold text-[11px] tracking-[1px] text-coal">BACKUP</Text>
    </Pressable>
  );
}

function Mission({ m, now, raven, pending, locked, run, onBackup }: Props & { m: MissionView; now: string }) {
  const { id, status } = m.mission;
  // "backup" replaces the progress status on the server: remember the status it replaced, so the pill neither ticks
  // steps that never happened nor drops one that did (state adjusted during render, React's documented pattern).
  const [held, setHeld] = useState<{ id: number; status: MissionStatus } | null>(null);
  if (status !== "backup" && (!held || held.id !== id || held.status !== status)) setHeld({ id, status });
  const replaced = status === "backup" && held?.id === id ? held.status : null;
  const t = m.target;
  const subtitle = t.type === "resident"
    ? [t.age != null ? String(t.age) : null, t.language ? languageName(t.language) : null].filter(Boolean).join(" · ")
    : t.address ?? "";
  const needs = mobilityTag(t.mobility, t.canClimbStairs);
  const label = primaryLabel(status);
  return (
    <CreamCard
      eyebrow={`MISSION ${m.number} · ${statusLabel(status)}`}
      eyebrowTone={status === "backup" ? "ember" : "taupe"}
      corner={canRequestBackup(status) ? <BackupButton onPress={onBackup} isDisabled={locked} /> : undefined}
    >
      <Body title={t.name} subtitle={subtitle || undefined}>
        <Stats items={missionFigures(m, now)} />
        {needs.length > 0 || m.hazards.length > 0 ? (
          <View className="mt-4 self-stretch">
            <TagRow>
              {needs.map((n) => <Tag key={`n-${n}`} label={n} />)}
              {m.hazards.map((h) => <Tag key={`h-${h}`} label={h} tone="ember" />)}
            </TagRow>
          </View>
        ) : null}
        {m.routeNote ? <Note className="mt-3 text-center" numberOfLines={2}>{m.routeNote}</Note> : null}
        <View className={`mt-6 flex-row items-center gap-3 self-stretch ${label ? "" : "justify-center"}`}>
          <StepPill steps={STEPS} current={stepIndex(status, replaced)} />
          {label ? (
            <View className="flex-1">
              <ActionButton
                label={label}
                block
                onPress={() => run("advance", () => raven.advance(), "Mission not updated")}
                isLoading={pending === "advance"}
                isDisabled={locked && pending !== "advance"}
              />
            </View>
          ) : null}
        </View>
      </Body>
    </CreamCard>
  );
}

export function PhaseCard({ raven, pending, locked, run, onBackup }: Props) {
  const { phase, view } = raven;

  if (!view) {
    return (
      <CreamCard eyebrow="CONNECTING">
        <Body title="RAVEN" subtitle="Reaching NOÉ">
          <Note className="mt-3 text-center" numberOfLines={1}>{NOE_URL || "NOÉ via this server"}</Note>
          <Actions><ActionButton label="Retry" variant="secondary" block onPress={() => raven.retry()} /></Actions>
        </Body>
      </CreamCard>
    );
  }

  const now = view.clock.simTime;
  if (phase === "mission" && view.mission) {
    return <Mission m={view.mission} now={now} raven={raven} pending={pending} locked={locked} run={run} onBackup={onBackup} />;
  }

  const a = view.alert;
  if (phase === "alert" && a) {
    return (
      <CreamCard eyebrow="FLOOD ALERT" eyebrowTone="ember">
        <Body title="Flood emergency" subtitle={a.title.split(" · ")[1] ?? a.title}>
          <Stats items={alertFigures(a)} />
          <Actions>
            <ActionButton
              label="I'm available"
              block
              onPress={() => run("available", () => raven.setAvailable(true), "Couldn't mark you available")}
              isLoading={pending === "available"}
              isDisabled={locked && pending !== "available"}
            />
          </Actions>
        </Body>
      </CreamCard>
    );
  }

  if (phase === "standby" && a) {
    return (
      <CreamCard eyebrow="ON STANDBY">
        <Body title="Awaiting dispatch" subtitle="NOÉ is matching you">
          <Stats items={alertFigures(a)} />
          <Actions>
            <ActionButton
              label="Stand down"
              variant="secondary"
              block
              onPress={() => run("standDown", () => raven.setAvailable(false), "Couldn't stand down")}
              isLoading={pending === "standDown"}
              isDisabled={locked && pending !== "standDown"}
            />
          </Actions>
        </Body>
      </CreamCard>
    );
  }

  const r = view.rescuer;
  return (
    <CreamCard eyebrow="ALL CLEAR">
      <Body title={r.name} subtitle={[r.org, r.country].filter(Boolean).join(" · ") || undefined}>
        <Stats items={[{ value: r.tier, label: "Tier" }, { value: r.available ? "On" : "Off", label: "Duty" }]} />
        {r.available ? (
          <Note className="mt-5 text-center">You'll be alerted if a flood threatens your area.</Note>
        ) : (
          <Actions>
            <ActionButton
              label="Go on duty"
              block
              onPress={() => run("duty", () => raven.setAvailable(true), "Couldn't go on duty")}
              isLoading={pending === "duty"}
              isDisabled={locked && pending !== "duty"}
            />
          </Actions>
        )}
      </Body>
    </CreamCard>
  );
}
