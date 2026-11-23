import type { RoomPlayer } from '@golix/shared';
import type { RoomSession } from '../session.ts';
import { button, cancelButton, closeOnEscape, h, labeled, openDialog, toggleButton } from './dom.ts';

const KICK_REASON_MAX_LENGTH = 100;

export function openKickDialog(host: HTMLElement, session: RoomSession, player: RoomPlayer): void {
  const reason = h('input', { type: 'text', maxLength: KICK_REASON_MAX_LENGTH });
  let ban = false;
  const banToggle = toggleButton((on) => (on ? 'Yes' : 'No'), ban, (on) => {
    ban = on;
  });
  const dialog = openDialog(
    host,
    `Kick ${player.name}`,
    [labeled('Reason:', reason), labeled('Ban from rejoining:', banToggle)],
    [
      cancelButton('Cancel', () => dialog.close()),
      button('Kick', () => {
        dialog.close();
        session.send({
          type: 'request',
          event: { type: 'playerLeave', playerId: player.id, kicked: true, ban, reason: reason.value, byPlayer: session.playerId },
        });
      }),
    ],
  );
  reason.focus();
}

/** Admin-only popup for another player's row. */
export function openPlayerMenu(host: HTMLElement, session: RoomSession, player: RoomPlayer): void {
  const close = () => overlay.remove();
  const action = (label: string, run: () => void) =>
    button(label, () => {
      close();
      run();
    });
  const menu = h(
    'div',
    { className: 'dk-player-menu' },
    h('h3', { textContent: player.name }),
    action(player.admin ? 'Remove Admin' : 'Give Admin', () =>
      session.send({ type: 'request', event: { type: 'setAdmin', playerId: player.id, admin: !player.admin, byPlayer: session.playerId } }),
    ),
    action('Kick', () => openKickDialog(host, session, player)),
    button('Close', close),
  );
  const overlay = h('div', { className: 'dk-overlay dk-menu-overlay', onclick: (e) => e.target === overlay && close() }, menu);
  host.append(overlay);
  closeOnEscape(overlay, close);
}
