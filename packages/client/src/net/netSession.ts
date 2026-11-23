import {
  TICKS_PER_SECOND,
  applyEvent,
  cloneRoom,
  decodeServerMessage,
  encodeClientMessage,
  hashRoom,
  inputMask,
  stepRoom,
  type ClientMessage,
  type Input,
  type RoomEvent,
  type RoomState,
  type ServerMessage,
  type TickOutcome,
} from '@golix/shared';
import type { RoomSession } from '../session.ts';
import { joinConnect, type ClientTransport, type Connect, type NetPath } from './transport.ts';

type JoinMessage = Extract<ClientMessage, { type: 'join' }>;
type RejectReason = Extract<ServerMessage, { type: 'joinRejected' }>['reason'];

export interface JoinOptions {
  /** ws://lobby/room/<id>; ignored by an in-process connect. */
  url: string;
  /** `verified` defaults to none. */
  join: Omit<JoinMessage, 'type' | 'signature' | 'verified'> & { verified?: string };
  /** Signs the server's challenge nonce with the key `join.auth` names; without it the server keeps no auth. */
  sign?: (nonce: string) => Promise<string>;
  extrapolation?: number;
  handicap?: number;
  connect?: Connect;
  /** Hears the lobby's proof that `join.auth` solved a captcha; pass it as `join.verified` next time to skip the captcha. */
  onVerified?: (value: string) => void;
}

export interface RenderStates {
  prev: RoomState;
  curr: RoomState;
  alpha: number;
}

export class JoinError extends Error {
  readonly reason: RejectReason | 'closed';

  constructor(reason: RejectReason | 'closed') {
    super(`join failed: ${reason}`);
    this.reason = reason;
  }
}

export const EXTRAPOLATION_MIN = -200;
export const EXTRAPOLATION_MAX = 1000;

const TICKS_PER_MS = TICKS_PER_SECOND / 1000;
const MAX_PREDICTION = 120;
/** Ticks per received tick that the clock estimate may sink, so a slower server clock is followed. */
const OFFSET_DECAY = 0.01;
const RESYNC_RETRY_MS = 1000;
/** The server sends every tick, so this much silence means the connection is gone, unless the transport is still resuming. */
const SERVER_SILENCE_MS = 10_000;
const RESUMING_CHECK_MS = 1000;
/** After the lobby says the host dropped, this much silence from it ends the session; a live host sends every tick. */
const HOST_AWAY_SILENCE_MS = 1000;
/** How long the lobby waits for a dropped host to register again; after it, it reports hostLost itself. */
const HOST_AWAY_FOR_MS = 16_000;
const MAX_INPUT_DELAYS = 500;

/**
 * Keeps the server-confirmed room and a prediction on top of it: own input changes apply at once,
 * remote players keep their last confirmed input, and every confirmed tick rolls the prediction back.
 */
export class NetSession implements RoomSession {
  readonly playerId: number;
  readonly sync = { checked: 0, desyncs: 0 };
  readonly path: NetPath;
  private readonly transport: ClientTransport;
  private confirmed: RoomState;
  private confirmedTick: number;
  private extrapolation = 0;
  private handicap = 0;
  private readonly listeners = new Set<(ev: RoomEvent) => void>();
  private readonly tickListeners = new Set<(tick: number, outcomes: readonly TickOutcome[]) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly resyncListeners = new Set<() => void>();
  /** Null until the room or this client names a reason; then a transport's own reason is ignored. */
  private disconnectReason: string | null = null;
  private open = true;
  private pending: { tick: number; input: Input; sentAt: number }[] = [];
  /** Milliseconds from sending each recent input to the room confirming it, oldest first. */
  readonly inputDelays: number[] = [];
  private lastInput: Input = 0;
  private head: RoomState | null = null;
  private prevHead: RoomState | null = null;
  private headTick = 0;
  /** Server tick minus local time in ticks, taken from the least delayed tick message. */
  private offset: number;
  private lastTarget = -Infinity;
  private awaitingSnapshot = false;
  private lastResyncAt = -Infinity;
  private outbox: { at: number; data: Uint8Array<ArrayBuffer> }[] = [];
  private outboxTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHeard: number;
  private awaySince = -Infinity;
  private watchdog: ReturnType<typeof setTimeout>;

  private constructor(transport: ClientTransport, welcome: Extract<ServerMessage, { type: 'welcome' }>, opts: JoinOptions) {
    this.transport = transport;
    this.path = transport.path;
    this.playerId = welcome.playerId;
    this.confirmed = welcome.room;
    this.confirmedTick = welcome.tick;
    this.offset = welcome.tick - performance.now() * TICKS_PER_MS;
    this.setExtrapolation(opts.extrapolation ?? 0);
    this.setHandicap(opts.handicap ?? 0);
    this.lastHeard = performance.now();
    this.watchdog = setTimeout(this.checkSilence, SERVER_SILENCE_MS);
  }

