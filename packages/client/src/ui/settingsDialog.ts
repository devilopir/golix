import { BINDABLE_ACTIONS, bindKey, captureNextKey, keysForAction, unbindKey, type BindableAction } from '../input/bindings.ts';
import type { SettingKey, Settings, SettingsStore, ViewMode } from '../settings/settings.ts';
import { countries, countryGeo, flagEmoji } from './countries.ts';
import { button, cancelButton, h, labeled, openDialog, select } from './dom.ts';

type BooleanKey = { [K in SettingKey]: Settings[K] extends boolean ? K : never }[SettingKey];

const TABS = ['Sound', 'Video', 'Input', 'Misc'] as const;
type Tab = (typeof TABS)[number];

const VIEW_MODE_LABELS: readonly { value: ViewMode; label: string }[] = [
  { value: -1, label: 'Dynamic' },
  { value: 0, label: 'Restricted 840x410' },
  { value: 1, label: 'Full 1x Zoom' },
  { value: 2, label: 'Full 1.25x Zoom' },
  { value: 3, label: 'Full 1.5x Zoom' },
  { value: 4, label: 'Full 1.75x Zoom' },
  { value: 5, label: 'Full 2x Zoom' },
  { value: 6, label: 'Full 2.25x Zoom' },
  { value: 7, label: 'Full 2.5x Zoom' },
];

const ACTION_LABELS: Readonly<Record<BindableAction, string>> = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  kick: 'Kick',
  toggleChat: 'ToggleChat',
  action1: 'Action 1',
  action2: 'Action 2',
  action3: 'Action 3',
  action4: 'Action 4',
  action5: 'Action 5',
  action6: 'Action 6',
};

function toggleRow(settings: SettingsStore, label: string, key: BooleanKey): HTMLElement {
  const on = settings.get(key);
  return h('button', {
    type: 'button',
    className: `dk-toggle-row${on ? ' on' : ''}`,
    textContent: label,
    onclick: () => settings.set(key, !settings.get(key)),
  });
}

function range(settings: SettingsStore, label: string, key: 'chatOpacity' | 'chatFocusHeight' | 'joystickSize', min: number, max: number, step: number): HTMLElement {
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(settings.get(key)) });
  input.onchange = () => settings.set(key, Number(input.value));
  return labeled(label, input);
}

function soundTab(settings: SettingsStore): HTMLElement[] {
  return [
    toggleRow(settings, 'Sounds enabled', 'soundEnabled'),
    toggleRow(settings, 'Chat sound enabled', 'chatSoundEnabled'),
    toggleRow(settings, 'Nick highlight sound enabled', 'highlightSoundEnabled'),
    toggleRow(settings, 'Crowd sound enabled', 'crowdSoundEnabled'),
  ];
}

function videoTab(settings: SettingsStore): HTMLElement[] {
  return [
    labeled('Viewport Mode:', select(VIEW_MODE_LABELS, settings.get('viewMode'), (v) => settings.set('viewMode', v))),
    labeled(
      'FPS Limit:',
      select([{ value: 0, label: 'None (Recommended)' }, { value: 30, label: '30' }] as const, settings.get('fpsLimit'), (v) => settings.set('fpsLimit', v)),
    ),
    labeled(
      'Resolution Scaling:',
      select(
        ([1, 0.75, 0.5, 0.25] as const).map((value) => ({ value, label: `${value * 100}%` })),
        settings.get('resolutionScale'),
        (v) => settings.set('resolutionScale', v),
      ),
    ),
    toggleRow(settings, 'Use low latency canvas', 'lowLatencyCanvas'),
    toggleRow(settings, 'Custom team colors enabled', 'teamColorsEnabled'),
    toggleRow(settings, 'Show chat indicators', 'chatIndicatorsEnabled'),
    toggleRow(settings, 'Show player avatars', 'avatarsEnabled'),
    toggleRow(settings, 'Show join and leave messages', 'joinLeaveNotices'),
    range(settings, 'Chat opacity', 'chatOpacity', 0.5, 1, 0.01),
    range(settings, 'Chat focus height', 'chatFocusHeight', 0, 400, 10),
    labeled(
      'Chat background width:',
      select([{ value: 'full', label: 'Full' }, { value: 'compact', label: 'Compact' }] as const, settings.get('chatBackgroundWidth'), (v) =>
        settings.set('chatBackgroundWidth', v),
      ),
    ),
  ];
}

