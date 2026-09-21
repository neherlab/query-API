/**
 * Query-string serialisation for permalinks.
 *
 * `URLSearchParams.toString()` uses the `application/x-www-form-urlencoded`
 * serialiser, which escapes everything outside `[A-Za-z0-9*_.-]` — so a query
 * term like `country=Switzerland,France` comes out as
 * `country%3DSwitzerland%2CFrance`. That defeats spec §4, which picks the
 * syntax characters precisely so a query survives in a URL unencoded.
 *
 * RFC 3986 allows far more in the query component, so we serialise by hand and
 * only escape what would actually break: the `&` separator, `#` (fragment),
 * `%` (escape introducer), `+` (decoded as space by the reader), and anything
 * the WHATWG URL parser would reject or rewrite.
 *
 * Note the one character we cannot keep literal: for special schemes (http,
 * https) the URL parser escapes `'` to `%27` on its own, so quoted values
 * always show as `%27…%27` in the address bar. Nothing on our side can
 * prevent that.
 */

/**
 * Characters `encodeURIComponent` escapes that are nonetheless legal, literal
 * and unambiguous inside a query component — restore them after encoding.
 * Deliberately excludes `&` `+` (reader-visible) and `#` (ends the query).
 */
const RESTORED = [
  ['%2C', ','],
  ['%3D', '='],
  ['%3A', ':'],
  ['%40', '@'],
  ['%3B', ';'],
  ['%24', '$'],
  ['%2F', '/'],
  ['%3F', '?'],
] as const;

/** Percent-encode a key or value, keeping the URL-safe syntax set (§4) literal. */
export function encodeQueryComponent(value: string): string {
  let out = encodeURIComponent(value);
  for (const [escaped, literal] of RESTORED) out = out.replaceAll(escaped, literal);
  return out;
}

/**
 * Build a `key=value&key=value` query string. Entries with a null or empty
 * value are dropped. Returns '' when nothing is left.
 */
export function buildQueryString(entries: Iterable<readonly [string, string | null]>): string {
  const parts: string[] = [];
  for (const [key, value] of entries) {
    if (value === null || value === '') continue;
    parts.push(`${encodeQueryComponent(key)}=${encodeQueryComponent(value)}`);
  }
  return parts.join('&');
}
