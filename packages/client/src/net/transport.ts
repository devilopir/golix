import type { Room } from '@golix/room';
import { chunkReader, iceCandidate, peerConnectionFactory, randomToken, sendChunked, type PeerConnectionOptions } from '@golix/room/channel';
import { HOST_AWAY_CLOSE, type IceCandidate, type IceServer, type JoinerMessage, type ServerToJoiner, type Transport } from '@golix/shared';

export interface TransportHandlers {
  message(data: Uint8Array): void;
  /** `reason` is set when the transport knows why the room became unreachable: 'host' or 'lobby'. */
  close(reason?: string): void;
  /** The lobby saw the host drop; the host may be gone, so silence from it now means it is. */
  hostAway?(): void;
  /** The lobby's proof that this player's auth solved a captcha, for later joins. */
  verified?(value: string): void;
}

/** How game bytes reach the room: in-process on the host, a WebRTC data channel, or through the lobby server. */
export type NetPath = 'host' | 'p2p' | 'relay';

export interface ClientTransport extends Transport {
  /** Settled before the first message arrives. */
  readonly path: NetPath;
  /** True while the room is out of reach but the transport is still trying to get it back. */
  readonly resuming: boolean;
}

export type Connect = (url: string, handlers: TransportHandlers) => ClientTransport;

export interface JoinConnectOptions extends PeerConnectionOptions {
  /** How long ICE may take before the game bytes go through the server instead. */
  iceTimeoutMs?: number;
}

const ICE_TIMEOUT_MS = 5000;
/** How long the data channel may stay ICE-disconnected before the host counts as gone. */
const P2P_DISCONNECTED_MS = 2000;
/** How long a relayed joiner keeps trying to reach its room through a restarted lobby; below the host's wait for it. */
const RESUME_MS = 18_000;
const RESUME_RETRY_MS = 500;
/** A data channel joiner reopens its lobby socket, only there to hear hostLost, with this backoff. */
const WATCH_RETRY_MIN_MS = 1000;
const WATCH_RETRY_MAX_MS = 30_000;
const ABNORMAL_CLOSURE = 1006;

/** The host's own client inside the room it runs; deliveries are deferred so neither side re-enters the other. */
export function localConnect(room: Room): Connect {
  return (_url, handlers) => {
    let open = true;
    const end = () => {
      if (!open) return;
      open = false;
      handlers.close();
    };
    const peer = room.addPeer({
      send: (data) => queueMicrotask(() => open && handlers.message(data)),
      close: () => queueMicrotask(end),
    });
    return {
      path: 'host',
      resuming: false,
      send: (data) => queueMicrotask(() => open && peer.receive(data)),
      close: () => {
        peer.closed();
        end();
      },
    };
  };
}

/**
 * Connects to ws://lobby/room/<id>, negotiates a WebRTC data channel with the host through it and, when ICE does
 * not succeed in time, sends the game bytes through that socket instead. Messages sent before either is ready are queued.
 * On a data channel the socket stays open so the lobby can say when the host is gone, and is reopened after a lobby
 * restart; a relayed joiner whose socket drops reconnects and resumes its relay with the same token once the host has
 * registered again.
 */