function inputTab(settings: SettingsStore, host: HTMLElement): HTMLElement[] {
  const bindings = BINDABLE_ACTIONS.map((action) => {
    const keys = keysForAction(settings.get('keyBindings'), action).map((code) =>
      h(
        'span',
        { className: 'dk-key' },
        code,
        button('✕', () => settings.set('keyBindings', unbindKey(settings.get('keyBindings'), code)), 'dk-key-remove'),
      ),
    );
    const add = button('+', async () => {
      const overlay = h('div', { className: 'dk-overlay dk-capture' }, h('p', { textContent: 'Press a key' }));
      host.append(overlay);
      const code = await captureNextKey(window);
      overlay.remove();
      settings.set('keyBindings', bindKey(settings.get('keyBindings'), code, action));
    }, 'dk-btn dk-key-add');
    add.setAttribute('aria-label', `Add key for ${ACTION_LABELS[action]}`);
    return h('div', { className: 'dk-binding' }, h('span', { className: 'dk-binding-action', textContent: ACTION_LABELS[action] }), h('span', { className: 'dk-keys' }, ...keys), add);
  });
  return [
    ...bindings,
    toggleRow(settings, 'Touch controls enabled', 'touchControlsEnabled'),
    range(settings, 'Joystick size', 'joystickSize', 80, 200, 10),
  ];
}

function openLocationDialog(host: HTMLElement, settings: SettingsStore): void {
  let chosen: string | null = null;
  const list = h('ul', { className: 'dk-list dk-country-list' });
  const change = button('Change', () => {
    if (chosen === null) return;
    settings.set('geo', countryGeo(chosen));
    dialog.close();
  });
  const render = () => {
    list.replaceChildren(
      ...countries().map((c) =>
        h('li', {
          className: c.code === chosen ? 'selected' : '',
          onclick: () => {
            chosen = c.code;
            render();
          },
        }, h('span', { className: 'dk-flag', textContent: flagEmoji(c.code) }), c.name),
      ),
    );
    change.disabled = chosen === null;
  };
  const dialog = openDialog(host, 'Change Location', [list], [change, cancelButton('Cancel', () => dialog.close())], 'dk-location');
  render();
}

function miscTab(settings: SettingsStore, host: HTMLElement): HTMLElement[] {
  const code = settings.get('geo')?.code.toUpperCase() ?? '';
  return [
    toggleRow(settings, 'Save every match to Replays', 'saveMatches'),
    h('p', { className: 'dk-location-line', textContent: `Detected location:  ${code}` }),
    button('Override location', () => openLocationDialog(host, settings)),
  ];
}

export function openSettingsDialog(host: HTMLElement, settings: SettingsStore): void {
  let tab: Tab = 'Sound';
  const tabButtons = new Map<Tab, HTMLButtonElement>();
  const content = h('div', { className: 'dk-settings-content' });
  const render = () => {
    for (const [name, el] of tabButtons) el.classList.toggle('on', name === tab);
    const build = { Sound: soundTab, Video: videoTab, Input: inputTab, Misc: miscTab }[tab];
    content.replaceChildren(...build(settings, host));
  };
  for (const name of TABS) {
    tabButtons.set(name, button(name, () => {
      tab = name;
      render();
    }, 'dk-tab'));
  }
  const unsubscribe = settings.subscribe(render);
  const dialog = openDialog(
    host,
    'Settings',
    [h('nav', { className: 'dk-tabs' }, ...tabButtons.values()), content],
    [
      cancelButton('Close', () => {
        unsubscribe();
        dialog.close();
      }),
    ],
    'dk-settings',
  );
  render();
}