  /** Resolves on welcome; rejects with a JoinError when refused or closed first. */
  static join(opts: JoinOptions): Promise<NetSession> {
    return new Promise((resolve, reject) => {
      let session: NetSession | null = null;
      let rejected = false;
      const transport = (opts.connect ?? joinConnect())(opts.url, {
        message: (data) => {
          let msg: ServerMessage;
          try {
            msg = decodeServerMessage(data);
          } catch {
            transport.close();
            return;
          }
          if (session !== null) {
            session.handle(msg);
          } else if (msg.type === 'challenge') {
            const send = (signature: string) => transport.send(encodeClientMessage({ type: 'join', ...opts.join, verified: opts.join.verified ?? '', signature }));
            if (opts.sign === undefined) send('');
            else
              opts.sign(msg.nonce).then(send, (e: unknown) => {
                rejected = true;
                reject(e);
                transport.close();
              });
          } else if (msg.type === 'welcome') {
            session = new NetSession(transport, msg, opts);
            resolve(session);
          } else if (msg.type === 'joinRejected') {
            rejected = true;
            reject(new JoinError(msg.reason));
            transport.close();
          }
        },
        close: (reason) => {
          if (session !== null) session.closed(reason);
          else if (!rejected) reject(new JoinError('closed'));
        },
        hostAway: () => session?.hostAway(),
        verified: (value) => opts.onVerified?.(value),
      });
    });
  }

  getRoom(): RoomState {
    return this.confirmed;
  }

  send(msg: Exclude<ClientMessage, { type: 'input' }>): void {
    if (this.open) this.transmit(msg);
  }

  /** Predicted locally and only sent when it changes. */
  sendInput(raw: Input): void {
    if (!this.open) return;
    const input = raw & inputMask(this.confirmed);
    if (input === this.lastInput) return;
    this.lastInput = input;
    const tick = Math.floor(Math.max(this.estimateTick(performance.now(), 0), this.confirmedTick)) + 1;
    this.pending.push({ tick, input, sentAt: performance.now() });
    if (this.head !== null && this.headTick >= tick) this.head = null;
    this.transmit({ type: 'input', tick, input });
  }

