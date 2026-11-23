import { defaultStadiums, parseStadium } from '@golix/shared';
import type { KeyValueStorage } from '../settings/settings.ts';

export interface StoredStadium {
  name: string;
  source: string;
}

const STORAGE_KEY = 'golix.stadiums';

export class StadiumStore {
  constructor(private readonly storage: KeyValueStorage) {}

  list(): StoredStadium[] {
    try {
      const parsed: unknown = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (s): s is StoredStadium => typeof s?.name === 'string' && typeof s?.source === 'string',
      );
    } catch {
      return [];
    }
  }

  /** Throws when storage rejects the write. */
  add(stadium: StoredStadium): void {
    this.write([...this.list(), stadium]);
  }

  remove(index: number): void {
    const list = this.list();
    list.splice(index, 1);
    this.write(list);
  }

  private write(list: StoredStadium[]): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(list));
  }
}

export function isDefaultStadium(source: string): boolean {
  return defaultStadiums.some((s) => s.source === source);
}

let named = { source: '', name: '' };

/** Remembers the last answer: parsing a large custom stadium takes milliseconds. */
export function stadiumName(source: string): string {
  if (named.source !== source) named = { source, name: defaultStadiums.find((s) => s.source === source)?.name ?? parseStadium(source).name };
  return named.name;
}

/** FNV-1a over UTF-16 code units, as 8 uppercase hex digits. */
export function stadiumChecksum(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export function downloadFile(filename: string, data: string | Uint8Array<ArrayBuffer>): void {
  const url = URL.createObjectURL(new Blob([data], { type: typeof data === 'string' ? 'text/plain' : 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
