// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { demoSchema } from '../src/schema/demo.js';
import { App } from '../src/ui/app.js';

function mount(initialQuery = ''): HTMLElement {
  document.body.innerHTML = '<div id="app"></div>';
  const container = document.getElementById('app')!;
  new App(container, {
    source: { schema: demoSchema, origin: 'test schema' },
    initialQuery,
  });
  return container;
}

function organismSelect(container: HTMLElement): HTMLSelectElement {
  return container.querySelector('.context select')!;
}

function choose(el: HTMLSelectElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('change'));
}

function minimal(): string {
  return document.querySelector('.string-value')?.textContent ?? '';
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

  it('offers one filter row up front, with no value so the query stays empty', () => {
    const container = mount();
    expect(container.querySelectorAll('.filter')).toHaveLength(1);
    expect(container.querySelector('.filter .field-select')).not.toBeNull();
    expect(container.querySelectorAll('.diagnostic')).toHaveLength(0);
    expect(container.querySelector('.output .empty')?.textContent).toMatch(/Fill in a filter/);
  });

  it('adds a filter row when asked', () => {
    const container = mount();
    button(container, '+ filter').click();
    expect(document.querySelectorAll('.filter')).toHaveLength(2);
  });

  it('adds a nested group, itself carrying a filter row', () => {
    const container = mount();
    button(container, '+ group').click();
    expect(document.querySelectorAll('.group')).toHaveLength(2); // root plus the new one
    expect(document.querySelectorAll('.group:not(.root) .filter')).toHaveLength(1);
  });
});

describe('the field list follows the scope', () => {
  function families(container: HTMLElement): string[] {
    return [...container.querySelectorAll<HTMLOptionElement>('.field-select option')].map((o) => o.value);
  }

  it('offers no genotype field across a multi-organism scope', () => {
    const container = mount('organism=descendantOf=influenzaA;length.HA=ge=1600');
    expect(chips(container)).toEqual(['h5n1', 'h3n2', 'h1n1pdm']);
    expect(families(container)).toContain('length');
    for (const family of ['nuc', 'aa', 'nuc_ins', 'aa_ins']) {
      expect(families(container), family).not.toContain(family);
    }
  });

  it('offers them again once the query names one organism', () => {
    const container = mount('organism==h3n2;length.HA=ge=1600');
    expect(families(container)).toContain('nuc');
    expect(families(container)).toContain('aa');
  });
});

describe('range filters are one row with two bounds', () => {
  it('shows a from/to pair and writes both into the query', () => {
    const container = mount('organism==h3n2;length.HA=inRange=(1600,1700)');
    const bounds = [...container.querySelectorAll<HTMLInputElement>('.range-input .value-input')];
    expect(bounds.map((b) => b.value)).toEqual(['1600', '1700']);

    bounds[1]!.value = '1650';
    bounds[1]!.dispatchEvent(new Event('change'));
    expect(minimal()).toBe('organism==h3n2;length.HA=inRange=(1600,1650)');
  });

  it('treats a half-filled range as an incomplete filter, not an error', () => {
    const container = mount('organism==h3n2;length.HA=inRange=(1600,1700)');
    const bounds = [...container.querySelectorAll<HTMLInputElement>('.range-input .value-input')];
    bounds[1]!.value = '';
    bounds[1]!.dispatchEvent(new Event('change'));
    expect(document.querySelectorAll('.diagnostic')).toHaveLength(0);
    // It contributes nothing, so the query is the organism term alone.
    expect(minimal()).toBe('organism==h3n2');
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
    const container = mount('organism==h3n2;length.HA<=1700');
    const values = [...container.querySelectorAll('.string-value')].map((el) => el.textContent);
    expect(values).toEqual([
      'organism==h3n2;length.HA=le=1700',
      "organism=='h3n2';length.HA=le='1700'",
      'organism==h3n2;length.HA<=1700',
    ]);
    expect(container.querySelector('.string-output.unsafe .note')?.textContent).toMatch(/NOT URL-safe/);
  });

  it('reports the round-trip check', () => {
    const container = mount('host==duck');
    expect(container.querySelector('.roundtrip')?.className).toContain('ok');
  });

  it('shows the LAPIS class for a query the backend cannot run', () => {
    const container = mount("organism==sars2;(country==France,nuc.23403=='G')");
    expect(container.querySelector('.lapis')?.className).toContain('class-E');
  });

  it('explains why an unscoped genome field is rejected', () => {
    const container = mount("nuc.23403=='G'");
    expect(container.querySelector('.diagnostic .message')?.textContent).toMatch(
      /does not mean the same thing/,
    );
  });
});

describe('the organism select is a view over one query term (§7.2)', () => {
  it('writes a top-level organism== conjunct, and drops it again', () => {
    const container = mount('host==duck');
    choose(organismSelect(container), 'sars2');
    expect(minimal()).toBe('organism==sars2;host==duck');
    expect(chips(document.body)).toEqual(['sars2']);

    choose(organismSelect(document.body), '');
    expect(minimal()).toBe('host==duck');
  });

  it('reflects an organism the query already names', () => {
    const container = mount('organism==rsvA;host==human');
    expect(organismSelect(container).value).toBe('rsvA');
    expect(organismSelect(container).disabled).toBe(false);
  });

  it('steps aside when the organism constraint has no single-term reading', () => {
    const container = mount('organism=in=(sars2,rsvA);host==human');
    expect(organismSelect(container).disabled).toBe(true);
    expect(container.querySelector('.context-note')?.textContent).toMatch(/edit it as a filter row/);
    // The filter row still carries it, so the query is untouched.
    expect(minimal()).toBe('organism=in=(sars2,rsvA);host==human');
  });
});
