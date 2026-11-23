// @vitest-environment happy-dom
import { ActionFlags, InputFlags } from '@golix/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_KEY_BINDINGS, bindKey, type KeyBindings } from '../../src/input/bindings.ts';
import { KeyboardInput, inputFromKeys, type UiAction } from '../../src/input/keyboard.ts';

const { up, down, left, right, kick } = InputFlags;

function press(code: string, target: EventTarget = window, repeat = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { code, repeat, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function release(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
}

describe('inputFromKeys', () => {
  it('ORs the flags of every bound key and ignores unbound ones', () => {
    expect(inputFromKeys(['ArrowUp', 'KeyD', 'Space', 'KeyZ'], DEFAULT_KEY_BINDINGS)).toBe(up | right | kick);
    expect(inputFromKeys(['KeyQ', 'KeyV'], DEFAULT_KEY_BINDINGS)).toBe(ActionFlags[0] | ActionFlags[5]);
    expect(inputFromKeys([], DEFAULT_KEY_BINDINGS)).toBe(0);
  });
});

describe('KeyboardInput', () => {
  let bindings: KeyBindings;
  let inputs: number[];
  let actions: UiAction[];
  let keyboard: KeyboardInput;

  beforeEach(() => {
    bindings = DEFAULT_KEY_BINDINGS;
    inputs = [];
    actions = [];
    keyboard = new KeyboardInput(window, {
      bindings: () => bindings,
      onInput: (input) => inputs.push(input),
      onUiAction: (action) => actions.push(action),
    });
  });

  afterEach(() => {
    keyboard.dispose();
    document.body.innerHTML = '';
  });

  it('emits the bitmask only when it changes', () => {
    press('ArrowLeft');
    press('ArrowLeft', window, true);
    press('KeyA');
    press('ArrowDown');
    press('KeyX');
    release('ArrowLeft');
    release('KeyA');
    release('KeyX');
    release('ArrowDown');
    expect(inputs).toEqual([left, left | down, left | down | kick, down | kick, down, 0]);
  });

  it('prevents the default action of bound keys', () => {
    expect(press('Space').defaultPrevented).toBe(true);
    expect(press('KeyZ').defaultPrevented).toBe(false);
  });

  it('ignores keys typed into a text field and releases held keys when one gains focus', () => {
    const chat = document.createElement('input');
    document.body.append(chat);
    press('ArrowRight');
    chat.focus();
    press('ArrowUp', chat);
    press('Enter', chat);
    expect(inputs).toEqual([right, 0]);
    expect(actions).toEqual([]);
  });

  it('releases everything on window blur', () => {
    press('ArrowUp');
    press('KeyX');
    window.dispatchEvent(new Event('blur'));
    release('ArrowUp');
    expect(inputs).toEqual([up, up | kick, 0]);
  });

  it('maps fixed UI keys and ignores auto-repeat for them', () => {
    press('Enter');
    press('Tab');
    press('Escape');
    press('KeyP');
    press('KeyP', window, true);
    press('Digit0');
    press('Digit1');
    press('Digit4');
    press('Digit5');
    press('Digit7');
    expect(actions).toEqual([
      { type: 'focusChat' },
      { type: 'focusChat' },
      { type: 'menu' },
      { type: 'pause' },
      { type: 'viewMode', mode: 1 },
      { type: 'viewMode', mode: 4 },
      { type: 'viewMode', mode: 5 },
      { type: 'viewMode', mode: 7 },
    ]);
    expect(inputs).toEqual([]);
  });

  it('lets a user binding override a fixed UI key', () => {
    bindings = bindKey(bindings, 'Digit1', 'kick');
    press('Digit1');
    expect(inputs).toEqual([kick]);
    expect(actions).toEqual([]);
  });

  it('emits toggleChat for its bound key', () => {
    bindings = bindKey(bindings, 'KeyC', 'toggleChat');
    press('KeyC');
    expect(actions).toEqual([{ type: 'toggleChat' }]);
    expect(inputs).toEqual([]);
  });

  it('applies rebinding immediately', () => {
    bindings = bindKey(bindings, 'KeyJ', 'left');
    press('KeyJ');
    expect(inputs).toEqual([left]);
  });

  it('stops listening after dispose', () => {
    keyboard.dispose();
    press('ArrowUp');
    expect(inputs).toEqual([]);
  });
});
