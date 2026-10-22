// WebAudio phone ring (no audio files). European two-tone double ring:
// 400 Hz + 450 Hz, 0.4 s on / 0.2 s off / 0.4 s on / 2 s off.

const CYCLE_S = 3.0;
const BURSTS: [number, number][] = [[0, 0.4], [0.6, 1.0]];
const VIBRATE = [400, 200, 400, 2000];

export class Ringtone {
  private timer: ReturnType<typeof setInterval> | null = null;
  private nodes: AudioScheduledSourceNode[] = [];
  private master: GainNode | null = null;

  constructor(private ctx: AudioContext) {}

  /** Plays a very short silent buffer: keeps iOS audio unlocked after the arm tap. */
  prime() {
    try {
      const b = this.ctx.createBuffer(1, 1, 22050);
      const s = this.ctx.createBufferSource();
      s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    } catch { /* ignore */ }
  }

  get playing() { return this.timer !== null; }

  start() {
    if (this.timer) return;
    void this.ctx.resume().catch(() => {});
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.22;
    this.master.connect(this.ctx.destination);
    const schedule = () => {
      const t0 = this.ctx.currentTime + 0.05;
      for (const [a, b] of BURSTS) this.burst(t0 + a, t0 + b);
      try { navigator.vibrate?.(VIBRATE); } catch { /* not supported (iOS) */ }
    };
    schedule();
    this.timer = setInterval(schedule, CYCLE_S * 1000);
  }

  private burst(from: number, to: number) {
    if (!this.master) return;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, from);
    env.gain.linearRampToValueAtTime(1, from + 0.02);
    env.gain.setValueAtTime(1, to - 0.02);
    env.gain.linearRampToValueAtTime(0, to);
    env.connect(this.master);
    for (const f of [400, 450]) {
      const o = this.ctx.createOscillator();
      o.type = "sine"; o.frequency.value = f;
      o.connect(env); o.start(from); o.stop(to + 0.01);
      this.nodes.push(o);
      o.onended = () => { this.nodes = this.nodes.filter((n) => n !== o); };
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const n of this.nodes) { try { n.stop(); } catch { /* already stopped */ } }
    this.nodes = [];
    try { this.master?.disconnect(); } catch { /* ignore */ }
    this.master = null;
    try { navigator.vibrate?.(0); } catch { /* ignore */ }
  }
}
