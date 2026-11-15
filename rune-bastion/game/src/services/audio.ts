/**
 * Procedural audio: every sound effect and the background music are synthesised with WebAudio,
 * so the game ships no audio files. The context is created on the first user gesture and
 * suspended whenever the app is paused.
 */
type Wave = OscillatorType;

export class AudioService {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private last = new Map<string, number>();
  private mood: 'menu' | 'battle' | 'boss' = 'menu';
  sfxVol = 0.8;
  musicVol = 0.5;

  /** Must be called from a user gesture (autoplay policies). Safe to call repeatedly. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        const c = this.ctx!;
        this.master = c.createGain();
        this.master.connect(c.destination);
        this.sfxGain = c.createGain();
        this.sfxGain.connect(this.master);
        this.musicGain = c.createGain();
        this.musicGain.connect(this.master);
        this.applyVolumes();
        this.startMusic();
      }
      if (this.ctx!.state === 'suspended') this.ctx!.resume().catch(() => undefined);
    } catch { this.ctx = null; }
  }
  setVolumes(sfx: number, music: number): void {
    this.sfxVol = sfx;
    this.musicVol = music;
    this.applyVolumes();
  }
  private applyVolumes(): void {
    if (this.sfxGain) this.sfxGain.gain.value = this.sfxVol * 0.5;
    if (this.musicGain) this.musicGain.gain.value = this.musicVol * 0.22;
  }
  pause(): void {
    this.ctx?.suspend().catch(() => undefined);
  }
  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined);
  }
  setMood(m: 'menu' | 'battle' | 'boss'): void {
    this.mood = m;
  }

  private tone(freq: number, dur: number, type: Wave, vol: number, opts: { slide?: number; delay?: number; out?: GainNode | null; attack?: number } = {}): void {
    const c = this.ctx, out = opts.out ?? this.sfxGain;
    if (!c || !out || c.state !== 'running') return;
    const t0 = c.currentTime + (opts.delay ?? 0);
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * opts.slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + (opts.attack ?? 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(out);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  private noise(dur: number, vol: number, freq: number, delay = 0): void {
    const c = this.ctx;
    if (!c || !this.sfxGain || c.state !== 'running') return;
    const n = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = buf; f.type = 'lowpass'; f.frequency.value = freq; g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(this.sfxGain);
    src.start(c.currentTime + delay);
  }

  /** Plays a named effect. Identical effects are rate-limited so busy fights do not clip. */
  play(name: string): void {
    if (!this.ctx || this.sfxVol <= 0) return;
    const now = performance.now(), gap = name.startsWith('shot') || name === 'hit' ? 70 : 40;
    if (now - (this.last.get(name) ?? 0) < gap) return;
    this.last.set(name, now);
    switch (name) {
      case 'click': this.tone(660, 0.06, 'triangle', 0.25); break;
      case 'deny': this.tone(180, 0.14, 'square', 0.18, { slide: 0.7 }); break;
      case 'place': this.tone(220, 0.12, 'triangle', 0.4, { slide: 0.6 }); this.noise(0.1, 0.25, 900); break;
      case 'merge': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.3, { delay: i * 0.06 })); break;
      case 'hybrid': [392, 523, 622, 784, 1047, 1245].forEach((f, i) => this.tone(f, 0.26, 'sawtooth', 0.16, { delay: i * 0.055 })); break;
      case 'upgrade': this.tone(520, 0.1, 'triangle', 0.3); this.tone(780, 0.16, 'triangle', 0.3, { delay: 0.08 }); break;
      case 'sell': this.tone(880, 0.07, 'square', 0.14); this.tone(1320, 0.1, 'square', 0.12, { delay: 0.06 }); break;
      case 'coin': this.tone(1320, 0.07, 'square', 0.1); this.tone(1760, 0.09, 'square', 0.09, { delay: 0.05 }); break;
      case 'shot_physical': this.noise(0.05, 0.16, 2500); this.tone(380, 0.05, 'triangle', 0.12, { slide: 0.5 }); break;
      case 'shot_cannon': this.noise(0.22, 0.45, 500); this.tone(90, 0.2, 'sine', 0.5, { slide: 0.5 }); break;
      case 'shot_fire': this.noise(0.14, 0.2, 1400); this.tone(300, 0.12, 'sawtooth', 0.08, { slide: 0.6 }); break;
      case 'shot_ice': this.tone(1500, 0.1, 'sine', 0.14, { slide: 1.5 }); break;
      case 'shot_poison': this.tone(240, 0.12, 'sine', 0.2, { slide: 1.6 }); break;
      case 'shot_lightning': this.noise(0.09, 0.22, 6000); this.tone(900, 0.07, 'square', 0.08, { slide: 0.3 }); break;
      case 'shot_arcane': this.tone(700, 0.09, 'sine', 0.07, { slide: 1.2 }); break;
      case 'shot_light': this.tone(1047, 0.2, 'sine', 0.12); this.tone(1568, 0.2, 'sine', 0.08); break;
      case 'kill': this.tone(300, 0.1, 'square', 0.12, { slide: 0.4 }); break;
      case 'boss_kill': [196, 147, 98].forEach((f, i) => this.tone(f, 0.5, 'sawtooth', 0.3, { delay: i * 0.12, slide: 0.6 })); this.noise(0.8, 0.5, 700); break;
      case 'leak': this.tone(140, 0.3, 'sawtooth', 0.35, { slide: 0.5 }); this.noise(0.2, 0.3, 400); break;
      case 'wave': this.tone(196, 0.5, 'sawtooth', 0.2, { attack: 0.05 }); this.tone(294, 0.6, 'sawtooth', 0.18, { delay: 0.15, attack: 0.05 }); break;
      case 'boss': [110, 104, 98].forEach((f, i) => this.tone(f, 0.7, 'sawtooth', 0.32, { delay: i * 0.3, attack: 0.05 })); break;
      case 'boost': [659, 831, 988].forEach((f, i) => this.tone(f, 0.2, 'triangle', 0.26, { delay: i * 0.07 })); break;
      case 'meteor': this.tone(600, 0.35, 'sawtooth', 0.2, { slide: 0.15 }); this.noise(0.5, 0.55, 600, 0.15); break;
      case 'freeze': this.tone(2000, 0.5, 'sine', 0.14, { slide: 0.4 }); this.tone(1500, 0.5, 'triangle', 0.1, { slide: 0.5, delay: 0.05 }); break;
      case 'overcharge': this.tone(200, 0.4, 'sawtooth', 0.16, { slide: 3 }); break;
      case 'heal': [523, 659, 784].forEach((f, i) => this.tone(f, 0.3, 'sine', 0.22, { delay: i * 0.09 })); break;
      case 'stun': this.tone(120, 0.3, 'square', 0.2, { slide: 0.6 }); break;
      case 'win': [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.28, 'triangle', 0.32, { delay: i * 0.13 })); break;
      case 'lose': [392, 349, 311, 262].forEach((f, i) => this.tone(f, 0.45, 'triangle', 0.3, { delay: i * 0.22 })); break;
      case 'reward': [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.16, 'square', 0.13, { delay: i * 0.07 })); break;
    }
  }

  private startMusic(): void {
    if (this.musicTimer) return;
    // Tiny generative loop: a four-chord progression with an arpeggio; the mood changes tempo and key.
    const prog = { menu: [[220, 262, 330], [175, 220, 262], [262, 330, 392], [196, 247, 294]], battle: [[196, 233, 294], [175, 208, 262], [233, 294, 349], [147, 175, 220]], boss: [[147, 175, 208], [139, 165, 208], [156, 185, 233], [131, 156, 196]] };
    this.musicTimer = setInterval(() => {
      const c = this.ctx;
      if (!c || c.state !== 'running' || this.musicVol <= 0) return;
      const chords = prog[this.mood];
      const bar = Math.floor(this.step / 8) % chords.length, beat = this.step % 8;
      const chord = chords[bar];
      if (beat === 0) for (const f of chord) this.tone(f / 2, 1.9, 'sine', 0.5, { out: this.musicGain, attack: 0.3 });
      const note = chord[[0, 1, 2, 1, 2, 1, 0, 2][beat]] * (beat === 4 || beat === 7 ? 2 : 1);
      this.tone(note, 0.3, 'triangle', this.mood === 'menu' ? 0.35 : 0.5, { out: this.musicGain, attack: 0.02 });
      if (this.mood !== 'menu' && beat % 2 === 0) this.tone(chord[0] / 4, 0.18, 'square', 0.3, { out: this.musicGain });
      this.step++;
    }, 250);
  }
}
