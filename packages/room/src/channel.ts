import { MAX_MESSAGE_BYTES, type IceCandidate, type IceServer } from '@golix/shared';
import { toBase64url } from './room.ts';

export interface PeerConnectionOptions {
  /** Defaults to the global RTCPeerConnection; Node passes a polyfill. */
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

/** Chromium accepts at most 256 KiB per data channel message; a room snapshot with a big stadium is larger. */
const CHUNK = 64 * 1024;
const MORE = 1;
const LAST = 0;

/** Peer connections use the ICE servers the lobby hands out with each negotiation. */
export function peerConnectionFactory(options: PeerConnectionOptions): (iceServers: IceServer[]) => RTCPeerConnection {
  const create = options.createPeerConnection ?? ((config) => new RTCPeerConnection(config));
  return (iceServers) => create({ iceServers });
}

/** 16 random bytes as base64url. */
export function randomToken(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function iceCandidate(c: RTCIceCandidate): IceCandidate {
  return { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };
}

/** Splits messages into chunks that each start with MORE or LAST. */
export function sendChunked(channel: RTCDataChannel, data: Uint8Array<ArrayBuffer>): void {
  if (channel.readyState !== 'open') return;
  for (let at = 0; ; at += CHUNK - 1) {
    const end = Math.min(at + CHUNK - 1, data.length);
    const chunk = new Uint8Array(end - at + 1);
    chunk[0] = end === data.length ? LAST : MORE;
    chunk.set(data.subarray(at, end), 1);
    try {
      channel.send(chunk);
    } catch {
      // Closed between the readyState check and the send; its close handler drops the peer.
      return;
    }
    if (end === data.length) return;
  }
}

/** Reassembles what sendChunked split; a message over MAX_MESSAGE_BYTES is dropped rather than buffered. */
export function chunkReader(deliver: (data: Uint8Array) => void): (e: MessageEvent) => void {
  let parts: Uint8Array[] = [];
  let size = 0;
  return (e) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    const chunk = new Uint8Array(e.data);
    size += chunk.length - 1;
    if (size <= MAX_MESSAGE_BYTES) parts.push(chunk.subarray(1));
    if (chunk[0] === MORE) return;
    const complete = size <= MAX_MESSAGE_BYTES ? parts : null;
    const total = size;
    parts = [];
    size = 0;
    if (complete === null) return;
    const whole = new Uint8Array(total);
    let at = 0;
    for (const p of complete) {
      whole.set(p, at);
      at += p.length;
    }
    deliver(whole);
  };
}
