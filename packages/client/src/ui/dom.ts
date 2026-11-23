type Child = Node | string | null | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== false) el.append(child);
  return el;
}

export function button(label: string, onclick: () => void, className = 'dk-btn'): HTMLButtonElement {
  return h('button', { type: 'button', className, textContent: label, onclick });
}

/** The button Escape presses in its dialog. */
export function cancelButton(label: string, onclick: () => void): HTMLButtonElement {
  const el = button(label, onclick);
  el.dataset.cancel = '';
  return el;
}

/** Escape on the topmost overlay runs `cancel` instead of reaching the game keys. */
export function closeOnEscape(overlay: HTMLElement, cancel: () => void): void {
  const doc = overlay.ownerDocument;
  const onKeyDown = (event: KeyboardEvent) => {
    if (!overlay.isConnected) return doc.removeEventListener('keydown', onKeyDown, true);
    if (event.key !== 'Escape' || [...doc.querySelectorAll('.dk-overlay')].at(-1) !== overlay) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  doc.addEventListener('keydown', onKeyDown, true);
}

export function toggleButton(label: (on: boolean) => string, initial: boolean, onChange: (on: boolean) => void): HTMLButtonElement {
  let on = initial;
  const el = button(label(on), () => {
    on = !on;
    el.textContent = label(on);
    el.classList.toggle('on', on);
    onChange(on);
  }, 'dk-btn dk-toggle');
  el.classList.toggle('on', on);
  return el;
}

export interface Dialog {
  el: HTMLElement;
  close(): void;
}

export function openDialog(host: HTMLElement, title: string, body: Child[], actions: Child[], className = ''): Dialog {
  const panel = h('div', { className: `dk-dialog ${className}`.trim() }, h('h2', { textContent: title }), ...body);
  panel.append(h('div', { className: 'dk-actions' }, ...actions));
  const overlay = h('div', { className: 'dk-overlay' }, panel);
  host.append(overlay);
  closeOnEscape(overlay, () => panel.querySelector<HTMLButtonElement>('.dk-actions [data-cancel]')?.click());
  return { el: panel, close: () => overlay.remove() };
}

export function messageDialog(host: HTMLElement, title: string, text: string, onClose: () => void = () => {}): Dialog {
  const dialog = openDialog(host, title, [h('p', { textContent: text })], [
    cancelButton('Ok', () => {
      dialog.close();
      onClose();
    }),
  ]);
  return dialog;
}

export function labeled(label: string, control: HTMLElement): HTMLLabelElement {
  return h('label', { className: 'dk-field' }, h('span', { textContent: label }), control);
}

export function select<T extends string | number>(
  options: readonly { value: T; label: string }[],
  current: T,
  onChange: (value: T) => void,
): HTMLSelectElement {
  const el = h('select', {}, ...options.map((o, i) => h('option', { value: String(i), textContent: o.label })));
  el.value = String(Math.max(0, options.findIndex((o) => o.value === current)));
  el.onchange = () => onChange(options[Number(el.value)].value);
  return el;
}