  onEvent(cb: (ev: RoomEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onTick(cb: (tick: number, outcomes: readonly TickOutcome[]) => void): () => void {
    this.tickListeners.add(cb);
    return () => this.tickListeners.delete(cb);
  }

  onClose(cb: (reason: string) => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  onResync(cb: () => void): () => void {
    this.resyncListeners.add(cb);
    return () => this.resyncListeners.delete(cb);
  }

  leave(): void {
    if (!this.open) return;
    this.disconnectReason = 'left';
    this.transport.close();
  }

  setExtrapolation(ms: number): void {
    if (!(ms >= EXTRAPOLATION_MIN && ms <= EXTRAPOLATION_MAX)) throw new RangeError(`extrapolation must be between ${EXTRAPOLATION_MIN} and ${EXTRAPOLATION_MAX} ms`);
    this.extrapolation = ms;
    this.lastTarget = -Infinity;
    this.head = null;
  }

  setHandicap(ms: number): void {
    if (!(ms >= 0 && Number.isFinite(ms))) throw new RangeError('handicap must be a non-negative number of ms');
    this.handicap = ms;
  }

  /** Predicted ticks around nowMs; `prev` and `curr` are fresh objects the session never mutates again. */
  getRenderStates(nowMs: number): RenderStates {
    const target = this.targetTick(nowMs);
    const n = Math.floor(target);
    if (this.head === null || this.headTick > n + 1) {
      this.head = cloneRoom(this.confirmed);
      this.headTick = this.confirmedTick;
    }
    while (this.headTick <= n) {
      const next = cloneRoom(this.head);
      this.stepPredicted(next, this.headTick + 1);
      this.prevHead = this.head;
      this.head = next;
      this.headTick++;
    }
    return { prev: this.prevHead as RoomState, curr: this.head, alpha: target - n };
  }

  /** Tick the server is expected to reach `extraMs` from now, counting half the ping for travel. */
  private estimateTick(nowMs: number, extraMs: number): number {
    const ping = this.confirmed.players.find((p) => p.id === this.playerId)?.ping ?? 0;
    return this.offset + (nowMs + ping / 2 + extraMs) * TICKS_PER_MS;
  }

  /** Inputs are scheduled without extrapolation, so it only moves what is drawn relative to where inputs land. */
  private targetTick(nowMs: number): number {
    const estimate = this.estimateTick(nowMs, this.extrapolation);
    const target = Math.min(Math.max(estimate, this.lastTarget, this.confirmedTick), this.confirmedTick + MAX_PREDICTION);
    this.lastTarget = target;
    return target;
  }

  private stepPredicted(room: RoomState, tick: number): void {
    const first = this.confirmedTick + 1;
    for (const p of this.pending) {
      if (Math.max(p.tick, first) === tick) applyEvent(room, { type: 'input', playerId: this.playerId, input: p.input });
    }
    stepRoom(room);
  }

  private handle(msg: ServerMessage): void {
    this.lastHeard = performance.now();
    switch (msg.type) {
      case 'events': {
        this.offset = Math.max(msg.tick - performance.now() * TICKS_PER_MS, this.offset - OFFSET_DECAY);
        if (msg.tick !== this.confirmedTick + 1) {
          this.requestResync();
          break;
        }
        const outcomes: TickOutcome[] = [];
        for (const ev of msg.events) {
          outcomes.push(...applyEvent(this.confirmed, ev));
          if (ev.type === 'input' && ev.playerId === this.playerId) this.confirmInput();
        }
        outcomes.push(...stepRoom(this.confirmed));
        this.confirmedTick = msg.tick;
        this.head = null;
        for (const ev of msg.events) for (const cb of this.listeners) cb(ev);
        for (const cb of this.tickListeners) cb(msg.tick, outcomes);
        break;
      }
      case 'hash':
        if (msg.tick !== this.confirmedTick) break;
        this.sync.checked++;
        if (hashRoom(this.confirmed) === msg.hash) break;
        if (!this.awaitingSnapshot) this.sync.desyncs++;
        this.requestResync();
        break;
      case 'snapshot':
        this.confirmed = msg.room;
        this.confirmedTick = msg.tick;
        this.awaitingSnapshot = false;
        this.head = null;
        for (const cb of this.resyncListeners) cb();
        break;
      case 'ping':
        this.transmit({ type: 'pong', t: msg.t });
        break;
      case 'disconnected':
        this.disconnectReason = msg.reason;
        break;
      case 'challenge':
      case 'welcome':
      case 'joinRejected':
        break;
    }
  }

  private confirmInput(): void {
    const sent = this.pending.shift();
    if (sent === undefined) return;
    this.inputDelays.push(performance.now() - sent.sentAt);
    if (this.inputDelays.length > MAX_INPUT_DELAYS) this.inputDelays.shift();
  }

  private requestResync(): void {
    const now = performance.now();
    if (this.awaitingSnapshot && now - this.lastResyncAt < RESYNC_RETRY_MS) return;
    this.awaitingSnapshot = true;
    this.lastResyncAt = now;
    this.transmit({ type: 'resync' });
  }

  private hostAway(): void {
    this.awaySince = performance.now();
    clearTimeout(this.watchdog);
    this.checkSilence();
  }

  private readonly checkSilence = (): void => {
    const now = performance.now();
    const silent = now - this.lastHeard;
    const away = now - this.awaySince < HOST_AWAY_FOR_MS;
    const limit = away ? HOST_AWAY_SILENCE_MS : SERVER_SILENCE_MS;
    if (silent < limit) {
      this.watchdog = setTimeout(this.checkSilence, away ? Math.min(limit - silent, this.awaySince + HOST_AWAY_FOR_MS - now) : limit - silent);
      return;
    }
    if (away) {
      this.disconnectReason = 'host';
      this.transport.close();
      this.closed();
      return;
    }
    if (this.transport.resuming) {
      this.watchdog = setTimeout(this.checkSilence, RESUMING_CHECK_MS);
      return;
    }
    this.disconnectReason = 'timeout';
    this.transport.close();
    this.closed();
  };

  private closed(reason = 'closed'): void {
    if (!this.open) return;
    this.open = false;
    clearTimeout(this.watchdog);
    if (this.outboxTimer !== null) clearTimeout(this.outboxTimer);
    this.outbox = [];
    for (const cb of this.closeListeners) cb(this.disconnectReason ?? reason);
  }

  private transmit(msg: ClientMessage): void {
    const data = encodeClientMessage(msg);
    if (this.handicap === 0 && this.outbox.length === 0) {
      this.transport.send(data);
      return;
    }
    this.outbox.push({ at: performance.now() + this.handicap, data });
    if (this.outboxTimer === null) this.flushOutbox();
  }

  private readonly flushOutbox = (): void => {
    this.outboxTimer = null;
    const now = performance.now();
    while (this.outbox.length > 0 && this.outbox[0].at <= now) {
      this.transport.send(this.outbox[0].data);
      this.outbox.shift();
    }
    if (this.outbox.length > 0) this.outboxTimer = setTimeout(this.flushOutbox, this.outbox[0].at - now);
  };
}
