/**
 * Partial dates denote an interval, in the stored value and in the query alike (spec §9.1, §9.2).
 * Lives on its own because both resolution and evaluation need the bounds.
 */
export function interval(text: string): [string, string] {
  const [y, m, d] = text.split('-');
  if (d !== undefined) return [text, text];
  if (m !== undefined) {
    const last = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
    return [`${y}-${m}-01`, `${y}-${m}-${String(last).padStart(2, '0')}`];
  }
  return [`${y}-01-01`, `${y}-12-31`];
}
