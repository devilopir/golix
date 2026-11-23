import { decodeServerMessage, encodeServerMessage, type ServerMessage } from '@golix/shared';
import type { PeerHandle, Room } from '@golix/room';
import { NetSession } from '../../src/net/netSession.ts';
import type { Connect, TransportHandlers } from '../../src/net/transport.ts';

/** In-process pipe between a Room and one client; nothing moves until flushed. */
export class Link {
  readonly up: Uint8Array[] = [];
  /** null marks the server closing the connection. */
  readonly down: (Uint8Array<ArrayBuffer> | null)[] = [];
  tamper: ((msg: ServerMessage) => ServerMessage) | null = null;
  private peer: PeerHandle | null = null;
  private handlers: TransportHandlers | null = null;
  private readonly room: Room;

  constructor(room: Room) {
    this.room = room;
  }

  readonly connect: Connect = (_url, handlers) => {
    this.handlers = handlers;
    this.peer = this.room.addPeer({ send: (d) => this.down.push(d), close: () => this.down.push(null) });
    return {
      path: 'host',
      resuming: false,
      send: (d) => this.up.push(d),
      close: () => {
        this.peer?.closed();
        handlers.close();
      },
    };
  };

  /** Stands in for the lobby reporting that the host's control socket dropped. */
  hostAway(): void {
    this.handlers?.hostAway?.();
  }

  flushUp(): void {
    for (const d of this.up.splice(0)) this.peer?.receive(d);
  }

  flushDown(): void {
    for (const d of this.down.splice(0)) {
      if (d === null) {
        this.handlers?.close();
        continue;
      }
      this.handlers?.message(this.tamper ? encodeServerMessage(this.tamper(decodeServerMessage(d))) : d);
    }
  }
}

export async function joinInProcess(room: Room, name: string, link = new Link(room)): Promise<{ session: NetSession; link: Link }> {
  const promise = NetSession.join({ url: 'local', join: { name, avatar: '', country: 'tr', password: '', auth: name }, connect: link.connect });
  link.flushDown();
  link.flushUp();
  room.runTick();
  link.flushDown();
  return { session: await promise, link };
}
