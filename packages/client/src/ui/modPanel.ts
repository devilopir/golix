import { getStadium, physicsFor, type HudItem, type PlayerPhysics, type PlayerPhysicsOverrides, type RoomEvent } from '@golix/shared';
import type { RoomSession } from '../session.ts';
import { button, cancelButton, h, labeled, openDialog, select } from './dom.ts';

/** A game mode built from the stadium's own player physics, so it keeps its feel on any map. */
export interface Preset {
  name: string;
  physics: (pp: PlayerPhysics) => PlayerPhysicsOverrides | null;
}

export const PRESETS: readonly Preset[] = [
  { name: 'Normal', physics: () => null },
  { name: 'Power shots', physics: (pp) => ({ kickStrength: pp.kickStrength * 1.6 }) },
  { name: 'Ice rink', physics: (pp) => ({ damping: 1 - (1 - pp.damping) * 0.35, kickingDamping: 1 - (1 - pp.kickingDamping) * 0.35, acceleration: pp.acceleration * 0.5 }) },
  { name: 'Giants', physics: (pp) => ({ radius: pp.radius * 1.5 }) },
  { name: 'Tiny', physics: (pp) => ({ radius: pp.radius * 0.65 }) },
  { name: 'Speedsters', physics: (pp) => ({ acceleration: pp.acceleration * 1.4, kickingAcceleration: pp.kickingAcceleration * 1.4 }) },
];

const POSITIONS = [
  { value: 0.12, label: 'Top' },
  { value: 0.5, label: 'Middle' },
  { value: 0.82, label: 'Bottom' },
] as const;

const SIZES = [
  { value: 14, label: 'Small' },
  { value: 20, label: 'Medium' },
  { value: 32, label: 'Large' },
] as const;

const ZOOMS = [0.75, 1, 1.25, 1.5, 2].map((value) => ({ value, label: `${value}x` }));

/** The editable fields of one player's physics, with their labels. */
const PLAYER_FIELDS = [
  ['kickStrength', 'Kick strength'],
  ['acceleration', 'Acceleration'],
  ['radius', 'Size'],
  ['kickback', 'Kickback'],
] as const;

/** Host tools for a room this browser runs: game mode presets, one player's physics, screen text and the camera. */
export class RoomMods {
  private preset: Preset = PRESETS[0]!;
  private hudCount = 0;
  private readonly unsubscribe: () => void;

  /** `send` applies a host event to the room; it is only given for rooms this browser hosts. */
  constructor(
    private readonly session: RoomSession,
    private readonly send: (ev: RoomEvent) => void,
  ) {
    // Players who join later and a new stadium get the running preset too.
    this.unsubscribe = session.onEvent((ev) => {
      if (this.preset === PRESETS[0]) return;
      if (ev.type === 'playerJoin') this.applyPreset([ev.player.id]);
      else if (ev.type === 'setStadium') this.applyPreset(session.getRoom().players.map((p) => p.id));
    });
  }

  get presetName(): string {
    return this.preset.name;
  }

  setPreset(preset: Preset): void {
    this.preset = preset;
    this.applyPreset(this.session.getRoom().players.map((p) => p.id));
  }

  private applyPreset(playerIds: number[]): void {
    const physics = this.preset.physics(getStadium(this.session.getRoom().stadiumSource).playerPhysics);
    for (const playerId of playerIds) this.send({ type: 'setPlayerPhysics', playerId, physics });
  }

  /** A screen text with an id of its own. */
  addText(item: Omit<HudItem, 'id'>): void {
    this.send({ type: 'setHudItem', id: `panel${++this.hudCount}`, item });
  }

  dispose(): void {
    this.unsubscribe();
  }

