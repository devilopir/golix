import { ActionFlags, InputFlags, type Input } from '@golix/shared';
import { h } from '../ui/dom.ts';

/** Fraction of the stick radius that gives no direction. */
export const DEAD_ZONE = 0.25;
// An axis counts when the stick is within 67.5 degrees of it, which splits the circle into 8 equal sectors.
const AXIS_THRESHOLD = Math.cos((3 * Math.PI) / 8);

export function joystickInput(dx: number, dy: number, radius: number): Input {
  const length = Math.hypot(dx, dy);
  if (length <= radius * DEAD_ZONE) return 0;
  const x = dx / length;
  const y = dy / length;
  let input = 0;
  if (x > AXIS_THRESHOLD) input |= InputFlags.right;
  else if (x < -AXIS_THRESHOLD) input |= InputFlags.left;
  if (y > AXIS_THRESHOLD) input |= InputFlags.down;
  else if (y < -AXIS_THRESHOLD) input |= InputFlags.up;
  return input;
}

export function mergeInputs(keyboard: Input, touch: Input): Input {
  return keyboard | touch;
}

interface Stick {
  pointerId: number;
  x: number;
  y: number;
}

/** Floating joystick on the left half and a kick button on the right, plus action buttons in rooms that turn them on; each follows its own pointer. */
export class TouchControls {
  readonly el: HTMLElement;
  private readonly base = h('div', { className: 'dk-touch-stick idle' }, h('div', { className: 'dk-touch-knob' }));
  private readonly knob = this.base.firstElementChild as HTMLElement;
  private readonly actions = h('div', { className: 'dk-touch-actions', hidden: true });
  private size = 0;
  private stick: Stick | null = null;
  /** Pointer id -> the flag of the button it holds. */
  private readonly pressed = new Map<number, { button: HTMLElement; flag: Input }>();
  private direction: Input = 0;
  private input: Input = 0;

  constructor(private readonly onInput: (input: Input) => void) {
    const zone = h('div', { className: 'dk-touch-zone', onpointerdown: this.onStickDown }, this.base);
    const kick = this.button('dk-touch-kick', 'Kick', InputFlags.kick);
    this.actions.append(...ActionFlags.map((flag, i) => this.button('dk-touch-action', String(i + 1), flag)));
    this.el = h(
      'div',
      { className: 'dk-touch', hidden: true },
      zone,
      kick,
      this.actions,
      h('p', { className: 'dk-rotate-hint', textContent: 'Turn your phone sideways to play' }),
    );
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
  }

  dispose(): void {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
  }

  /** Hiding releases whatever is held. */
  setActive(active: boolean, actionKeys = false): void {
    this.el.hidden = !active;
    this.actions.hidden = !actionKeys;
    for (const [pointerId, { button, flag }] of this.pressed) {
      if (active && (actionKeys || flag === InputFlags.kick)) continue;
      button.classList.remove('on');
      this.pressed.delete(pointerId);
    }
    if (!active) this.releaseStick();
    this.update();
  }

  /** Diameter of the joystick base in CSS px. */
  setSize(px: number): void {
    this.size = px;
    this.el.style.setProperty('--dk-stick-size', `${px}px`);
  }

  private button(className: string, label: string, flag: Input): HTMLElement {
    const button = h('div', { className, textContent: label });
    button.onpointerdown = (e) => {
      e.preventDefault();
      if (this.pressed.has(e.pointerId) || [...this.pressed.values()].some((p) => p.button === button)) return;
      this.pressed.set(e.pointerId, { button, flag });
      button.classList.add('on');
      this.update();
    };
    return button;
  }

  private readonly onStickDown = (e: PointerEvent): void => {
    if (this.stick !== null) return;
    e.preventDefault();
    this.stick = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    const zone = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.base.classList.remove('idle');
    this.base.style.left = `${e.clientX - zone.left}px`;
    this.base.style.top = `${e.clientY - zone.top}px`;
  };

  private readonly onMove = (e: PointerEvent): void => {
    const { stick } = this;
    if (stick === null || e.pointerId !== stick.pointerId) return;
    const radius = this.size / 2;
    const dx = e.clientX - stick.x;
    const dy = e.clientY - stick.y;
    const scale = Math.min(1, radius / (Math.hypot(dx, dy) || 1));
    this.knob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
    this.direction = joystickInput(dx, dy, radius);
    this.update();
  };

  private readonly onUp = (e: PointerEvent): void => {
    const held = this.pressed.get(e.pointerId);
    if (e.pointerId === this.stick?.pointerId) this.releaseStick();
    else if (held !== undefined) {
      this.pressed.delete(e.pointerId);
      held.button.classList.remove('on');
    } else return;
    this.update();
  };

  private releaseStick(): void {
    this.stick = null;
    this.direction = 0;
    this.base.classList.add('idle');
    this.base.style.left = '';
    this.base.style.top = '';
    this.knob.style.transform = '';
  }

  private update(): void {
    let input = this.direction;
    for (const { flag } of this.pressed.values()) input |= flag;
    if (input === this.input) return;
    this.input = input;
    this.onInput(input);
  }
}
