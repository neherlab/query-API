import { describe, expect, it } from 'vitest';
import { buildQueryString, encodeQueryComponent } from '../src/ui/url.js';

describe('permalink serialisation keeps the syntax set literal', () => {
  it('leaves every §4 syntax character alone', () => {
    // `'` is absent: the URL parser escapes it for http(s) whatever we emit.
    expect(encodeQueryComponent(";,()!=.*:@-")).toBe(";,()!=.*:@-");
  });

  it('does not form-urlencode a realistic query', () => {
    const q = "country=(Switzerland,France);date=inRange=(2021-01-01,2022-01-01)";
    expect(buildQueryString([['q', q]])).toBe(`q=${q}`);
  });

  it('still escapes what would break parsing', () => {
    expect(encodeQueryComponent('a&b')).toBe('a%26b');
    expect(encodeQueryComponent('a#b')).toBe('a%23b');
    expect(encodeQueryComponent('a%b')).toBe('a%25b');
    expect(encodeQueryComponent('a+b')).toBe('a%2Bb');
    expect(encodeQueryComponent('a b')).toBe('a%20b');
  });

  it('round-trips through the reader in main.ts', () => {
    const q = "host='Homo sapiens';nuc_sub=(A123T,!G7*);count>=10";
    const parsed = new URLSearchParams(buildQueryString([['q', q]]));
    expect(parsed.get('q')).toBe(q);
  });

  it('drops empty entries and orders them for readability', () => {
    expect(buildQueryString([['schema', null], ['organism', 'sars2'], ['q', '']])).toBe(
      'organism=sars2',
    );
  });
});
