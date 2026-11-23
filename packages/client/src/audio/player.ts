import type { Settings } from '../settings/settings.ts';
import { SOUND_SAMPLES, isCategoryEnabled, type SampleSound, type SoundName } from './recipes.ts';

export interface AudioParamLike {
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
}

export interface ScheduledNodeLike extends AudioNodeLike {
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioBufferLike {
  readonly duration: number;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: AudioNodeLike;
  resume(): Promise<void>;
  createGain(): AudioNodeLike & { gain: AudioParamLike };
  createBufferSource(): ScheduledNodeLike & { buffer: AudioBufferLike | null };
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
}

export type SampleLoader = (file: string) => Promise<ArrayBuffer>;

const fetchSample: SampleLoader = (file) =>
  fetch(`${import.meta.env.BASE_URL}sounds/${file}`).then((res) => {
    if (!res.ok) throw new Error(`sound ${file}: HTTP ${res.status}`);
    return res.arrayBuffer();
  });

type AudioSettings = Pick<Settings, 'soundEnabled' | 'chatSoundEnabled' | 'highlightSoundEnabled' | 'crowdSoundEnabled' | 'volume'>;

export class SoundPlayer {
  private readonly samples = new Map<string, AudioBufferLike>();
  private playing: { source: ScheduledNodeLike; end: number }[] = [];

  constructor(
    private readonly ctx: AudioContextLike,
    private readonly settings: () => AudioSettings,
    load: SampleLoader = fetchSample,
  ) {
    for (const parts of Object.values(SOUND_SAMPLES)) {
      for (const { file } of parts) {
        void load(file)
          .then((data) => ctx.decodeAudioData(data))
          .then((buffer) => this.samples.set(file, buffer));
      }
    }
  }

  play(name: SoundName): void {
    const settings = this.settings();
    if (settings.volume <= 0) return;
    const scale = settings.volume;
    const clips = SOUND_SAMPLES[name].filter((part) => isCategoryEnabled(settings, part.category) && this.samples.has(part.file));
    if (clips.length === 0) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    const now = this.ctx.currentTime;
    for (const clip of clips) this.playSample(clip, this.samples.get(clip.file)!, now, scale);
  }

  /** Cuts every clip still playing, e.g. the crowd when a match is stopped. */
  stopAll(): void {
    const now = this.ctx.currentTime;
    for (const { source, end } of this.playing) if (end > now) source.stop(now);
    this.playing = [];
  }

  private playSample(clip: SampleSound, buffer: AudioBufferLike, now: number, scale: number): void {
    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(scale, now);
    amp.connect(this.ctx.destination);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(amp);
    source.start(now);
    let end = now + buffer.duration;
    if (clip.fadeOut !== undefined) {
      amp.gain.setValueAtTime(scale, now + clip.fadeOut.start);
      amp.gain.linearRampToValueAtTime(0, now + clip.fadeOut.end);
      end = now + clip.fadeOut.end;
      source.stop(end);
    }
    this.playing = this.playing.filter((p) => p.end > now);
    this.playing.push({ source, end });
  }
}
