export { LIMITS, PROTOCOL_VERSION, joinVersion, decodeClientMessage, decodeServerMessage, encodeClientMessage, encodeServerMessage, readEvent, readRoom, writeEvent, writeRoom } from './codec.ts';
export { ProtocolError, Reader, Writer } from './wire.ts';

import { LIMITS } from './codec.ts';

/** Largest game message, in bytes: a room carrying a stadium at its length limit. */
export const MAX_MESSAGE_BYTES: number = 4 * LIMITS.stadium + 1024;

export const TICKS_PER_SECOND = 60;
/** Ticks between server state hashes. */
export const HASH_INTERVAL = 60;

/** A reliable, ordered binary channel; an unreliable one (WebRTC) would implement the same shape. */
export interface Transport {
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
}
export { HOST_AWAY_CLOSE, verifiedMessage } from './lobby.ts';
export type { CreateRoomRequest, HostMessage, IceCandidate, IceServer, JoinerMessage, ListedState, LobbyInfo, RoomListing, RoomLocation, ServerToHost, ServerToJoiner } from './lobby.ts';
