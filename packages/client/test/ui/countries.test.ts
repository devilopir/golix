import { describe, expect, it } from 'vitest';
import { countries, countryGeo } from '../../src/ui/countries.ts';
import { COUNTRY_CENTERS } from '../../src/ui/countryCenters.ts';

describe('country centers', () => {
  it('has a valid center for every listed country', () => {
    expect(countries()).toHaveLength(249);
    for (const [code, [lat, lon]] of Object.entries(COUNTRY_CENTERS)) {
      expect(code).toMatch(/^[a-z]{2}$/);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(lon)).toBeLessThanOrEqual(180);
    }
  });

  it('turns a country code into its center', () => {
    expect(countryGeo('tr')).toEqual({ lat: 39, lon: 35, code: 'tr' });
    expect(countryGeo('br')).toEqual({ lat: -10, lon: -55, code: 'br' });
    expect(countryGeo('xx')).toBeNull();
    expect(countryGeo('')).toBeNull();
  });
});
