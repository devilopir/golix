import { defaultStadiums, parseStadium, Team, type ClientMessage, type GameState, type Input, type RoomEvent, type RoomPlayer, type RoomState, type TickOutcome } from '@golix/shared';
import type { RoomSession } from '../../src/session.ts';
import { defaultTheme } from '../../src/theme/index.ts';

export function player(id: number, name: string, overrides: Partial<RoomPlayer> = {}): RoomPlayer {
  return { id, name, team: Team.spectators, admin: false, avatar: '', country: 'tr', joinSeq: id, ping: 30, ...overrides };
}

export function room(players: RoomPlayer[], overrides: Partial<RoomState> = {}): RoomState {
  return {
    name: 'Test room',
    maxPlayers: 12,
    hasPassword: false,
    players,
    teamsLock: false,
    scoreLimit: 3,
    timeLimit: 3,
    redColors: defaultTheme.teams.red,
    blueColors: defaultTheme.teams.blue,
    redName: '',
    blueName: '',
    stadiumSource: defaultStadiums[0].source,
    kickRateLimit: { min: 2, rate: 0, burst: 0 },
    actionKeys: false,
    hud: [],
    camera: { follow: null, zoom: 1 },
    game: null,
    ...overrides,
  };
}

export function game(pauseCounter = 0): GameState {
  const stadium = parseStadium(defaultStadiums[0].source);
  return {
    tick: 10,
    phase: 'playing',
    phaseTicks: 0,
    pauseCounter,
    red: 0,
    blue: 0,
    time: 0,
    overtime: false,
    kickoffTeam: Team.red,
    scoringTeam: null,
    winner: null,
    scoreLimit: 3,
    timeLimit: 3,
    stadium,
    discs: stadium.discs,
    players: [],
    joints: [],
  };
}

export class FakeSession implements RoomSession {
  readonly sent: ClientMessage[] = [];
  readonly inputs: Input[] = [];
  left = false;
  private readonly listeners = new Set<(ev: RoomEvent) => void>();
  private readonly tickListeners = new Set<(tick: number, outcomes: readonly TickOutcome[]) => void>();
  private readonly resyncListeners = new Set<() => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private tickCount = 0;

  constructor(
    public state: RoomState,
    readonly playerId = 1,
  ) {}

  getRoom(): RoomState {
    return this.state;
  }

  send(msg: ClientMessage): void {
    this.sent.push(msg);
  }

  sendInput(input: Input): void {
    this.inputs.push(input);
  }

  onTick(cb: (tick: number, outcomes: readonly TickOutcome[]) => void): () => void {
    this.tickListeners.add(cb);
    return () => this.tickListeners.delete(cb);
  }

  tick(outcomes: TickOutcome[]): void {
    this.tickCount++;
    for (const cb of this.tickListeners) cb(this.tickCount, outcomes);
  }

  onEvent(cb: (ev: RoomEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onResync(cb: () => void): () => void {
    this.resyncListeners.add(cb);
    return () => this.resyncListeners.delete(cb);
  }

  resync(state: RoomState): void {
    this.state = state;
    for (const cb of this.resyncListeners) cb();
  }

  onClose(cb: (reason: string) => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  close(reason: string): void {
    for (const cb of this.closeListeners) cb(reason);
  }

  leave(): void {
    this.left = true;
    this.close('left');
  }

  /** Like a real session, a tick of events ends with the tick itself. */
  emit(...events: RoomEvent[]): void {
    for (const ev of events) for (const cb of this.listeners) cb(ev);
    this.tick([]);
  }

  requests(): RoomEvent[] {
    return this.sent.flatMap((m) => (m.type === 'request' ? [m.event] : []));
  }
}

export function click(root: ParentNode, text: string): void {
  findButton(root, text).click();
}

export function findButton(root: ParentNode, text: string): HTMLButtonElement {
  const el = [...root.querySelectorAll('button')].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`No button "${text}"`);
  return el;
}
