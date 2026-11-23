// @vitest-environment happy-dom
import { ActionFlags, InputFlags } from '@golix/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEAD_ZONE, joystickInput, mergeInputs, TouchControls } from '../../src/input/touch.ts';

const { up, down, left, right, kick } = InputFlags;

function pointer(target: EventTarget, type: string, pointerId: number, clientX = 0, clientY = 0): PointerEvent {
  const event = new PointerEvent(type, { pointerId, pointerType: 'touch', clientX, clientY, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('joystickInput', () => {
  it('maps the stick to 8 directions of 45 degrees each', () => {
    const at = (degrees: number) => joystickInput(Math.cos((degrees * Math.PI) / 180) * 50, Math.sin((degrees * Math.PI) / 180) * 50, 60);
    expect([0, 45, 90, 135, 180, 225, 270, 315].map(at)).toEqual([
      right,
      right | down,
      down,
      down | left,
      left,
      left | up,
      up,
      up | right,
    ]);
    expect(at(22)).toBe(right);
    expect(at(23)).toBe(right | down);
    expect(at(-67)).toBe(up | right);
    expect(at(-68)).toBe(up);
  });

  it('gives no direction inside the dead zone', () => {
    expect(joystickInput(0, 0, 60)).toBe(0);
    expect(joystickInput(60 * DEAD_ZONE, 0, 60)).toBe(0);
    expect(joystickInput(60 * DEAD_ZONE + 1, 0, 60)).toBe(right);
  });

  it('keeps the direction past the rim', () => {
    expect(joystickInput(-500, 0, 60)).toBe(left);
  });
});

describe('mergeInputs', () => {
  it('combines keyboard and touch flags', () => {
    expect(mergeInputs(left | kick, 0)).toBe(left | kick);
    expect(mergeInputs(up, right | kick)).toBe(up | right | kick);
  });
});

describe('TouchControls', () => {
  let inputs: number[];
  let controls: TouchControls;
  const zone = () => controls.el.querySelector('.dk-touch-zone')!;
  const kickButton = () => controls.el.querySelector('.dk-touch-kick')!;

  beforeEach(() => {
    inputs = [];
    controls = new TouchControls((input) => inputs.push(input));
    controls.setSize(120);
    controls.setActive(true);
    document.body.append(controls.el);
  });

  afterEach(() => {
    controls.dispose();
    controls.el.remove();
  });

  it('floats the stick to where the thumb lands and steers relative to it', () => {
    const stick = controls.el.querySelector<HTMLElement>('.dk-touch-stick')!;
    expect(stick.classList.contains('idle')).toBe(true);
    expect(pointer(zone(), 'pointerdown', 1, 100, 200).defaultPrevented).toBe(true);
    expect(stick.classList.contains('idle')).toBe(false);
    expect([stick.style.left, stick.style.top]).toEqual(['100px', '200px']);
    pointer(zone(), 'pointermove', 1, 110, 200);
    expect(inputs).toEqual([]);
    pointer(zone(), 'pointermove', 1, 150, 200);
    pointer(zone(), 'pointermove', 1, 150, 150);
    pointer(zone(), 'pointermove', 1, 100, 100);
    pointer(zone(), 'pointerup', 1, 100, 100);
    expect(inputs).toEqual([right, right | up, up, 0]);
    expect(stick.classList.contains('idle')).toBe(true);
  });

  it('keeps the knob on the rim of the base', () => {
    pointer(zone(), 'pointerdown', 1, 100, 100);
    pointer(zone(), 'pointermove', 1, 400, 100);
    expect(controls.el.querySelector<HTMLElement>('.dk-touch-knob')!.style.transform).toBe('translate(60px, 0px)');
  });

  it('holds kick together with the stick, each on its own finger', () => {
    pointer(zone(), 'pointerdown', 1, 100, 100);
    pointer(zone(), 'pointermove', 1, 100, 160);
    pointer(kickButton(), 'pointerdown', 2, 700, 300);
    pointer(kickButton(), 'pointerdown', 3, 700, 300);
    pointer(zone(), 'pointermove', 2, 0, 0);
    pointer(kickButton(), 'pointerup', 3);
    pointer(zone(), 'pointerup', 1);
    pointer(kickButton(), 'pointerup', 2);
    expect(inputs).toEqual([down, down | kick, kick, 0]);
  });

  it('ignores a second finger in the stick zone', () => {
    pointer(zone(), 'pointerdown', 1, 100, 100);
    pointer(zone(), 'pointerdown', 2, 300, 300);
    pointer(zone(), 'pointermove', 2, 200, 300);
    expect(inputs).toEqual([]);
  });

  it('releases everything when hidden and ignores the lifted fingers', () => {
    pointer(zone(), 'pointerdown', 1, 100, 100);
    pointer(zone(), 'pointermove', 1, 40, 100);
    pointer(kickButton(), 'pointerdown', 2);
    controls.setActive(false);
    expect(controls.el.hidden).toBe(true);
    pointer(zone(), 'pointermove', 1, 160, 100);
    pointer(kickButton(), 'pointercancel', 2);
    expect(inputs).toEqual([left, left | kick, 0]);
  });

  it('shows action buttons only in rooms that turn them on, and sends their flags', () => {
    const actions = () => controls.el.querySelector<HTMLElement>('.dk-touch-actions')!;
    const action = (n: number) => controls.el.querySelectorAll('.dk-touch-action')[n - 1]!;
    expect(actions().hidden).toBe(true);
    controls.setActive(true, true);
    expect(actions().hidden).toBe(false);
    expect([...controls.el.querySelectorAll('.dk-touch-action')].map((b) => b.textContent)).toEqual(['1', '2', '3', '4', '5', '6']);
    pointer(action(1), 'pointerdown', 1);
    pointer(kickButton(), 'pointerdown', 2);
    pointer(action(6), 'pointerdown', 3);
    pointer(action(1), 'pointerup', 1);
    expect(inputs).toEqual([ActionFlags[0], ActionFlags[0] | kick, ActionFlags[0] | kick | ActionFlags[5], kick | ActionFlags[5]]);
  });

  it('lets go of held action buttons when the room turns them off', () => {
    controls.setActive(true, true);
    pointer(controls.el.querySelectorAll('.dk-touch-action')[2]!, 'pointerdown', 1);
    pointer(kickButton(), 'pointerdown', 2);
    controls.setActive(true, false);
    expect(controls.el.querySelector<HTMLElement>('.dk-touch-actions')!.hidden).toBe(true);
    expect(controls.el.querySelector('.dk-touch-action.on')).toBeNull();
    expect(inputs).toEqual([ActionFlags[2], ActionFlags[2] | kick, kick]);
  });
});
