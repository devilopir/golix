export const ACTION_KEY_ACTIONS = ['action1', 'action2', 'action3', 'action4', 'action5', 'action6'] as const;
export const BINDABLE_ACTIONS: readonly ['up', 'down', 'left', 'right', 'kick', 'toggleChat', ...typeof ACTION_KEY_ACTIONS] = ['up', 'down', 'left', 'right', 'kick', 'toggleChat', ...ACTION_KEY_ACTIONS];
export type BindableAction = (typeof BINDABLE_ACTIONS)[number];

/** KeyboardEvent.code -> action. A key drives at most one action; an action may have many keys. */
export type KeyBindings = Readonly<Record<string, BindableAction>>;

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  KeyX: 'kick',
  Space: 'kick',
  ControlLeft: 'kick',
  ControlRight: 'kick',
  ShiftLeft: 'kick',
  ShiftRight: 'kick',
  Numpad0: 'kick',
  KeyQ: 'action1',
  KeyE: 'action2',
  KeyR: 'action3',
  KeyF: 'action4',
  KeyC: 'action5',
  KeyV: 'action6',
};

export function normalizeKeyBindings(raw: unknown): KeyBindings | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const actions: readonly string[] = BINDABLE_ACTIONS;
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, BindableAction] => actions.includes(entry[1])),
  );
}

export function keysForAction(bindings: KeyBindings, action: BindableAction): string[] {
  return Object.keys(bindings).filter((code) => bindings[code] === action);
}

/** Binding a key already used by another action moves it to the new action. */
export function bindKey(bindings: KeyBindings, code: string, action: BindableAction): KeyBindings {
  return { ...bindings, [code]: action };
}

export function unbindKey(bindings: KeyBindings, code: string): KeyBindings {
  const next = { ...bindings };
  delete next[code];
  return next;
}

/** Resolves with the code of the next key pressed, Escape included; there is no cancel key. */
export function captureNextKey(target: EventTarget): Promise<string> {
  return new Promise((resolve) => {
    const onKeyDown = (event: Event) => {
      const { code } = event as KeyboardEvent;
      event.preventDefault();
      event.stopImmediatePropagation();
      target.removeEventListener('keydown', onKeyDown, true);
      resolve(code);
    };
    target.addEventListener('keydown', onKeyDown, true);
  });
}
