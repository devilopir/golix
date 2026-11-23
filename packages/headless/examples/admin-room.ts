import { fileURLToPath } from 'node:url';
import { HBInit, type RoomObject } from '@golix/headless';

export interface Admins {
  /** Nicknames are not verified: anyone can join under one. */
  names: ReadonlySet<string>;
  /** Auth ids; a player only has one after signing the join challenge with its key. */
  auths: ReadonlySet<string>;
  /** Gives admin to every joiner, for a private room among friends. */
  everyone?: boolean;
}

/** Parses a comma-separated list such as ADMIN_NAMES or ADMIN_AUTHS. */
export function parseList(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((n) => n.trim()).filter((n) => n !== ''));
}

/** Logs every joiner's name and auth and gives admin to the listed names and auth ids. */
export function adminRoom(room: RoomObject, admins: Admins): void {
  room.onPlayerJoin = (player) => {
    console.log(`Joined: ${JSON.stringify(player.name)} auth=${player.auth ?? '-'} conn=${player.conn}`);
    if (admins.everyone || admins.names.has(player.name) || (player.auth !== null && admins.auths.has(player.auth))) room.setPlayerAdmin(player.id, true);
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [code, lat, lon] = (process.env.ROOM_GEO ?? '').split(',');
  const room = HBInit({
    roomName: process.env.ROOM_NAME || 'Golix',
    maxPlayers: Number(process.env.MAX_PLAYERS || 12),
    password: process.env.PASSWORD,
    public: true,
    noPlayer: true,
    geo: code ? { code, lat: Number(lat), lon: Number(lon) } : undefined,
    lobby: process.env.LOBBY_URL || 'wss://golix.cosmosfutsal.com',
    roomSecret: process.env.ROOM_SECRET || undefined,
  });
  adminRoom(room, { names: parseList(process.env.ADMIN_NAMES), auths: parseList(process.env.ADMIN_AUTHS), everyone: process.env.ADMIN_EVERYONE === '1' });
  room.onRoomLink = (url) => console.log(`Room link: ${url}`);
}
