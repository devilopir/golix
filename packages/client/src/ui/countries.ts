import type { Geo } from '../settings/settings.ts';
import { COUNTRY_CENTERS } from './countryCenters.ts';

export interface Country {
  code: string;
  name: string;
}

let cached: Country[] | null = null;

/** ISO 3166-1 alpha-2 countries with English names, sorted by name. */
export function countries(): Country[] {
  if (cached !== null) return cached;
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  cached = Object.keys(COUNTRY_CENTERS)
    .map((code) => ({ code, name: names.of(code.toUpperCase()) ?? code.toUpperCase() }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return cached;
}

/** The country's center, or null for a code outside ISO 3166-1. */
export function countryGeo(code: string): Geo | null {
  if (!Object.hasOwn(COUNTRY_CENTERS, code)) return null;
  const [lat, lon] = COUNTRY_CENTERS[code];
  return { lat, lon, code };
}

/** Regional-indicator pair for a two-letter code; the OS draws it as a flag. */
export function flagEmoji(code: string): string {
  if (!/^[a-z]{2}$/i.test(code)) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}
