// DOVE copy deck: per-language strings for the resident call screen and the voice agent.
// Pure module (no server-only deps): imported by both the API route and the client screen.

export type DoveLang = "fr" | "es" | "ar" | "pt" | "en";
export const DOVE_LANGS: DoveLang[] = ["fr", "es", "ar", "pt", "en"];

export function doveLang(language: string | null | undefined): DoveLang {
  const l = (language ?? "fr").toLowerCase().slice(0, 2);
  return (DOVE_LANGS as string[]).includes(l) ? (l as DoveLang) : "en";
}

export const isRtl = (lang: DoveLang) => lang === "ar";

/** BCP-47 tag for window.speechSynthesis fallback. */
export const SPEECH_LANG: Record<DoveLang, string> = {
  fr: "fr-FR", es: "es-ES", ar: "ar-SA", pt: "pt-PT", en: "en-GB",
};

/** Official instruction (the only safety advice the agent may give). */
export const INSTRUCTION: Record<DoveLang, string> = {
  en: "Go upstairs now and do not go down to the garage or basement.",
  fr: "Montez à l'étage maintenant et ne descendez pas au garage ni à la cave.",
  es: "Suba al piso de arriba ahora y no baje al garaje ni al sótano.",
  pt: "Suba já para o andar de cima e não desça à garagem nem à cave.",
  ar: "اصعد إلى الطابق العلوي الآن ولا تنزل إلى المرآب أو القبو.",
};

type DayPart = "morning" | "afternoon" | "night";
const GREET: Record<DoveLang, Record<DayPart, string>> = {
  en: { morning: "Good morning", afternoon: "Good afternoon", night: "Good evening" },
  fr: { morning: "Bonjour", afternoon: "Bonjour", night: "Bonsoir" },
  es: { morning: "Buenos días", afternoon: "Buenas tardes", night: "Buenas noches" },
  pt: { morning: "Bom dia", afternoon: "Boa tarde", night: "Boa noite" },
  ar: { morning: "صباح الخير", afternoon: "مساء الخير", night: "مساء الخير" },
};

/** Hour in Europe/Paris for a given instant. */
export function parisHour(d: Date): number {
  const h = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Paris" }).format(d);
  return Number(h);
}

function dayPart(d: Date): DayPart {
  const h = parisHour(d);
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 19) return "afternoon";
  return "night";
}

/** Opening line of the call, spoken by the agent (overrides agent.firstMessage). */
export function firstMessage(lang: DoveLang, name: string, town: string, at: Date): string {
  const g = GREET[lang][dayPart(at)];
  const i = INSTRUCTION[lang];
  switch (lang) {
    case "es":
      return `${g}, ${name}. Le llama Noé, del Ayuntamiento de ${town}. El río está subiendo. ${i} ¿Está usted a salvo ahora?`;
    case "fr":
      return `${g}, ${name}. Ici Noé, de la mairie de ${town}. La rivière monte. ${i} Êtes-vous en sécurité en ce moment ?`;
    case "pt":
      return `${g}, ${name}. Fala a Noé, da Câmara de ${town}. O rio está a subir. ${i} Está em segurança neste momento?`;
    case "ar":
      return `${g} ${name}. معك نوي من بلدية ${town}. منسوب النهر يرتفع. ${i} هل أنت في أمان الآن؟`;
    default:
      return `${g}, ${name}. This is Noé, calling for the town of ${town}. The river is rising. ${i} Are you safe right now?`;
  }
}

/** Human ETA in the resident's language ("about 1 hour 20 minutes"). Never a promise, a model estimate. */
export function humanEta(lang: DoveLang, minutes: number): string {
  if (minutes < 10) return ETA_SOON[lang];
  const rounded = Math.max(10, Math.round(minutes / 10) * 10);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  switch (lang) {
    case "fr": {
      if (h === 0) return `environ ${m} minutes`;
      const hs = `${h} heure${h > 1 ? "s" : ""}`;
      return m ? `environ ${hs} ${m}` : `environ ${hs}`;
    }
    case "es": {
      if (h === 0) return `unos ${m} minutos`;
      const hs = `${h} hora${h > 1 ? "s" : ""}`;
      return m ? `aproximadamente ${hs} y ${m} minutos` : `aproximadamente ${hs}`;
    }
    case "pt": {
      if (h === 0) return `cerca de ${m} minutos`;
      const hs = `${h} hora${h > 1 ? "s" : ""}`;
      return m ? `cerca de ${hs} e ${m} minutos` : `cerca de ${hs}`;
    }
    case "ar": {
      if (h === 0) return `حوالي ${m} دقيقة`;
      const hs = h === 1 ? "ساعة" : h === 2 ? "ساعتين" : `${h} ساعات`;
      return m ? `حوالي ${hs} و${m} دقيقة` : `حوالي ${hs}`;
    }
    default: {
      if (h === 0) return `about ${m} minutes`;
      const hs = `${h} hour${h > 1 ? "s" : ""}`;
      return m ? `about ${hs} ${m} minutes` : `about ${hs}`;
    }
  }
}

export const ETA_SOON: Record<DoveLang, string> = {
  en: "a few minutes", fr: "quelques minutes", es: "pocos minutos", pt: "poucos minutos", ar: "دقائق قليلة",
};

