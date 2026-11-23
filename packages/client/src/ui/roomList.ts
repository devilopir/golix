import { countryGeo, flagEmoji } from './countries.ts';
import type { LobbyInfo } from '@golix/shared';
import type { Geo, SettingsStore } from '../settings/settings.ts';
import { button, cancelButton, h, labeled, openDialog } from './dom.ts';

export interface RoomListEntry {
  id: string;
  name: string;
  players: number;
  maxPlayers: number;
  hasPassword: boolean;
  captcha: boolean;
  actionKeys: boolean;
  /** Lowercase ISO 3166-1 alpha-2 code. */
  country: string;
  lat: number;
  lon: number;
}

export interface RoomListSource {
  list(): Promise<RoomListEntry[]>;
  lobby(): Promise<LobbyInfo>;
}

export interface RoomListFilters {
  locked: boolean;
  full: boolean;
  empty: boolean;
}

export interface RoomListActions {
  join(entry: RoomListEntry, password: string): void;
  create(): void;
  replays(): void;
  settings(): void;
  changeNick(): void;
}

const EARTH_RADIUS_KM = 6371;
const LOADING_TEXT = 'Loading rooms...';
const UNREACHABLE_TEXT = 'Could not reach the server. Check your connection and press Refresh.';

export function distanceKm(from: Geo | null, entry: RoomListEntry): number {
  if (from === null) return 0;
  const rad = Math.PI / 180;
  const dLat = (entry.lat - from.lat) * rad;
  const dLon = (entry.lon - from.lon) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(from.lat * rad) * Math.cos(entry.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

export function visibleRooms(rooms: readonly RoomListEntry[], filters: RoomListFilters, geo: Geo | null): RoomListEntry[] {
  return rooms
    .filter((r) => (filters.locked || !r.hasPassword) && (filters.full || r.players < r.maxPlayers) && (filters.empty || r.players > 0))
    .sort((a, b) => distanceKm(geo, a) - distanceKm(geo, b));
}

export class RoomListScreen {
  readonly el: HTMLElement;
  private rooms: RoomListEntry[] = [];
  private selected: RoomListEntry | null = null;
  private readonly filters: RoomListFilters = { locked: true, full: true, empty: true };
  private readonly body = h('tbody');
  private readonly count = h('span', { className: 'dk-room-count' });
  private readonly joinButton: HTMLButtonElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly noticeText = h('span');
  private readonly notice = h('div', { className: 'dk-room-notice', hidden: true }, this.noticeText);
  private readonly status = h('p', { className: 'dk-room-status', hidden: true });
  private dismissedNotice = '';

  constructor(
    private readonly host: HTMLElement,
    private readonly source: RoomListSource,
    private readonly settings: SettingsStore,
    private readonly actions: RoomListActions,
  ) {
    this.joinButton = button('Join Room', () => this.selected !== null && this.join(this.selected));
    this.refreshButton = button('Refresh', () => void this.refresh());
    const closeNotice = button('×', () => {
      this.dismissedNotice = this.noticeText.textContent;
      this.notice.hidden = true;
    }, 'dk-btn dk-room-notice-close');
    closeNotice.setAttribute('aria-label', 'Close notice');
    this.notice.append(closeNotice);
    const filter = (label: string, key: keyof RoomListFilters) => {
      const el = button(label, () => {
        this.filters[key] = !this.filters[key];
        el.classList.toggle('on', this.filters[key]);
        this.render();
      }, 'dk-btn dk-toggle on');
      return el;
    };
    this.el = h(
      'div',
      { className: 'dk-screen dk-room-list' },
      h('header', { className: 'dk-room-list-header' }, h('h1', { textContent: 'Room list' }), this.count),
      h('p', { className: 'dk-tip', textContent: 'Tip: Join rooms near you to reduce lag.' }),
      this.notice,
      this.status,
      h(
        'div',
        { className: 'dk-room-list-body' },
        h(
          'div',
          { className: 'dk-table-wrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ...['Name', 'Players', 'Pass', 'Distance'].map((t) => h('th', { textContent: t })))),
            this.body,
          ),
        ),
        h(
          'div',
          { className: 'dk-room-list-actions' },
          this.refreshButton,
          this.joinButton,
          button('Create Room', () => actions.create()),
          h('div', { className: 'dk-spacer' }),
          button('Replays', () => actions.replays()),
          button('Settings', () => actions.settings()),
          button('Change Nick', () => actions.changeNick()),
        ),
      ),
      h('footer', { className: 'dk-row dk-filters' }, filter('Show locked', 'locked'), filter('Show full', 'full'), filter('Show empty', 'empty')),
    );
    this.render();
  }

  /** Keeps the last list when the server can't be reached and says so. */
  async refresh(): Promise<void> {
    this.refreshButton.disabled = true;
    this.showStatus(LOADING_TEXT, false);
    try {
      const [rooms, lobby] = await Promise.all([this.source.list(), this.source.lobby()]);
      this.rooms = rooms;
      this.selected = null;
      this.showNotice(lobby.notice);
      if (this.settings.get('geo') === null) this.settings.set('geo', countryGeo(lobby.country));
      this.status.hidden = true;
    } catch {
      this.showStatus(UNREACHABLE_TEXT, true);
    } finally {
      this.refreshButton.disabled = false;
    }
    this.render();
  }

  private showStatus(text: string, error: boolean): void {
    this.status.textContent = text;
    this.status.classList.toggle('error', error);
    this.status.setAttribute('role', error ? 'alert' : 'status');
    this.status.hidden = false;
  }

  private showNotice(text: string): void {
    this.noticeText.textContent = text;
    this.notice.hidden = text === '' || text === this.dismissedNotice;
  }

  /** Asks for the password first when the room has one. */
  join(entry: RoomListEntry): void {
    if (!entry.hasPassword) return this.actions.join(entry, '');
    const password = h('input', { type: 'password' });
    const submit = () => {
      dialog.close();
      this.actions.join(entry, password.value);
    };
    password.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
    };
    const dialog = openDialog(this.host, 'Room password', [labeled('Password:', password)], [cancelButton('Cancel', () => dialog.close()), button('Ok', submit)]);
    password.focus();
  }

  private render(): void {
    const geo = this.settings.get('geo');
    const rooms = visibleRooms(this.rooms, this.filters, geo);
    if (this.selected !== null && !rooms.includes(this.selected)) this.selected = null;
    const players = this.rooms.reduce((sum, r) => sum + r.players, 0);
    this.count.textContent = `${players} players in ${this.rooms.length} rooms`;
    this.body.replaceChildren(
      ...rooms.map((room) =>
        h(
          'tr',
          {
            className: room === this.selected ? 'selected' : '',
            onclick: () => {
              this.selected = room;
              this.render();
            },
            ondblclick: () => this.join(room),
          },
          h(
            'td',
            {},
            h('span', { className: 'tag' }),
            room.captcha && h('span', { className: 'dk-room-badge', textContent: 'Captcha', title: 'Joining asks you to solve a captcha' }),
            room.actionKeys && h('span', { className: 'dk-room-badge', textContent: 'Action keys', title: 'The room uses action keys 1 to 6' }),
            room.name,
          ),
          h('td', { textContent: `${room.players}/${room.maxPlayers}` }),
          h('td', { textContent: room.hasPassword ? 'Yes' : 'No' }),
          h('td', {}, h('span', { className: 'dk-flag', textContent: flagEmoji(room.country) }), `${Math.round(distanceKm(geo, room))}km`),
        ),
      ),
    );
    this.joinButton.disabled = this.selected === null;
  }
}
