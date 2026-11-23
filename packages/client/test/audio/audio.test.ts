import { describe, expect, expectTypeOf, it } from 'vitest';
import { SoundPlayer, type AudioBufferLike, type AudioContextLike, type AudioNodeLike, type AudioParamLike } from '../../src/audio/player.ts';
import { readFileSync } from 'node:fs';
import { SOUND_SAMPLES, isCategoryEnabled } from '../../src/audio/recipes.ts';
import { defaultSettings } from '../../src/settings/settings.ts';

const FILES = Object.values(SOUND_SAMPLES).flatMap((parts) => parts.map((p) => p.file));

class FakeParam implements AudioParamLike {
  readonly events: [string, number, number][] = [];
  setValueAtTime(value: number, time: number) {
    this.events.push(['set', value, time]);
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push(['linear', value, time]);
  }
}

class FakeNode implements AudioNodeLike {
  readonly outputs: FakeNode[] = [];
  started: number | undefined;
  stopped: number | undefined;
  constructor(readonly kind: string) {}
  connect(destination: AudioNodeLike) {
    this.outputs.push(destination as FakeNode);
  }
  start(when?: number) {
    this.started = when;
  }
  stop(when?: number) {
    this.stopped = when;
  }
}

class FakeContext implements AudioContextLike {
  currentTime = 10;
  state = 'suspended';
  resumed = 0;
  readonly destination = new FakeNode('destination');
  readonly nodes: FakeNode[] = [];

  private track<T extends FakeNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }
  resume() {
    this.resumed++;
    this.state = 'running';
    return Promise.resolve();
  }
  createGain() {
    return this.track(Object.assign(new FakeNode('gain'), { gain: new FakeParam() }));
  }
  createBufferSource() {
    return this.track(Object.assign(new FakeNode('source'), { buffer: null as AudioBufferLike | null }));
  }
  decodeAudioData(data: ArrayBuffer) {
    const name = new TextDecoder().decode(data);
    return Promise.resolve({ name, duration: name === 'crowd.ogg' ? 8.5 : 0.2 });
  }
}

const loadName = (file: string) => Promise.resolve(new TextEncoder().encode(file).buffer as ArrayBuffer);

async function loadedPlayer(ctx: FakeContext, settings = defaultSettings) {
  const player = new SoundPlayer(ctx, settings, loadName);
  await new Promise((r) => setTimeout(r, 0));
  return player;
}

function playedFiles(ctx: FakeContext): string[] {
  return ctx.nodes.flatMap((n) => {
    const buffer = (n as unknown as { buffer?: { name?: string } | null }).buffer;
    return buffer?.name ? [buffer.name] : [];
  });
}

function reachesDestination(node: FakeNode, destination: FakeNode): boolean {
  return node === destination || node.outputs.some((out) => reachesDestination(out, destination));
}

describe('sound tables', () => {
  it('ships every referenced clip in public/sounds', () => {
    for (const file of FILES) expect(readFileSync(new URL(`../../public/sounds/${file}`, import.meta.url)).length).toBeGreaterThan(0);
  });

  it('gates categories by master and category toggles', () => {
    const settings = defaultSettings();
    expect(isCategoryEnabled(settings, 'crowd')).toBe(true);
    expect(isCategoryEnabled({ ...settings, soundEnabled: false }, 'game')).toBe(false);
    expect(isCategoryEnabled({ ...settings, crowdSoundEnabled: false }, 'crowd')).toBe(false);
    expect(isCategoryEnabled({ ...settings, crowdSoundEnabled: false }, 'game')).toBe(true);
    expect(isCategoryEnabled({ ...settings, chatSoundEnabled: false }, 'chat')).toBe(false);
    expect(isCategoryEnabled({ ...settings, highlightSoundEnabled: false }, 'highlight')).toBe(false);
  });

});

describe('SoundPlayer', () => {
  it('accepts a real AudioContext', () => {
    expectTypeOf<AudioContext>().toExtend<AudioContextLike>();
  });

  it('plays the loaded clip through a gain at the master volume', async () => {
    const ctx = new FakeContext();
    const player = await loadedPlayer(ctx, () => ({ ...defaultSettings(), volume: 0.5 }));
    player.play('kick');
    expect(ctx.resumed).toBe(1);
    expect(playedFiles(ctx)).toEqual(['kick.wav']);
    const source = ctx.nodes.find((n) => n.kind === 'source')!;
    expect(source.started).toBe(10);
    expect(reachesDestination(source, ctx.destination)).toBe(true);
    const gain = ctx.nodes.find((n) => n.kind === 'gain') as unknown as { gain: FakeParam };
    expect(gain.gain.events).toEqual([['set', 0.5, 10]]);
  });

  it('plays the crowd with a goal only while the crowd toggle is on', async () => {
    const on = new FakeContext();
    (await loadedPlayer(on)).play('goal');
    expect(playedFiles(on)).toEqual(['goal.wav', 'crowd.ogg']);
    const off = new FakeContext();
    (await loadedPlayer(off, () => ({ ...defaultSettings(), crowdSoundEnabled: false }))).play('goal');
    expect(playedFiles(off)).toEqual(['goal.wav']);
  });

  it('fades the crowd out by the end of the goal pause', async () => {
    const ctx = new FakeContext();
    (await loadedPlayer(ctx)).play('goal');
    const crowd = ctx.nodes.find((n) => (n as unknown as { buffer?: { name?: string } }).buffer?.name === 'crowd.ogg')!;
    expect(crowd.stopped).toBe(12.5);
    const gains = ctx.nodes.filter((n) => n.kind === 'gain') as unknown as { gain: FakeParam }[];
    expect(gains[1]!.gain.events).toEqual([
      ['set', 1, 10],
      ['set', 1, 11.5],
      ['linear', 0, 12.5],
    ]);
  });

  it('cuts clips still playing when stopped and leaves finished ones alone', async () => {
    const ctx = new FakeContext();
    const player = await loadedPlayer(ctx);
    player.play('goal');
    ctx.currentTime = 11;
    player.stopAll();
    const sources = ctx.nodes.filter((n) => n.kind === 'source');
    expect(sources.map((s) => s.stopped)).toEqual([undefined, 11]);
  });

  it('creates no nodes when the sound is disabled, muted or not loaded yet', async () => {
    const ctx = new FakeContext();
    (await loadedPlayer(ctx, () => ({ ...defaultSettings(), chatSoundEnabled: false }))).play('chat');
    (await loadedPlayer(ctx, () => ({ ...defaultSettings(), volume: 0 }))).play('kick');
    new SoundPlayer(ctx, defaultSettings, loadName).play('kick');
    expect(ctx.nodes).toEqual([]);
    expect(ctx.resumed).toBe(0);
  });
});
