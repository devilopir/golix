export interface FakeCanvas {
  label: string;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  getContext(type: string, options?: unknown): CanvasRenderingContext2D;
  ownerDocument: { createElement(tag: string): FakeCanvas };
}

/** Canvas stand-in whose 2D contexts append every call and property write to `log`. */
export function createFakeCanvas(clientWidth: number, clientHeight: number) {
  const log: string[] = [];
  let surfaces = 0;

  const fmt = (v: unknown): string => {
    if (typeof v === 'number') return String(Number(v.toFixed(3)));
    if (typeof v === 'string') return JSON.stringify(v);
    if (v && typeof v === 'object' && 'label' in v) return `<${String(v.label)}>`;
    return String(v);
  };

  const makeContext = (label: string): CanvasRenderingContext2D => {
    const state: Record<string, unknown> = {};
    return new Proxy(state, {
      get(target, key) {
        if (typeof key !== 'string') return undefined;
        if (key in target) return target[key];
        if (key === 'measureText') {
          return (text: string) => {
            const size = Number(/(\d+(?:\.\d+)?)px/.exec(String(target.font ?? ''))?.[1] ?? 10);
            const half = (text.length * size * 0.6) / 2;
            log.push(`${label}.measureText(${fmt(text)})`);
            return { width: half * 2, actualBoundingBoxLeft: half, actualBoundingBoxRight: half, actualBoundingBoxAscent: size * 0.7, actualBoundingBoxDescent: 0 };
          };
        }
        if (key === 'createPattern') {
          return (source: FakeCanvas, repetition: string) => {
            log.push(`${label}.createPattern(<${source.label}>, ${fmt(repetition)})`);
            return { label: `pattern:${source.label}` };
          };
        }
        return (...args: unknown[]) => {
          log.push(`${label}.${key}(${args.map(fmt).join(', ')})`);
        };
      },
      set(target, key, value) {
        target[key as string] = value;
        log.push(`${label}.${String(key)} = ${fmt(value)}`);
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  };

  const makeCanvas = (label: string, w: number, h: number): FakeCanvas => {
    const ctx = makeContext(label);
    return {
      label,
      width: 0,
      height: 0,
      clientWidth: w,
      clientHeight: h,
      getContext(type, options) {
        log.push(`${label}.getContext(${fmt(type)}, ${JSON.stringify(options)})`);
        return ctx;
      },
      ownerDocument: { createElement: () => makeCanvas(`surface${++surfaces}`, 0, 0) },
    };
  };

  const canvas = makeCanvas('main', clientWidth, clientHeight);
  return { canvas, element: canvas as unknown as HTMLCanvasElement, log };
}
