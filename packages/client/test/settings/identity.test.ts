import { describe, expect, it } from 'vitest';
import { loadIdentity } from '../../src/settings/identity.ts';
import { MemoryStorage } from './memoryStorage.ts';

const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' };

describe('identity', () => {
  it('keeps the same auth id across reloads', async () => {
    const storage = new MemoryStorage();
    const first = await loadIdentity(storage);
    const second = await loadIdentity(storage);
    expect(first.authId).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(second.authId).toBe(first.authId);
  });

  it('gives different storages different ids', async () => {
    const [a, b] = await Promise.all([loadIdentity(new MemoryStorage()), loadIdentity(new MemoryStorage())]);
    expect(a.authId).not.toBe(b.authId);
  });

  it('signs with the reloaded private key so the auth id verifies it', async () => {
    const storage = new MemoryStorage();
    await loadIdentity(storage);
    const { privateKey, authId } = await loadIdentity(storage);
    const data = new TextEncoder().encode('challenge');
    const signature = await crypto.subtle.sign(ECDSA_SHA256, privateKey, data);
    const raw = Uint8Array.from(atob(authId.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const verifier = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify(ECDSA_SHA256, verifier, signature, data)).toBe(true);
  });

  it('regenerates and persists a new key when the stored one is corrupt', async () => {
    const storage = new MemoryStorage();
    storage.setItem('golix.identity', '{"kty":"RSA"}');
    const identity = await loadIdentity(storage);
    expect((await loadIdentity(storage)).authId).toBe(identity.authId);
  });
});
