// @vitest-environment happy-dom
import { getStadium, type RoomEvent } from '@golix/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRESETS, RoomMods } from '../../src/ui/modPanel.ts';
import { FakeSession, click, player, room } from './fakes.ts';

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => host.remove());

function setup() {
  const session = new FakeSession(room([player(1, 'alice'), player(2, 'bob')]));
  const sent: RoomEvent[] = [];
  const mods = new RoomMods(session, (ev) => sent.push(ev));
  return { session, sent, mods, pp: getStadium(session.state.stadiumSource).playerPhysics };
}

describe('RoomMods', () => {
  it("builds presets from the stadium's physics, gives them to players who join later, and clears them with Normal", () => {
    const { session, sent, mods, pp } = setup();
    mods.setPreset(PRESETS.find((p) => p.name === 'Power shots')!);
    expect(sent).toEqual([1, 2].map((playerId) => ({ type: 'setPlayerPhysics', playerId, physics: { kickStrength: pp.kickStrength * 1.6 } })));
    sent.length = 0;
    session.emit({ type: 'playerJoin', player: player(3, 'carol') });
    expect(sent).toEqual([{ type: 'setPlayerPhysics', playerId: 3, physics: { kickStrength: pp.kickStrength * 1.6 } }]);
    sent.length = 0;
    mods.setPreset(PRESETS[0]!);
    session.emit({ type: 'playerJoin', player: player(4, 'dave') });
    expect(sent).toEqual([1, 2].map((playerId) => ({ type: 'setPlayerPhysics', playerId, physics: null })));
  });

  it('sends only the fields changed for one player, adds and removes screen text and points the camera at the ball', () => {
    const { session, sent, mods, pp } = setup();
    mods.open(host);
    const field = (label: string) => [...host.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))!.querySelector('input')!;
    expect(field('Kick strength').value).toBe(String(pp.kickStrength));
    field('Kick strength').value = '9';
    click(host.querySelectorAll('section')[1]!, 'Apply');
    expect(sent.at(-1)).toEqual({ type: 'setPlayerPhysics', playerId: 1, physics: { kickStrength: 9 } });

    host.querySelector<HTMLInputElement>('input[type=text]')!.value = 'Final!';
    click(host, 'Add');
    expect(sent.at(-1)).toEqual({ type: 'setHudItem', id: 'panel1', item: { text: 'Final!', x: 0.5, y: 0.12, align: 'center', color: 0xffffff, size: 20 } });
    session.state = { ...session.state, hud: [{ id: 'panel1', text: 'Final!', x: 0.5, y: 0.12, align: 'center', color: 0xffffff, size: 20 }] };
    session.emit({ type: 'setHudItem', id: 'panel1', item: null });
    click(host.querySelector('.dk-mod-texts')!, 'Remove');
    expect(sent.at(-1)).toEqual({ type: 'setHudItem', id: 'panel1', item: null });

    const cameraSection = host.querySelectorAll('section')[3]!;
    const followSelect = cameraSection.querySelector('select')!;
    followSelect.value = '1';
    followSelect.dispatchEvent(new Event('change'));
    click(cameraSection, 'Apply');
    expect(sent.at(-1)).toEqual({ type: 'setCamera', camera: { follow: { type: 'disc', index: 0 }, zoom: 1 } });
  });
});
