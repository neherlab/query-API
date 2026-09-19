type Child = Node | string | null | undefined | false;

interface Attrs {
  [key: string]: unknown;
  class?: string;
  text?: string;
  onclick?: (ev: MouseEvent) => void;
  onchange?: (ev: Event) => void;
  oninput?: (ev: Event) => void;
}

/** Minimal element helper; the app re-renders whole panels rather than diffing. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') el.textContent = String(value);
    else if (key === 'class') el.className = String(value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value as EventListener);
    else if (key === 'value' && el instanceof HTMLInputElement) el.value = String(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function select(
  options: Array<{ value: string; label: string; disabled?: boolean }>,
  current: string,
  onchange: (value: string) => void,
  attrs: Attrs = {},
): HTMLSelectElement {
  const el = h('select', { ...attrs, onchange: (ev) => onchange((ev.target as HTMLSelectElement).value) });
  for (const option of options) {
    const opt = h('option', { value: option.value, text: option.label });
    if (option.disabled) opt.disabled = true;
    if (option.value === current) opt.selected = true;
    el.append(opt);
  }
  return el;
}

export async function copy(text: string, button: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = 'copied';
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  } catch {
    button.textContent = 'copy failed';
  }
}
