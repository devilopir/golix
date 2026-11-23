import { NICKNAME_MAX_LENGTH, type SettingsStore } from '../settings/settings.ts';
import { button, h, labeled, openDialog } from './dom.ts';

/** Only an empty nick is rejected; whitespace-only names pass, as in the original. */
export function isValidNickname(nick: string): boolean {
  return nick.length > 0 && nick.length <= NICKNAME_MAX_LENGTH;
}

export function openNicknameDialog(host: HTMLElement, settings: SettingsStore, onDone: () => void): void {
  const input = h('input', { type: 'text', maxLength: NICKNAME_MAX_LENGTH, value: settings.get('nickname') });
  const ok = button('Ok', () => {
    if (!isValidNickname(input.value)) return;
    settings.set('nickname', input.value);
    dialog.close();
    onDone();
  });
  const sync = () => {
    ok.disabled = !isValidNickname(input.value);
  };
  input.oninput = sync;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') ok.click();
  };
  const dialog = openDialog(host, 'Choose nickname', [labeled('Nick:', input)], [ok], 'dk-nickname');
  dialog.el.parentElement!.classList.add('dk-stack');
  dialog.el.before(h('img', { className: 'dk-logo', src: `${import.meta.env.BASE_URL}logo.png`, alt: 'Golix' }));
  sync();
  input.focus();
}
