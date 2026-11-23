import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256, verifyP256 } from '../src/p256.ts';

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(x as string, 'base64url'), Buffer.from(y as string, 'base64url')]);
  return { point, signWith: (m: Uint8Array) => sign('sha256', m, { key: privateKey, dsaEncoding: 'ieee-p1363' }) };
}

describe('sha256', () => {
  it('matches node:crypto on every length around the block boundaries', () => {
    for (let n = 0; n < 200; n++) {
      const m = randomBytes(n);
      expect(Buffer.from(sha256(m)).toString('hex')).toBe(createHash('sha256').update(m).digest('hex'));
    }
  });
});

describe('verifyP256', () => {
  it('accepts signatures made by node:crypto and rejects them for another message or key', () => {
    const other = keyPair();
    for (let i = 0; i < 20; i++) {
      const { point, signWith } = keyPair();
      const m = randomBytes(43);
      const sig = signWith(m);
      expect(verifyP256(point, m, sig)).toBe(true);
      expect(verifyP256(point, randomBytes(43), sig)).toBe(false);
      expect(verifyP256(other.point, m, sig)).toBe(false);
    }
  });

  it('rejects tampered signatures, out-of-range scalars and points off the curve', () => {
    const { point, signWith } = keyPair();
    const m = Buffer.from('nonce');
    const sig = signWith(m);
    for (let i = 0; i < 64; i++) {
      const bad = Buffer.from(sig);
      bad[i] ^= 1 << i % 8;
      expect(verifyP256(point, m, bad)).toBe(false);
    }
    const n = Buffer.from('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551', 'hex');
    expect(verifyP256(point, m, Buffer.concat([Buffer.alloc(32), sig.subarray(32)]))).toBe(false);
    expect(verifyP256(point, m, Buffer.concat([sig.subarray(0, 32), Buffer.alloc(32)]))).toBe(false);
    expect(verifyP256(point, m, Buffer.concat([n, sig.subarray(32)]))).toBe(false);
    expect(verifyP256(point, m, sig.subarray(1))).toBe(false);
    const offCurve = Buffer.from(point);
    offCurve[64] ^= 1;
    expect(verifyP256(offCurve, m, sig)).toBe(false);
    expect(verifyP256(Buffer.concat([Buffer.from([2]), point.subarray(1)]), m, sig)).toBe(false);
  });
});