/** Used for the {{eta}} dynamic variable when the model has no ETA for this home. */
export const ETA_UNKNOWN: Record<DoveLang, string> = {
  en: "the coming hours", fr: "les prochaines heures", es: "las próximas horas", pt: "as próximas horas", ar: "الساعات القادمة",
};

export interface DoveUi {
  armTitle: string; armHint: string; armed: string; armedHint: string;
  from: string; floodAlert: string; accept: string; decline: string;
  connecting: string; speaking: string; listening: string;
  voiceUnavailable: string; imSafe: string; needHelp: string; endCall: string;
  reached: string; callEnded: string; declined: string; instruction: string;
  sending: string;
}

export const UI: Record<DoveLang, DoveUi> = {
  en: {
    armTitle: "Tap to arm this device", armHint: "Allows sound, microphone and keeps the screen on.",
    armed: "Armed · waiting for alerts", armedHint: "Keep this page open.",
    from: "Town of Sommières · Noé", floodAlert: "Flood alert", accept: "Accept", decline: "Decline",
    connecting: "Connecting…", speaking: "Noé is speaking", listening: "Listening",
    voiceUnavailable: "Voice unavailable · use the buttons", imSafe: "I'm safe", needHelp: "I need help", endCall: "End call",
    reached: "Your answer reached the rescue team.", callEnded: "Call ended", declined: "Call declined",
    instruction: "Official instruction", sending: "Sending…",
  },
  fr: {
    armTitle: "Touchez pour activer cet appareil", armHint: "Autorise le son, le micro et garde l'écran allumé.",
    armed: "Activé · en attente d'alertes", armedHint: "Gardez cette page ouverte.",
    from: "Mairie de Sommières · Noé", floodAlert: "Alerte inondation", accept: "Répondre", decline: "Refuser",
    connecting: "Connexion…", speaking: "Noé parle", listening: "À l'écoute",
    voiceUnavailable: "Voix indisponible · utilisez les boutons", imSafe: "Je suis en sécurité", needHelp: "J'ai besoin d'aide", endCall: "Raccrocher",
    reached: "Votre réponse a été transmise aux secours.", callEnded: "Appel terminé", declined: "Appel refusé",
    instruction: "Consigne officielle", sending: "Envoi…",
  },
  es: {
    armTitle: "Toque para activar este dispositivo", armHint: "Permite el sonido, el micrófono y mantiene la pantalla encendida.",
    armed: "Activado · esperando alertas", armedHint: "Mantenga esta página abierta.",
    from: "Ayuntamiento de Sommières · Noé", floodAlert: "Alerta de inundación", accept: "Aceptar", decline: "Rechazar",
    connecting: "Conectando…", speaking: "Noé está hablando", listening: "Escuchando",
    voiceUnavailable: "Voz no disponible · use los botones", imSafe: "Estoy a salvo", needHelp: "Necesito ayuda", endCall: "Colgar",
    reached: "Su respuesta ha llegado al equipo de rescate.", callEnded: "Llamada finalizada", declined: "Llamada rechazada",
    instruction: "Instrucción oficial", sending: "Enviando…",
  },
  pt: {
    armTitle: "Toque para ativar este dispositivo", armHint: "Permite som, microfone e mantém o ecrã ligado.",
    armed: "Ativado · à espera de alertas", armedHint: "Mantenha esta página aberta.",
    from: "Câmara de Sommières · Noé", floodAlert: "Alerta de inundação", accept: "Atender", decline: "Recusar",
    connecting: "A ligar…", speaking: "A Noé está a falar", listening: "A ouvir",
    voiceUnavailable: "Voz indisponível · use os botões", imSafe: "Estou em segurança", needHelp: "Preciso de ajuda", endCall: "Desligar",
    reached: "A sua resposta chegou à equipa de socorro.", callEnded: "Chamada terminada", declined: "Chamada recusada",
    instruction: "Instrução oficial", sending: "A enviar…",
  },
  ar: {
    armTitle: "المس لتفعيل هذا الجهاز", armHint: "يسمح بالصوت والميكروفون ويبقي الشاشة مضاءة.",
    armed: "مُفعّل · في انتظار التنبيهات", armedHint: "أبقِ هذه الصفحة مفتوحة.",
    from: "بلدية سوميير · نوي", floodAlert: "تنبيه فيضان", accept: "رد", decline: "رفض",
    connecting: "جارٍ الاتصال…", speaking: "نوي تتحدث", listening: "أستمع",
    voiceUnavailable: "الصوت غير متاح · استخدم الأزرار", imSafe: "أنا بأمان", needHelp: "أحتاج مساعدة", endCall: "إنهاء المكالمة",
    reached: "وصل ردك إلى فريق الإنقاذ.", callEnded: "انتهت المكالمة", declined: "تم رفض المكالمة",
    instruction: "التعليمات الرسمية", sending: "جارٍ الإرسال…",
  },
};

/** Response of GET /api/dove/[residentId]. */
export interface DoveInfo {
  resident: { id: string; name: string; language: string; age: number | null; persona: boolean };
  town: string;
  instruction: string;
  eta: string | null;
  firstMessage: string;
  latestCall: import("./types").DoveCall | null;
  /** ElevenLabs agent id, read on the server at request time (no rebuild needed after setting it). */
  agentId?: string | null;
}
