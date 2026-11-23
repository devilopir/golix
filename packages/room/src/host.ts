import type { CreateRoomRequest, HostMessage, IceServer, ListedState, ServerToHost } from '@golix/shared';
import { chunkReader, iceCandidate, peerConnectionFactory, randomToken, sendChunked, type PeerConnectionOptions } from './channel.ts';
import { fromBase64url, type PeerHandle, type Room } from './room.ts';

export interface LobbyHostOptions extends PeerConnectionOptions {
  /** ws:// or wss:// address of the lobby server. */
  serverUrl: string;
  request: CreateRoomRequest;
  /** Registration secret the room id is derived from; a fixed one keeps the id and link across restarts. */
  secret?: string;
  /** Room token from the lobby's /headlesstoken page, for a room id the lobby has not seen before. */
  token?: string;
  /** The control socket is down; the next registration attempt starts in `retryInMs`. */
  onLost?(retryInMs: number): void;
  /** Registered again after onLost. */
  onBack?(): void;
}

export interface LobbyHost {
  /** Stays the same across re-registrations. */
  readonly id: string;
  /** The lobby verifies captchas, so the room may ask joiners for one. */
  readonly captcha: boolean;
  /** Tells the lobby what the room list shows of the room if it changed since it last heard it. */
  update(): void;
  /** Takes the room off the lobby and disconnects everyone who joined through it. */
  close(): void;
}

interface RemotePeer {
  /** The lobby's id for this peer on the current control socket; null once that socket is gone. */
  lobbyId: number | null;
  pc: RTCPeerConnection | null;
  /** Set once the data channel opened or the peer is relayed. */
  handle: PeerHandle | null;
  /** Relayed peers only: presenting it again through a new control socket resumes the peer. */
  token: string | null;
  /** Serializes remote description and candidate calls. */
  signaling: Promise<unknown>;
  gone: boolean;
}

const PEER_HEADER = 4;
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/** How long a relayed peer may take to come back through a restarted lobby; below the room's peer timeout. */
const RESUME_MS = 20_000;

/**
 * Registers a running room with the lobby over one control socket and accepts joiners over WebRTC or the lobby relay.
 * Rejects when the first registration fails; after that a dropped socket registers again with backoff under the same id,
 * data channel peers stay in the room and relayed peers wait for their joiner to reconnect.
 */
