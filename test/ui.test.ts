// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { demoSchema } from '../src/schema/demo.js';
import { App } from '../src/ui/app.js';

function mount(initialQuery = '', initialOrganism: string | null = null): HTMLElement {
  document.body.innerHTML = '<div id="app"></div>';
  const container = document.getElementById('app')!;
  new App(container, {
    source: { schema: demoSchema, origin: 'test schema' },
    initialQuery,
    initialOrganism,
  });
  return container;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!match) throw new Error(`no button labelled '${label}'`);
  return match;
}

function chips(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.chip')].map((el) => el.textContent ?? '');
}

describe('the app mounts and builds', () => {
  it('starts empty with every organism in scope', () => {
    const container = mount();
    expect(container.querySelector('h1')?.textContent).toBe('Sequence query builder');
    expect(chips(container)).toEqual(['h5n1', 'h3n2', 'h1n1pdm', 'sars2', 'rsvA', 'rsvB']);
    expect(container.querySelector('.scope-note')?.textContent).toMatch(/core fields only/);
  });

  it('adds a filter row when asked', () => {
    const container = mount();
    expect(container.querySelectorAll('.filter')).toHaveLength(0);
    button(container, '+ filter').click();
    expect(document.querySelectorAll('.filter')).toHaveLength(1);
  });

  it('adds a nested group', () => {
    const container = mount();
    button(container, '+ group').click();
    expect(document.querySelectorAll('.group')).toHaveLength(2); // root plus the new one
  });
});

describe('import populates the builder (§14.1.1)', () => {
  it('rebuilds the tree from a pasted string', () => {
    const container = mount("organism==sars2;nuc.23403=='G'");
    expect(container.querySelectorAll('.filter')).toHaveLength(2);
    expect(chips(container)).toEqual(['sars2']);
    expect(container.querySelector('.string-value')?.textContent).toBe('organism==sars2;nuc.23403==G');
  });

  it('applies a string typed into the editor on blur', () => {
    const container = mount();
    const textarea = container.querySelector('textarea')!;
    textarea.value = 'host==duck;collectionDate=ge=2024';
    textarea.dispatchEvent(new Event('blur'));
    expect(document.querySelectorAll('.filter')).toHaveLength(2);
    expect(document.querySelector('.string-value')?.textContent).toBe('host==duck;collectionDate=ge=2024');
  });

  it('leaves the model alone when the string does not resolve', () => {
    const container = mount('host==duck');
    const textarea = container.querySelector('textarea')!;
    textarea.value = 'country==Frnace';
    textarea.dispatchEvent(new Event('blur'));
    const diagnostic = document.querySelector('.diagnostic');
    expect(diagnostic?.textContent).toMatch(/is not a known country/);
    expect(document.querySelectorAll('.filter')).toHaveLength(1); // still the host filter
  });
});

describe('output panel', () => {
  it('shows all three renderings and marks the readable one as unsafe', () => {
    const container = mount('length.HA<=1700', 'h3n2');
    const values = [...container.querySelectorAll('.string-value')].map((el) => el.textContent);
    expect(values).toEqual([
      'length.HA=le=1700',
      "organism=='h3n2';length.HA=le='1700'",
      'length.HA<=1700',
    ]);
    expect(container.querySelector('.string-output.unsafe .note')?.textContent).toMatch(/NOT URL-safe/);
  });

  it('reports the round-trip check', () => {
    const container = mount('host==duck');
    expect(container.querySelector('.roundtrip')?.className).toContain('ok');
  });

  it('shows the LAPIS class for a query the backend cannot run', () => {
    const container = mount("country==France,nuc.23403=='G'", 'sars2');
    expect(container.querySelector('.lapis')?.className).toContain('class-E');
  });

  it('explains why an unscoped genome field is rejected', () => {
    const container = mount("nuc.23403=='G'");
    expect(container.querySelector('.diagnostic .message')?.textContent).toMatch(
      /does not mean the same thing/,
    );
  });
});
