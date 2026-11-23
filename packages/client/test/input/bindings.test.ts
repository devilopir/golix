// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY_BINDINGS, bindKey, captureNextKey, keysForAction, unbindKey } from '../../src/input/bindings.ts';

describe('key bindings', () => {
  it('has the observed multi-key defaults', () => {
    expect(keysForAction(DEFAULT_KEY_BINDINGS, 'up')).toEqual(['ArrowUp', 'KeyW']);
    expect(keysForAction(DEFAULT_KEY_BINDINGS, 'kick')).toEqual([
      'KeyX',
      'Space',
      'ControlLeft',
      'ControlRight',
      'ShiftLeft',
      'ShiftRight',
      'Numpad0',
    ]);
    expect(keysForAction(DEFAULT_KEY_BINDINGS, 'toggleChat')).toEqual([]);
  });

  it('adds extra keys to an action without touching the others', () => {
    const next = bindKey(DEFAULT_KEY_BINDINGS, 'KeyK', 'kick');
    expect(keysForAction(next, 'kick')).toContain('KeyK');
    expect(keysForAction(next, 'up')).toEqual(['ArrowUp', 'KeyW']);
    expect(keysForAction(DEFAULT_KEY_BINDINGS, 'kick')).not.toContain('KeyK');
  });

  it('moves a key that is already bound to another action', () => {
    const next = bindKey(DEFAULT_KEY_BINDINGS, 'KeyW', 'kick');
    expect(keysForAction(next, 'up')).toEqual(['ArrowUp']);
    expect(keysForAction(next, 'kick')).toContain('KeyW');
  });

  it('removes a single key', () => {
    const next = unbindKey(DEFAULT_KEY_BINDINGS, 'Space');
    expect(keysForAction(next, 'kick')).not.toContain('Space');
    expect(keysForAction(next, 'kick')).toHaveLength(6);
  });

  it('captures the next key press, Escape included, and swallows it', async () => {
    const seen: string[] = [];
    window.addEventListener('keydown', (e) => seen.push(e.code));
    const captured = captureNextKey(window);
    const event = new KeyboardEvent('keydown', { code: 'Escape', cancelable: true });
    window.dispatchEvent(event);
    expect(await captured).toBe('Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ' }));
    expect(seen).toEqual(['KeyQ']);
  });
});
