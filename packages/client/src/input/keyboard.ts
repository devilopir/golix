import { ActionFlags, InputFlags, type Input } from '@golix/shared';
import type { ViewMode } from '../settings/settings.ts';
import type { BindableAction, KeyBindings } from './bindings.ts';

export type UiAction =
  | { type: 'focusChat' }
  | { type: 'toggleChat' }
  | { type: 'menu' }
  | { type: 'pause' }
  | { type: 'viewMode'; mode: ViewMode };

const ACTION_FLAGS: Partial<Record<BindableAction, number>> = {
  up: InputFlags.up,
  down: InputFlags.down,
  left: InputFlags.left,
  right: InputFlags.right,
  kick: InputFlags.kick,
  action1: ActionFlags[0],
  action2: ActionFlags[1],
  action3: ActionFlags[2],
  action4: ActionFlags[3],
  action5: ActionFlags[4],
  action6: ActionFlags[5],
};

// Fixed keys; a user binding on the same code takes precedence. Like the original, only 1-4 change the view.
const FIXED_UI_KEYS: Readonly<Record<string, UiAction>> = {
  Enter: { type: 'focusChat' },
  NumpadEnter: { type: 'focusChat' },
  Tab: { type: 'focusChat' },
  Escape: { type: 'menu' },
  KeyP: { type: 'pause' },
  Digit1: { type: 'viewMode', mode: 1 },
  Digit2: { type: 'viewMode', mode: 2 },
  Digit3: { type: 'viewMode', mode: 3 },
  Digit4: { type: 'viewMode', mode: 4 },
  Digit5: { type: 'viewMode', mode: 5 },
  Digit6: { type: 'viewMode', mode: 6 },
  Digit7: { type: 'viewMode', mode: 7 },
};

export function inputFromKeys(pressed: Iterable<string>, bindings: KeyBindings): Input {
  let input = 0;
  for (const code of pressed) {
    const action = bindings[code];
    if (action !== undefined) input |= ACTION_FLAGS[action] ?? 0;
  }
  return input;
}

export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export interface KeyboardInputOptions {
  /** Read on every event so rebinding takes effect immediately. */
  bindings: () => KeyBindings;
  onInput: (input: Input) => void;
  onUiAction: (action: UiAction) => void;
}

export class KeyboardInput {
  private readonly pressed = new Set<string>();
  private input: Input = 0;

  constructor(
    private readonly target: Window,
    private readonly options: KeyboardInputOptions,
  ) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.releaseAll);
    target.addEventListener('focusin', this.onFocusIn);
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.releaseAll);
    this.target.removeEventListener('focusin', this.onFocusIn);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isTextField(event.target)) return;
    const action = this.options.bindings()[event.code];
    if (action === 'toggleChat') {
      event.preventDefault();
      if (!event.repeat) this.options.onUiAction({ type: 'toggleChat' });
      return;
    }
    if (action !== undefined) {
      event.preventDefault();
      this.pressed.add(event.code);
      this.update();
      return;
    }
    const uiAction = FIXED_UI_KEYS[event.code];
    if (uiAction === undefined) return;
    event.preventDefault();
    if (!event.repeat) this.options.onUiAction(uiAction);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (this.pressed.delete(event.code)) this.update();
  };

  private readonly onFocusIn = (event: FocusEvent): void => {
    if (isTextField(event.target)) this.releaseAll();
  };

  private readonly releaseAll = (): void => {
    this.pressed.clear();
    this.update();
  };

  private update(): void {
    const input = inputFromKeys(this.pressed, this.options.bindings());
    if (input === this.input) return;
    this.input = input;
    this.options.onInput(input);
  }
}
