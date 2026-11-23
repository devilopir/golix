export class ProtocolError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function codePoints(s: string, max: number): boolean {
  return s.length <= max || [...s].length <= max;
}

export class Writer {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private reserve(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.reserve(1);
    this.buf[this.pos++] = v;
  }

  bool(v: boolean): void {
    this.u8(v ? 1 : 0);
  }

  uint(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new ProtocolError(`not a uint32: ${v}`);
    while (v >= 0x80) {
      this.u8((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.u8(v);
  }

  int(v: number): void {
    if (!Number.isInteger(v) || v < -0x80000000 || v > 0x7fffffff) throw new ProtocolError(`not an int32: ${v}`);
    this.uint(((v << 1) ^ (v >> 31)) >>> 0);
  }

  f64(v: number): void {
    this.reserve(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  str(v: string, max: number): void {
    if (!codePoints(v, max)) throw new ProtocolError(`string longer than ${max} characters`);
    const bytes = encoder.encode(v);
    this.uint(bytes.length);
    this.reserve(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  finish(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.pos);
  }
}

export class Reader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(data: Uint8Array | ArrayBuffer) {
    this.bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.bytes.length) throw new ProtocolError('message truncated');
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }

  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new ProtocolError(`invalid boolean ${v}`);
    return v === 1;
  }

  uint(): number {
    let v = 0;
    for (let i = 0, scale = 1; i < 5; i++, scale *= 0x80) {
      const b = this.u8();
      v += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) {
        if (v > 0xffffffff) break;
        return v;
      }
    }
    throw new ProtocolError('invalid varint');
  }

  int(): number {
    const z = this.uint();
    return (z >>> 1) ^ -(z & 1);
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  str(max: number): string {
    const len = this.uint();
    if (len > max * 4) throw new ProtocolError(`string longer than ${max} characters`);
    this.need(len);
    let s: string;
    try {
      s = decoder.decode(this.bytes.subarray(this.pos, this.pos + len));
    } catch {
      throw new ProtocolError('invalid UTF-8');
    }
    this.pos += len;
    if (!codePoints(s, max)) throw new ProtocolError(`string longer than ${max} characters`);
    return s;
  }

  /** Array length, bounded by the bytes left since every element takes at least one. */
  count(): number {
    const n = this.uint();
    if (n > this.remaining) throw new ProtocolError(`invalid array length ${n}`);
    return n;
  }

  end(): void {
    if (this.pos !== this.bytes.length) throw new ProtocolError('trailing bytes');
  }
}
