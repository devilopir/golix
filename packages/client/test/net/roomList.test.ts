import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpRoomList, parseRoomLink, roomLink } from '../../src/net/roomList.ts';

afterEach(() => vi.unstubAllGlobals());

describe('room links', () => {
  it('builds /play?c=<id> links with p=1 for locked rooms', () => {
    expect(roomLink('https://example.test', 'AbCdEfGh_-1', false)).toBe('https://example.test/play?c=AbCdEfGh_-1');
    expect(roomLink('https://example.test', 'AbCdEfGh_-1', true)).toBe('https://example.test/play?c=AbCdEfGh_-1&p=1');
  });

  it('parses the room and password flag from a link and ignores malformed ids', () => {
    expect(parseRoomLink('?c=AbCdEfGh_-1&p=1')).toMatchObject({ id: 'AbCdEfGh_-1', hasPassword: true });
    expect(parseRoomLink('?c=AbCdEfGh_-1')).toMatchObject({ id: 'AbCdEfGh_-1', hasPassword: false });
    expect(parseRoomLink('')).toBeUndefined();
    expect(parseRoomLink('?c=../rooms')).toBeUndefined();
    expect(parseRoomLink('?c=short')).toBeUndefined();
  });
});

describe('http room list', () => {
  it('reads /rooms and /lobby over https from a wss lobby and rejects failed requests', async () => {
    const fetch = vi.fn(async (url: string) => (url.endsWith('/lobby') ? Response.json({ country: 'tr', notice: 'hi' }) : new Response('', { status: 503 })));
    vi.stubGlobal('fetch', fetch);
    const source = httpRoomList('wss://lobby.example.test');
    expect(await source.lobby()).toEqual({ country: 'tr', notice: 'hi' });
    expect(fetch).toHaveBeenCalledWith('https://lobby.example.test/lobby');
    await expect(source.list()).rejects.toThrow('/rooms request failed with HTTP 503');
  });
});
