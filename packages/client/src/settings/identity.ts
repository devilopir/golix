import type { KeyValueStorage } from './settings.ts';

const STORAGE_KEY = 'golix.identity';
const ALGORITHM: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' };

export interface Identity {
  /** base64url of the uncompressed P-256 public point; servers import it to verify signatures. */
  authId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function importStored(raw: string): Promise<CryptoKeyPair> {
  const jwk = JSON.parse(raw) as JsonWebKey;
  const { d, ...publicJwk } = jwk;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof d !== 'string') throw new Error('Unexpected key format');
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey('jwk', jwk, ALGORITHM, false, ['sign']),
    crypto.subtle.importKey('jwk', { ...publicJwk, key_ops: ['verify'] }, ALGORITHM, true, ['verify']),
  ]);
  return { privateKey, publicKey };
}

async function generate(storage: KeyValueStorage): Promise<CryptoKeyPair> {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(jwk));
  } catch {
    // Without storage the identity lasts for this session only.
  }
  return pair;
}

/** Loads the persisted key pair, generating and storing a new one if missing or unreadable. */
export async function loadIdentity(storage: KeyValueStorage): Promise<Identity> {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  const pair = await (raw === null ? generate(storage) : importStored(raw).catch(() => generate(storage)));
  const authId = base64url(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { authId, ...pair };
}

/** Signs the server's join challenge; the server checks it against the auth id. */
export async function signNonce(identity: Identity, nonce: string): Promise<string> {
  return base64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, new TextEncoder().encode(nonce)));
}