export function joinConnect(options: JoinConnectOptions = {}): Connect {
  const createPeerConnection = peerConnectionFactory(options);
  const iceTimeoutMs = options.iceTimeoutMs ?? ICE_TIMEOUT_MS;
  return (url, handlers) => {
    const token = randomToken();
    let ws: WebSocket;
    let path: NetPath | null = null;
    let queued: Uint8Array<ArrayBuffer>[] = [];
    let pc: RTCPeerConnection | null = null;
    let channel: RTCDataChannel | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Nonzero while a relayed joiner is reconnecting: the time it gives up. */
    let resumeBy = 0;
    let watchRetryMs = WATCH_RETRY_MIN_MS;
    let watchTimer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;

    const end = (reason?: string) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(watchTimer);
      ws.close();
      channel?.close();
      pc?.close();
      handlers.close(reason);
    };
    const signal = (msg: JoinerMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const flush = () => {
      for (const data of queued) ws.send(data);
      queued = [];
    };
    const relay = (ask: boolean) => {
      if (path !== null || ended) return;
      clearTimeout(timer);
      pc?.close();
      pc = channel = null;
      if (ask) signal({ type: 'relay', token });
      path = 'relay';
      flush();
    };
    const negotiate = async (iceServers: IceServer[]) => {
      const conn = (pc = createPeerConnection(iceServers));
      const dc = (channel = conn.createDataChannel('game'));
      dc.binaryType = 'arraybuffer';
      const early: IceCandidate[] = [];
      let offered = false;
      conn.onicecandidate = (e) => {
        if (e.candidate === null || e.candidate.candidate === '') return;
        if (offered) signal({ type: 'candidate', candidate: iceCandidate(e.candidate) });
        else early.push(iceCandidate(e.candidate));
      };
      conn.onconnectionstatechange = () => {
        const state = conn.connectionState;
        if (path === null && state === 'failed') relay(true);
        if (path !== 'p2p') return;
        clearTimeout(timer);
        if (state === 'failed') end('host');
        else if (state === 'disconnected') timer = setTimeout(() => end('host'), P2P_DISCONNECTED_MS);
      };
      dc.onopen = () => {
        if (path !== null) return;
        clearTimeout(timer);
        path = 'p2p';
        for (const data of queued) sendChunked(dc, data);
        queued = [];
      };
      dc.onmessage = chunkReader(handlers.message);
      dc.onclose = () => {
        if (path === 'p2p') end('host');
      };
      timer = setTimeout(() => relay(true), iceTimeoutMs);
      await conn.setLocalDescription();
      signal({ type: 'offer', sdp: conn.localDescription!.sdp });
      offered = true;
      for (const candidate of early) signal({ type: 'candidate', candidate });
    };

    const onSignal = (msg: ServerToJoiner) => {
      switch (msg.type) {
        case 'webrtc':
          if (path === 'p2p') watchRetryMs = WATCH_RETRY_MIN_MS;
          else if (path === 'relay') {
            resumeBy = 0;
            signal({ type: 'relay', token });
            flush();
          } else negotiate(msg.iceServers).catch(() => relay(true));
          break;
        case 'relay':
          // A room running on the lobby itself did not survive the restart.
          if (path === 'relay') end('lobby');
          else relay(false);
          break;
        case 'answer':
          pc?.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => relay(true));
          break;
        case 'candidate':
          // One unusable candidate (an unresolvable mDNS name, say) does not fail ICE; the timeout covers the rest.
          pc?.addIceCandidate(msg.candidate).catch(() => {});
          break;
        case 'hostLost':
          end('host');
          break;
        case 'hostAway':
          handlers.hostAway?.();
          break;
        case 'verified':
          handlers.verified?.(msg.value);
          break;
      }
    };

    const open = () => {
      const socket = (ws = new WebSocket(url));
      socket.binaryType = 'arraybuffer';
      socket.onmessage = (e: MessageEvent) => {
        if (e.data instanceof ArrayBuffer) handlers.message(new Uint8Array(e.data));
        else onSignal(JSON.parse(e.data as string) as ServerToJoiner);
      };
      let lost = false;
      // Node 22's WebSocket fires only error, no close, when the connection is refused.
      socket.onerror = socket.onclose = (e: Event) => {
        if (lost || ended || ws !== socket) return;
        lost = true;
        if (path === 'p2p') {
          watchTimer = setTimeout(open, watchRetryMs);
          watchRetryMs = Math.min(watchRetryMs * 2, WATCH_RETRY_MAX_MS);
          return;
        }
        // A clean close of a working relay means the host ended it; while reconnecting it means the room is not back yet.
        const dropped = !('code' in e) || e.code === ABNORMAL_CLOSURE || e.code === HOST_AWAY_CLOSE;
        if (path !== 'relay' || (!dropped && resumeBy === 0)) return end();
        if (resumeBy === 0) resumeBy = performance.now() + RESUME_MS;
        if (performance.now() >= resumeBy) return end('lobby');
        timer = setTimeout(open, RESUME_RETRY_MS);
      };
    };
    open();

    return {
      get path() {
        return path ?? 'relay';
      },
      get resuming() {
        return resumeBy !== 0;
      },
      send: (data) => {
        if (path === 'p2p') sendChunked(channel!, data);
        else if (path === 'relay' && resumeBy === 0 && ws.readyState === WebSocket.OPEN) ws.send(data);
        else queued.push(data);
      },
      close: () => end(),
    };
  };
}
