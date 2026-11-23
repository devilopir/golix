import { JoinError, NetSession, joinConnect, loadIdentity, parseRoomLink, signNonce } from '@golix/client';

export interface JoinRoomOptions {
  /** Room link (https://…/play?c=<id>) or bare room id. */
  room: string;
  /** ws:// or wss:// lobby address; defaults to the room link's origin. */
  lobby?: string;
  name: string;
  avatar?: string;
  /** Lowercase ISO 3166-1 alpha-2 code shown as the player's flag. */
  country?: string;
  password?: string;
  /** `key` from an earlier join, to come back with the same auth; a new identity otherwise. */
  key?: string;
}

export interface JoinedRoom {
  session: NetSession;
  /** The player's auth as the room sees it. */
  auth: string;
  /** Private key to store and pass back as `key` to keep this auth. */
  key: string;
}

/** Joins a room as a player from Node; rejects with a JoinError when the room refuses or cannot be reached. */
export async function joinRoom(options: JoinRoomOptions): Promise<JoinedRoom> {
  const link = URL.canParse(options.room) ? new URL(options.room) : null;
  const id = link === null ? options.room : parseRoomLink(link.search)?.id;
  if (id === undefined) throw new JoinError('invalid');
  const lobby = options.lobby ?? link?.origin.replace(/^http/, 'ws');
  if (lobby === undefined) throw new TypeError('lobby is required when room is not a link');

  let key = options.key ?? null;
  const identity = await loadIdentity({ getItem: () => key, setItem: (_name, value) => void (key = value) });
  const { RTCPeerConnection } = await import('node-datachannel/polyfill');
  const session = await NetSession.join({
    url: `${lobby}/room/${id}`,
    join: { name: options.name, avatar: options.avatar ?? '', country: options.country ?? '', password: options.password ?? '', auth: identity.authId },
    sign: (nonce) => signNonce(identity, nonce),
    // The polyfill implements RTCPeerConnection but its event classes have private fields the DOM types lack.
    connect: joinConnect({ createPeerConnection: (c) => new RTCPeerConnection(c) as unknown as globalThis.RTCPeerConnection }),
  });
  return { session, auth: identity.authId, key: key! };
}
