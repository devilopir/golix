// Synchronous ECDSA P-256 / SHA-256 verification, so joins stay synchronous in Node and in the browser alike
// (WebCrypto only verifies asynchronously). Curve constants are from SEC 2 / FIPS 186-4.

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(message: Uint8Array): Uint8Array {
  const length = message.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

/** Jacobian coordinates; null is the point at infinity. */
type Point = { x: bigint; y: bigint; z: bigint } | null;

const mod = (a: bigint, m = P) => ((a % m) + m) % m;

function pow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
  }
  return result;
}

const invert = (a: bigint, m: bigint) => pow(a, m - 2n, m);

/** dbl-2001-b, for a = -3. */
function double(p: Point): Point {
  if (p === null || p.y === 0n) return null;
  const delta = mod(p.z * p.z);
  const gamma = mod(p.y * p.y);
  const beta = mod(p.x * gamma);
  const alpha = mod(3n * (p.x - delta) * (p.x + delta));
  const x = mod(alpha * alpha - 8n * beta);
  const z = mod((p.y + p.z) * (p.y + p.z) - gamma - delta);
  const y = mod(alpha * (4n * beta - x) - 8n * gamma * gamma);
  return { x, y, z };
}

/** add-2007-bl. */
function add(p: Point, q: Point): Point {
  if (p === null) return q;
  if (q === null) return p;
  const z1z1 = mod(p.z * p.z);
  const z2z2 = mod(q.z * q.z);
  const u1 = mod(p.x * z2z2);
  const u2 = mod(q.x * z1z1);
  const s1 = mod(p.y * q.z * z2z2);
  const s2 = mod(q.y * p.z * z1z1);
  const h = mod(u2 - u1);
  const r = mod(2n * (s2 - s1));
  if (h === 0n) return r === 0n ? double(p) : null;
  const i = mod(4n * h * h);
  const j = mod(h * i);
  const v = mod(u1 * i);
  const x = mod(r * r - j - 2n * v);
  const y = mod(r * (v - x) - 2n * s1 * j);
  const z = mod(((p.z + q.z) * (p.z + q.z) - z1z1 - z2z2) * h);
  return { x, y, z };
}

function toBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/** `publicPoint` is the 65-byte uncompressed point, `signature` the 64-byte r || s (IEEE P1363). */
export function verifyP256(publicPoint: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicPoint.length !== 65 || publicPoint[0] !== 4 || signature.length !== 64) return false;
  const qx = toBigInt(publicPoint.subarray(1, 33));
  const qy = toBigInt(publicPoint.subarray(33));
  if (qx >= P || qy >= P || mod(qy * qy) !== mod(qx * qx * qx - 3n * qx + B)) return false;
  const r = toBigInt(signature.subarray(0, 32));
  const s = toBigInt(signature.subarray(32));
  if (r === 0n || r >= N || s === 0n || s >= N) return false;
  const w = invert(s, N);
  const u1 = (mod(toBigInt(sha256(message)), N) * w) % N;
  const u2 = (r * w) % N;
  const g: Point = { x: GX, y: GY, z: 1n };
  const q: Point = { x: qx, y: qy, z: 1n };
  const gq = add(g, q);
  let acc: Point = null;
  for (let bit = 255n; bit >= 0n; bit--) {
    acc = double(acc);
    const a = (u1 >> bit) & 1n;
    const b = (u2 >> bit) & 1n;
    if (a && b) acc = add(acc, gq);
    else if (a) acc = add(acc, g);
    else if (b) acc = add(acc, q);
  }
  if (acc === null) return false;
  const zInv = invert(acc.z, P);
  return mod(acc.x * zInv * zInv) % N === r;
}
