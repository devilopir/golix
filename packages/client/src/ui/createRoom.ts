import { button, cancelButton, h, labeled, openDialog, select, toggleButton } from './dom.ts';

export interface CreateRoomOptions {
  name: string;
  password: string;
  maxPlayers: number;
  public: boolean;
}

export const ROOM_NAME_MAX_LENGTH = 40;
export const ROOM_PASSWORD_MAX_LENGTH = 30;
export const MAX_PLAYERS_MIN = 2;
export const MAX_PLAYERS_MAX = 20;
export const MAX_PLAYERS_DEFAULT = 12;

export function openCreateRoomDialog(host: HTMLElement, nickname: string, onCreate: (options: CreateRoomOptions) => void): void {
  const name = h('input', { type: 'text', maxLength: ROOM_NAME_MAX_LENGTH, value: `${nickname}'s room`.slice(0, ROOM_NAME_MAX_LENGTH) });
  const password = h('input', { type: 'text', maxLength: ROOM_PASSWORD_MAX_LENGTH });
  let maxPlayers = MAX_PLAYERS_DEFAULT;
  let isPublic = true;
  const counts = Array.from({ length: MAX_PLAYERS_MAX - MAX_PLAYERS_MIN + 1 }, (_, i) => ({ value: i + MAX_PLAYERS_MIN, label: String(i + MAX_PLAYERS_MIN) }));
  const dialog = openDialog(
    host,
    'Create room',
    [
      labeled('Room name:', name),
      labeled('Password:', password),
      labeled('Max players:', select(counts, maxPlayers, (v) => (maxPlayers = v))),
      toggleButton((on) => `Show in room list: ${on ? 'Yes' : 'No'}`, isPublic, (on) => (isPublic = on)),
    ],
    [
      cancelButton('Cancel', () => dialog.close()),
      button('Create', () => {
        dialog.close();
        onCreate({ name: name.value, password: password.value, maxPlayers, public: isPublic });
      }),
    ],
    'dk-create-room',
  );
  name.focus();
}