  open(host: HTMLElement): void {
    const room = this.session.getRoom();
    const stadium = getStadium(room.stadiumSource);
    const section = (title: string, ...children: HTMLElement[]) => h('section', { className: 'dk-mod-section' }, h('h3', { textContent: title }), ...children);

    const presets = h(
      'div',
      { className: 'dk-row dk-mod-presets' },
      ...PRESETS.map((p) => {
        const el = button(p.name, () => {
          this.setPreset(p);
          for (const b of presets.querySelectorAll('button')) b.classList.toggle('on', b === el);
        });
        el.classList.toggle('on', p === this.preset);
        return el;
      }),
    );

    const players = room.players.map((p) => ({ value: p.id, label: p.name }));
    let playerId = players[0]?.value ?? -1;
    const inputs = new Map<string, HTMLInputElement>();
    const fill = () => {
      const pp = physicsFor(stadium, this.session.getRoom().players.find((p) => p.id === playerId)?.physics);
      for (const [key] of PLAYER_FIELDS) inputs.get(key)!.value = String(Math.round(pp[key] * 1000) / 1000);
    };
    const fields = PLAYER_FIELDS.map(([key, label]) => {
      const input = h('input', { type: 'number', step: 'any', min: '0' });
      inputs.set(key, input);
      return labeled(label, input);
    });
    const playerSection = section(
      'One player',
      labeled('Player', select(players, playerId, (id) => ((playerId = id), fill()))),
      ...fields,
      h(
        'div',
        { className: 'dk-row' },
        button('Apply', () => {
          const physics: PlayerPhysicsOverrides = {};
          for (const [key] of PLAYER_FIELDS) {
            const v = Number(inputs.get(key)!.value);
            if (Number.isFinite(v) && v >= 0 && v !== stadium.playerPhysics[key]) physics[key] = v;
          }
          this.send({ type: 'setPlayerPhysics', playerId, physics });
        }),
        button('Reset', () => {
          this.send({ type: 'setPlayerPhysics', playerId, physics: null });
          for (const [key] of PLAYER_FIELDS) inputs.get(key)!.value = String(stadium.playerPhysics[key]);
        }),
      ),
    );
    if (players.length > 0) fill();

    const text = h('input', { type: 'text', maxLength: 100, placeholder: 'Text on everyone’s screen' });
    const color = h('input', { type: 'color', value: '#ffffff' });
    let y: number = POSITIONS[0].value;
    let size: number = SIZES[1].value;
    const list = h('ul', { className: 'dk-mod-texts' });
    const renderTexts = () =>
      list.replaceChildren(
        ...this.session.getRoom().hud.map((item) =>
          h('li', {}, h('span', { textContent: item.text }), button('Remove', () => this.send({ type: 'setHudItem', id: item.id, item: null }))),
        ),
      );
    const textSection = section(
      'Screen text',
      text,
      h('div', { className: 'dk-row' }, select(POSITIONS, y, (v) => (y = v)), select(SIZES, size, (v) => (size = v)), color),
      button('Add', () => {
        if (text.value.trim() === '') return;
        this.addText({ text: text.value, x: 0.5, y, align: 'center', color: parseInt(color.value.slice(1), 16), size });
        text.value = '';
      }),
      list,
    );
    renderTexts();

    const follow = [{ value: 'normal', label: 'Normal' }, { value: 'ball', label: 'Ball' }, ...room.players.map((p) => ({ value: `p${p.id}`, label: p.name }))];
    let target = 'normal';
    let zoom = room.camera.zoom;
    const cameraSection = section(
      'Camera',
      h('div', { className: 'dk-row' }, select(follow, target, (v) => (target = v)), select(ZOOMS, zoom, (v) => (zoom = v))),
      button('Apply', () =>
        this.send({
          type: 'setCamera',
          camera: { follow: target === 'normal' ? null : target === 'ball' ? { type: 'disc', index: 0 } : { type: 'player', id: Number(target.slice(1)) }, zoom },
        }),
      ),
    );

    const dialog = openDialog(host, 'Mods', [section('Game mode', presets), playerSection, textSection, cameraSection], [
      cancelButton('Close', () => {
        stop();
        dialog.close();
      }),
    ], 'dk-mod-panel');
    const stop = this.session.onEvent((ev) => ev.type === 'setHudItem' && renderTexts());
  }
}
