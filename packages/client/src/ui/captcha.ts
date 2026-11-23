import { cancelButton, h, openDialog } from './dom.ts';

// Cloudflare asks that api.js be loaded from this exact address, never proxied or cached.
const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface Turnstile {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | null = null;

function loadTurnstile(): Promise<Turnstile> {
  loading ??= new Promise((resolve, reject) => {
    const script = h('script', { src: TURNSTILE_SCRIPT, async: true });
    script.onload = () => (window.turnstile === undefined ? reject(new Error('Turnstile did not load')) : resolve(window.turnstile));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error('Turnstile did not load'));
    };
    document.head.append(script);
  });
  return loading;
}

/** Shows a Turnstile challenge; resolves with its token, or null when the player cancels, it fails or cannot load. */
export async function solveCaptcha(host: HTMLElement, siteKey: string, reason = 'This room asks new players to prove they are not a bot.'): Promise<string | null> {
  const turnstile = await loadTurnstile().catch(() => null);
  if (turnstile === null) return null;
  return new Promise((resolve) => {
    const box = h('div', { className: 'dk-captcha' });
    let widgetId: string | null = null;
    const finish = (token: string | null) => {
      if (widgetId !== null) turnstile.remove(widgetId);
      widgetId = null;
      dialog.close();
      resolve(token);
    };
    const dialog = openDialog(host, 'Captcha', [h('p', { textContent: reason }), box], [cancelButton('Cancel', () => finish(null))]);
    widgetId = turnstile.render(box, { sitekey: siteKey, theme: 'dark', callback: (token: string) => finish(token), 'error-callback': () => finish(null) });
  });
}
