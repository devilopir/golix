import { InputFlags, Team } from '@golix/shared';
import { describe, expect, it } from 'vitest';
import { balanceStats } from '../examples/balance-stats.ts';
import { headless } from './helpers.ts';

describe('balance-stats example bot', () => {
  it('balances joining and leaving players and announces goals, assists and kicks after the match', async () => {
    const { room, inner, tick, join } = await headless();
    balanceStats(room);
    const peers = ['p1', 'p2', 'p3', 'p4', 'p5'].map((name) => join(name));
    tick();
    const teamOf = (i: number) => room.getPlayer(peers[i].playerId)?.team;
    expect(peers.map((_, i) => teamOf(i))).toEqual([Team.red, Team.blue, Team.red, Team.blue, Team.red]);

    peers[1].handle.closed();
    tick(2);
    expect([0, 2, 3, 4].map(teamOf)).toEqual([Team.red, Team.red, Team.blue, Team.blue]);

    const [p1, , p3] = peers;
    room.setScoreLimit(1);
    room.startGame();
    tick();
    const kick = (peer: typeof p1, ballX: number) => {
      room.setDiscProperties(0, { x: ballX, y: 0, xspeed: 0, yspeed: 0 });
      room.setPlayerDiscProperties(peer.playerId, { x: ballX - 25, y: 0, xspeed: 0, yspeed: 0 });
      peer.send({ type: 'input', tick: inner.tick + 1, input: InputFlags.kick });
      tick();
      peer.send({ type: 'input', tick: inner.tick + 1, input: 0 });
      room.setPlayerDiscProperties(peer.playerId, { x: -300, y: 100 });
    };
    kick(p1, 300);
    kick(p3, 340);
    tick(30);
    expect(room.getScores()).toEqual(expect.objectContaining({ red: 1, blue: 0 }));

    tick(152);
    const lines = p1.events().flatMap((e) => (e.type === 'announcement' ? [e.text] : []));
    expect(lines).toEqual(['Red wins 1-0', 'p1: 0 goals, 1 assists, 1 kicks, 0 own goals', 'p3: 1 goals, 0 assists, 1 kicks, 0 own goals']);
  });

  it('counts an own goal against the last kicker', async () => {
    const { room, inner, tick, join } = await headless();
    balanceStats(room);
    const p1 = join('p1');
    join('p2');
    tick();
    room.setScoreLimit(1);
    room.startGame();
    tick();
    room.setDiscProperties(0, { x: -340, y: 0, xspeed: 0, yspeed: 0 });
    room.setPlayerDiscProperties(p1.playerId, { x: -315, y: 0, xspeed: 0, yspeed: 0 });
    p1.send({ type: 'input', tick: inner.tick + 1, input: InputFlags.kick });
    tick(182);
    const lines = p1.events().flatMap((e) => (e.type === 'announcement' ? [e.text] : []));
    expect(lines).toEqual(['Blue wins 0-1', 'p1: 0 goals, 0 assists, 1 kicks, 1 own goals']);
  });
});