export function hostOnLobby(room: Room, options: LobbyHostOptions): Promise<LobbyHost> {
  const createPeerConnection = peerConnectionFactory(options);
  const secret = options.secret ?? randomToken();
  const peers = new Set<RemotePeer>();
  let byLobbyId = new Map<number, RemotePeer>();
  const suspended = new Map<string, { peer: RemotePeer; timer: ReturnType<typeof setTimeout> }>();
  let ws: WebSocket | null = null;
  let closing = false;
  let captcha = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const current = (): ListedState => ({
    name: room.state.name,
    maxPlayers: room.state.maxPlayers,
    players: room.state.players.length,
    hasPassword: room.state.hasPassword,
    captcha: room.captchaRequired,
    actionKeys: room.state.actionKeys,
  });
  let listed = current();

  const signal = (msg: HostMessage) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const update = () => {
    const next = current();
    if (Object.entries(next).every(([key, value]) => listed[key as keyof ListedState] === value)) return;
    listed = next;
    signal({ type: 'update', ...listed });
  };

  const addPeer = (lobbyId: number, pc: RTCPeerConnection | null, token: string | null): RemotePeer => {
    const peer: RemotePeer = { lobbyId, pc, handle: null, token, signaling: Promise.resolve(), gone: false };
    peers.add(peer);
    byLobbyId.set(lobbyId, peer);
    return peer;
  };

  const drop = (peer: RemotePeer) => {
    if (peer.gone) return;
    peer.gone = true;
    peers.delete(peer);
    if (peer.lobbyId !== null && byLobbyId.get(peer.lobbyId) === peer) byLobbyId.delete(peer.lobbyId);
    const pending = peer.token === null ? undefined : suspended.get(peer.token);
    if (pending?.peer === peer) {
      clearTimeout(pending.timer);
      suspended.delete(peer.token!);
    }
    peer.pc?.close();
    peer.handle?.closed();
  };

  const offer = (lobbyId: number, conn: string, captcha: boolean, sdp: string, iceServers: IceServer[]) => {
    const pc = createPeerConnection(iceServers);
    const peer = addPeer(lobbyId, pc, null);
    pc.onicecandidate = (e) => {
      if (e.candidate !== null && e.candidate.candidate !== '' && peer.lobbyId !== null) signal({ type: 'candidate', peer: peer.lobbyId, candidate: iceCandidate(e.candidate) });
    };
    pc.ondatachannel = ({ channel }) => {
      channel.binaryType = 'arraybuffer';
      channel.onopen = () => {
        if (peer.gone) return channel.close();
        peer.handle = room.addPeer({ send: (data) => sendChunked(channel, data), close: () => channel.close() }, conn, captcha);
      };
      channel.onmessage = chunkReader((data) => peer.handle?.receive(data));
      channel.onclose = () => drop(peer);
    };
    peer.signaling = pc
      .setRemoteDescription({ type: 'offer', sdp })
      .then(() => pc.setLocalDescription())
      .then(() => {
        if (peer.lobbyId !== null) signal({ type: 'answer', peer: peer.lobbyId, sdp: pc.localDescription!.sdp });
      })
      .catch(() => drop(peer));
  };

  const relay = (lobbyId: number, conn: string, captcha: boolean, token: string) => {
    const prior = byLobbyId.get(lobbyId);
    if (prior !== undefined) drop(prior);
    const resumed = suspended.get(token);
    if (resumed !== undefined) {
      clearTimeout(resumed.timer);
      suspended.delete(token);
      resumed.peer.lobbyId = lobbyId;
      byLobbyId.set(lobbyId, resumed.peer);
      return;
    }
    const peer = addPeer(lobbyId, null, token);
    peer.handle = room.addPeer(
      {
        send: (data) => {
          if (peer.lobbyId === null || ws?.readyState !== WebSocket.OPEN) return;
          const frame = new Uint8Array(PEER_HEADER + data.length);
          new DataView(frame.buffer).setUint32(0, peer.lobbyId);
          frame.set(data, PEER_HEADER);
          ws.send(frame);
        },
        close: () => {
          if (peer.lobbyId !== null) signal({ type: 'close', peer: peer.lobbyId });
          drop(peer);
        },
      },
      conn,
      captcha,
    );
  };

  const onSignal = (msg: Exclude<ServerToHost, { type: 'registered' }>) => {
    switch (msg.type) {
      case 'offer':
        offer(msg.peer, msg.conn, msg.captcha, msg.sdp, msg.iceServers);
        break;
      case 'candidate': {
        const peer = byLobbyId.get(msg.peer);
        const pc = peer?.pc;
        if (peer !== undefined && pc != null) {
          // As for the joiner, one unusable candidate does not fail ICE.
          peer.signaling = peer.signaling.then(() => pc.addIceCandidate(msg.candidate)).catch(() => {});
        }
        break;
      }
      case 'relay':
        relay(msg.peer, msg.conn, msg.captcha, msg.token);
        break;
      case 'bans':
        room.setGlobalBans(new Set(msg.auths));
        break;
      case 'leave': {
        const peer = byLobbyId.get(msg.peer);
        if (peer !== undefined && (peer.token !== null || peer.handle === null)) drop(peer);
        break;
      }
    }
  };

  /** Peers still negotiating are lost with the socket; relayed peers get RESUME_MS to come back. */
  const socketLost = () => {
    for (const peer of byLobbyId.values()) {
      peer.lobbyId = null;
      if (peer.handle === null) drop(peer);
      else if (peer.token !== null) suspended.set(peer.token, { peer, timer: setTimeout(() => drop(peer), RESUME_MS) });
    }
    byLobbyId = new Map();
  };

  const register = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(`${options.serverUrl}/host`);
      socket.binaryType = 'arraybuffer';
      ws = socket;
      let registered = false;
      socket.onopen = () => {
        listed = { ...current(), players: 0 };
        signal({ type: 'register', ...options.request, name: listed.name, maxPlayers: listed.maxPlayers, hasPassword: listed.hasPassword, captcha: listed.captcha, actionKeys: listed.actionKeys, secret, token: options.token });
      };
      socket.onmessage = (e: MessageEvent) => {
        if (e.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(e.data);
          if (bytes.length >= PEER_HEADER) byLobbyId.get(new DataView(e.data).getUint32(0))?.handle?.receive(bytes.subarray(PEER_HEADER));
          return;
        }
        const msg = JSON.parse(e.data as string) as ServerToHost;
        if (msg.type !== 'registered') return onSignal(msg);
        registered = true;
        captcha = msg.captcha;
        room.setVerifyKey(msg.verifyKey === '' ? null : fromBase64url(msg.verifyKey));
        update();
        resolve(msg.id);
      };
      // Node 22's WebSocket fires only error, no close, when the connection is refused.
      socket.onerror = socket.onclose = (e: Event) => {
        if (ws !== socket) return;
        ws = null;
        socketLost();
        // The lobby names why it refused a registration, such as a missing room token.
        if (!registered) reject(new Error('reason' in e && typeof e.reason === 'string' && e.reason !== '' ? e.reason : 'Could not create the room.'));
        else if (!closing) reconnect(RECONNECT_MIN_MS);
      };
    });

  const reconnect = (delayMs: number) => {
    options.onLost?.(delayMs);
    retry = setTimeout(() => {
      register().then(() => options.onBack?.(), () => {
        // Relayed joiners only wait so long for the room to come back, so no backoff while any is waiting.
        if (!closing) reconnect(suspended.size > 0 ? RECONNECT_MIN_MS : Math.min(delayMs * 2, RECONNECT_MAX_MS));
      });
    }, delayMs);
  };

  return register().then((id) => ({
    id,
    get captcha() {
      return captcha;
    },
    update,
    close: () => {
      closing = true;
      clearTimeout(retry);
      for (const peer of [...peers]) drop(peer);
      ws?.close();
    },
  }));
}
