import { defaultStadiums, parseStadium } from '@golix/shared';
import { button, cancelButton, h, openDialog } from './dom.ts';
import type { StadiumStore, StoredStadium } from './stadiums.ts';

export interface StadiumPickerDeps {
  host: HTMLElement;
  store: StadiumStore;
  onPick(source: string): void;
  download(filename: string, text: string): void;
}

export const STADIUM_FILE_ACCEPT = '.hbs,.json,.json5';

interface Entry extends StoredStadium {
  /** Index in the store; null for built-ins. */
  storedIndex: number | null;
}

export function openStadiumPicker(deps: StadiumPickerDeps): void {
  let selected: Entry | null = null;
  const list = h('ul', { className: 'dk-list dk-stadium-list' });
  const error = h('p', { className: 'dk-error', hidden: true });
  const file = h('input', { type: 'file', accept: STADIUM_FILE_ACCEPT, hidden: true });

  const pick = (source: string) => {
    dialog.close();
    deps.onPick(source);
  };
  const pickButton = button('Pick', () => selected !== null && pick(selected.source));
  const deleteButton = button('Delete', () => {
    if (selected?.storedIndex == null) return;
    deps.store.remove(selected.storedIndex);
    selected = null;
    render();
  });
  const exportButton = button('Export', () => selected !== null && deps.download(`${selected.name}.hbs`, selected.source));

  const render = () => {
    const entries: Entry[] = [
      ...defaultStadiums.map((s) => ({ ...s, storedIndex: null })),
      ...deps.store.list().map((s, i) => ({ ...s, storedIndex: i })),
    ];
    list.replaceChildren(
      ...entries.map((entry) => {
        const isSelected = selected !== null && selected.storedIndex === entry.storedIndex && selected.name === entry.name;
        return h('li', {
          className: `${entry.storedIndex === null ? '' : 'custom'} ${isSelected ? 'selected' : ''}`.trim(),
          textContent: entry.name,
          onclick: () => {
            selected = entry;
            render();
          },
          ondblclick: () => pick(entry.source),
        });
      }),
    );
    pickButton.disabled = selected === null;
    exportButton.disabled = selected === null;
    deleteButton.disabled = selected?.storedIndex == null;
  };

  file.onchange = async () => {
    const chosen = file.files?.[0];
    file.value = '';
    if (chosen === undefined) return;
    const source = await chosen.text();
    try {
      parseStadium(source);
    } catch (e) {
      error.textContent = (e as Error).message;
      error.hidden = false;
      return;
    }
    pick(source);
  };

  const dialog = openDialog(
    deps.host,
    'Pick a stadium',
    [list, error, file],
    [pickButton, deleteButton, button('Load', () => file.click()), exportButton, cancelButton('Cancel', () => dialog.close())],
    'dk-stadium-picker',
  );
  render();
}
