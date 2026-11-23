import { describe, expect, it, vi } from 'vitest';
import { adminRoom, parseList } from '../examples/admin-room.ts';
import { FakePeer, headless, testKey } from './helpers.ts';

describe('admin-room example', () => {
  it('parses comma-separated lists', () => {
    expect(parseList(' boss, ,mira ,')).toEqual(new Set(['boss', 'mira']));
    expect(parseList(undefined)).toEqual(new Set());
  });

  it('gives admin by nickname or by a signed auth id and logs every joiner', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { room, inner, tick } = await headless();
    adminRoom(room, { names: new Set(['chief']), auths: new Set([testKey('owner').authId]) });
    const join = (name: string, opts: { key?: string; signature?: string } = {}) => {
      const peer = new FakePeer(inner);
      peer.join(name, opts);
      tick(2);
      return room.getPlayer(peer.playerId)!;
    };

    expect(join('renamed', { key: 'owner' }).admin).toBe(true);
    expect(join('chief').admin).toBe(true);
    expect(join('forger', { key: 'owner', signature: 'AAAA' }).admin).toBe(false);
    expect(join('guest').admin).toBe(false);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      `Joined: "renamed" auth=${testKey('owner').authId} conn=`,
      `Joined: "chief" auth=${testKey('chief').authId} conn=`,
      'Joined: "forger" auth=- conn=',
      `Joined: "guest" auth=${testKey('guest').authId} conn=`,
    ]);
    log.mockRestore();
  });

  it('gives admin to everyone when asked to', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { room, inner, tick } = await headless();
    adminRoom(room, { names: new Set(), auths: new Set(), everyone: true });
    const peer = new FakePeer(inner);
    peer.join('anyone');
    tick(2);
    expect(room.getPlayer(peer.playerId)!.admin).toBe(true);
  });
});
