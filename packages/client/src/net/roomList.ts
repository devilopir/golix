import type { LobbyInfo, RoomListing } from '@golix/shared';
import type { RoomListEntry, RoomListSource } from '../ui/roomList.ts';

const ROOM_ID = /^[A-Za-z0-9_-]{11}$/;

async function getJson<T>(serverUrl: string, path: string): Promise<T> {
  const res = await fetch(`${serverUrl.replace(/^ws/, 'http')}${path}`);
  if (!res.ok) throw new Error(`${path} request failed with HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Reads GET /rooms and GET /lobby from the server behind `serverUrl` (ws:// or wss://). */
export function httpRoomList(serverUrl: string): RoomListSource {
  return {
    list: () => getJson<RoomListing[]>(serverUrl, '/rooms'),
    lobby: () => getJson<LobbyInfo>(serverUrl, '/lobby'),
  };
}

export function roomLink(origin: string, id: string, hasPassword: boolean): string {
  const link = new URL('/play', origin);
  link.searchParams.set('c', id);
  if (hasPassword) link.searchParams.set('p', '1');
  return link.href;
}

/** The room a `?c=<id>[&p=1]` link points to; its name and counts are unknown until joined. */
export function parseRoomLink(search: string): RoomListEntry | undefined {
  const params = new URLSearchParams(search);
  const id = params.get('c');
  if (id === null || !ROOM_ID.test(id)) return undefined;
  return { id, name: id, players: 0, maxPlayers: 0, hasPassword: params.get('p') === '1', captcha: false, actionKeys: false, country: '', lat: 0, lon: 0 };
}
