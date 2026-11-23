import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { decodeServerMessage, encodeClientMessage, type ClientMessage, type RoomEvent, type ServerMessage } from '@golix/shared';
import type { PeerHandle, Room } from '../src/index.ts';

const keys = new Map<string, { authId: string; privateKey: KeyObject }>();

/** Same label, same key pair; the auth id is the raw public point like the client identity's. */
export function testKey(label: string): { authId: string; privateKey: KeyObject } {
  let key = keys.get(label);
  if (key === undefined) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { x, y } = publicKey.export({ format: 'jwk' });
    const authId = Buffer.concat([Buffer.from([4]), Buffer.from(x as string, 'base64url'), Buffer.from(y as string, 'base64url')]).toString('base64url');
    keys.set(label, (key = { authId, privateKey }));
  }
  return key;
}

export function signNonce(label: string, nonce: string): string {
  return sign('sha256', Buffer.from(nonce), { key: testKey(label).privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

/** The challenge is kept apart from `received`. */
export class FakePeer {
  readonly received: ServerMessage[] = [];
  nonce = '';
  closed = false;
  readonly handle: PeerHandle;

  constructor(room: Room, conn = '', captcha = false) {
    this.handle = room.addPeer({
      send: (data) => {
        const msg = decodeServerMessage(data);
        if (msg.type === 'challenge') this.nonce = msg.nonce;
        else this.received.push(msg);
      },
      close: () => {
        this.closed = true;
      },
    }, conn, captcha);
  }

  send(msg: ClientMessage): void {
    this.handle.receive(encodeClientMessage(msg));
  }

  request(event: RoomEvent): void {
    this.send({ type: 'request', event });
  }

  /** `key` labels the signing key (default: the name); `signature` overrides the real one. */
  join(name: string, opts: { password?: string; key?: string; signature?: string; verified?: string } = {}): void {
    const label = opts.key ?? name;
    const signature = opts.signature ?? signNonce(label, this.nonce);
    this.send({ type: 'join', name, avatar: '', country: 'tr', password: opts.password ?? '', auth: testKey(label).authId, signature, verified: opts.verified ?? '' });
  }

  get playerId(): number {
    const welcome = this.received.find((m) => m.type === 'welcome');
    if (welcome?.type !== 'welcome') throw new Error('not welcomed');
    return welcome.playerId;
  }

  /** Events this peer saw, flattened in order. */
  events(): RoomEvent[] {
    return this.received.flatMap((m) => (m.type === 'events' ? m.events : []));
  }

  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return [...this.received].reverse().find((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

/** Joins `names` in order, one tick each; the first is the admin. */
export function joinAll(room: Room, names: string[]): FakePeer[] {
  return names.map((name) => {
    const peer = new FakePeer(room);
    peer.join(name);
    room.runTick();
    return peer;
  });
}
