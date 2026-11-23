import { REPLAY_EXTENSION } from '@golix/replay';
import type { ReplayStore, SavedReplayInfo } from '../net/replayStore.ts';
import { formatClock } from '../render/hud.ts';
import { button, cancelButton, h, openDialog } from './dom.ts';
import { replayFileName } from '../net/recording.ts';

export interface ReplaysDialogDeps {
  /** Null where the browser keeps no replays. */
  store: ReplayStore | null;
  open(load: () => Promise<ArrayBuffer>): void;
  download(filename: string, data: Uint8Array<ArrayBuffer>): void;
}

const EMPTY_TEXT = 'Matches you play are saved here, up to the last 50.';
const UNAVAILABLE_TEXT = 'This browser does not keep replays; open one from a file.';

function missing(): never {
  throw new Error('The replay is no longer saved.');
}

/** Lists the matches saved in this browser to watch or download, and opens replay files. */
export function openReplaysDialog(host: HTMLElement, deps: ReplaysDialogDeps): void {
  const { store } = deps;
  const list = h('ul', { className: 'dk-list dk-saved-replays' });
  const status = h('p', { className: 'dk-tip', textContent: store === null ? UNAVAILABLE_TEXT : 'Loading...' });
  const file = h('input', { type: 'file', accept: REPLAY_EXTENSION, hidden: true });
  const watch = (load: () => Promise<ArrayBuffer>) => {
    dialog.close();
    deps.open(load);
  };
  file.onchange = () => {
    const chosen = file.files?.[0];
    if (chosen !== undefined) watch(() => chosen.arrayBuffer());
  };
  const row = (info: SavedReplayInfo) => {
    const load = async () => (await store!.get(info.id)) ?? missing();
    return h(
      'li',
      {},
      h('span', { className: 'dk-saved-replay-name', textContent: info.roomName }),
      h('span', { className: 'dk-saved-replay-meta', textContent: `${new Date(info.savedAt).toLocaleString()} · ${formatClock(info.seconds)}` }),
      button('Watch', () => watch(async () => (await load()).slice().buffer), 'dk-btn dk-saved-replay-watch'),
      button('Download', () => void load().then((data) => deps.download(replayFileName(info.roomName, new Date(info.savedAt)), data)), 'dk-btn dk-saved-replay-download'),
    );
  };
  const dialog = openDialog(host, 'Replays', [status, list, file], [cancelButton('Close', () => dialog.close()), button('Open file', () => file.click())], 'dk-replays');
  void store
    ?.list()
    .then((saved) => {
      status.textContent = saved.length === 0 ? EMPTY_TEXT : '';
      status.hidden = saved.length > 0;
      list.replaceChildren(...saved.map(row));
    })
    .catch(() => (status.textContent = UNAVAILABLE_TEXT));
}
