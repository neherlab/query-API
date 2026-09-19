import { type CompileResult, compile } from '../lang/index.js';
import { allowedOperators, operator } from '../lang/operators.js';
import {
  allTaxa,
  coreField,
  familiesInScope,
  type FieldDef,
  type Schema,
  type SlotDef,
} from '../lang/schema.js';
import type { SchemaSource } from '../schema/index.js';
import { clear, copy, h, select } from './dom.js';
import {
  type EditNode,
  emptyGroup,
  fieldDef,
  find,
  fromResolved,
  type FilterNode,
  type GroupNode,
  MATCH_MODES,
  modeOf,
  nextId,
  remove,
  toText,
  wrappersFor,
} from './model.js';

export interface AppOptions {
  source: SchemaSource;
  initialQuery: string;
  initialOrganism: string | null;
}

export class App {
  private schema: Schema;
  private pinned: string | null;
  private root: GroupNode = emptyGroup('and');
  private text = '';
  private result: CompileResult;
  private textarea: HTMLTextAreaElement;
  private readonly container: HTMLElement;

  constructor(container: HTMLElement, private readonly options: AppOptions) {
    this.container = container;
    this.schema = options.source.schema;
    this.pinned = options.initialOrganism;
    this.textarea = h('textarea', {
      class: 'query-input',
      spellcheck: 'false',
      rows: '3',
      placeholder: "host=='duck';collectionDate=ge=2024",
    });
    this.textarea.addEventListener('blur', () => this.applyText(this.textarea.value));
    this.textarea.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter' && !(ev as KeyboardEvent).shiftKey) {
        ev.preventDefault();
        this.applyText(this.textarea.value);
      }
    });

    this.result = compile('', { schema: this.schema, pinned: this.pinned });
    if (options.initialQuery) this.applyText(options.initialQuery, false);
    this.render();
  }

  /* --------------------------------- state --------------------------------- */

  private scope(): string[] {
    return this.result.scope.length > 0 ? this.result.scope : this.schema.organisms.map((o) => o.id);
  }

  /** Model is the source of truth; the string is derived from it. */
  private syncFromModel(): void {
    this.text = toText(this.root, this.schema, this.scope());
    this.result = compile(this.text, { schema: this.schema, pinned: this.pinned });
    this.persist();
    this.render();
  }

  /** Import: a string replaces the model, but only if it resolves (spec §14.1.1). */
  private applyText(text: string, rerender = true): void {
    const result = compile(text, { schema: this.schema, pinned: this.pinned });
    this.result = result;
    this.text = text;
    if (result.ok && result.resolved) {
      const imported = fromResolved(result.resolved);
      this.root = imported.kind === 'group' ? imported : { ...emptyGroup('and'), children: [imported] };
      this.text = result.minimal;
      this.result = compile(this.text, { schema: this.schema, pinned: this.pinned });
    }
    this.persist();
    if (rerender) this.render();
  }

  private persist(): void {
    const params = new URLSearchParams(window.location.search);
    if (this.text) params.set('q', this.text);
    else params.delete('q');
    if (this.pinned) params.set('organism', this.pinned);
    else params.delete('organism');
    const query = params.toString();
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  }

  /* --------------------------------- view ---------------------------------- */

  private render(): void {
    clear(this.container);
    this.container.append(this.header(), this.builderPanel(), this.outputPanel());
    if (document.activeElement !== this.textarea) this.textarea.value = this.text;
  }

  private header(): HTMLElement {
    const organisms = [
      { value: '', label: 'all organisms' },
      ...this.schema.organisms.map((o) => ({ value: o.id, label: o.label })),
    ];
    return h(
      'header',
      { class: 'app-header' },
      h('div', { class: 'title' }, h('h1', { text: 'Sequence query builder' }), h('span', { class: 'version', text: `language ${this.result.json.languageVersion}` })),
      h(
        'div',
        { class: 'context' },
        h('label', { text: 'Organism context' }),
        select(organisms, this.pinned ?? '', (value) => {
          this.pinned = value === '' ? null : value;
          this.syncFromModel();
        }),
        h('span', {
          class: 'schema-origin',
          text: this.options.source.error
            ? `${this.options.source.error} — using the demo schema`
            : `schema: ${this.options.source.origin}`,
        }),
      ),
    );
  }

  private builderPanel(): HTMLElement {
    return h(
      'section',
      { class: 'panel builder' },
      h('h2', { text: 'Filters' }),
      this.scopeIndicator(),
      this.groupView(this.root, true),
      h('div', { class: 'query-editor' },
        h('label', { text: 'Query string — paste one here to load it into the builder' }),
        this.textarea,
        h('button', { class: 'ghost', text: 'Apply', onclick: () => this.applyText(this.textarea.value) }),
      ),
      this.diagnosticsView(),
    );
  }

  /**
   * The scope indicator is the key feedback for cross-organism work: it explains why an
   * organism-scoped field is unavailable and what would make it available (spec §14.1.4).
   */
  private scopeIndicator(): HTMLElement {
    const scope = this.result.scope;
    const all = this.schema.organisms.length;
    const note =
      scope.length === 0
        ? 'no organism matches these filters'
        : scope.length === all
          ? 'core fields only — genome fields need a narrower organism filter'
          : scope.length === 1
            ? 'all fields of this organism are available'
            : 'fields that resolve identically across these organisms are available';
    return h(
      'div',
      { class: 'scope' },
      h('span', { class: 'scope-label', text: 'Scope' }),
      h('span', { class: 'chips' }, ...scope.map((id) => h('span', { class: 'chip', text: id }))),
      h('span', { class: 'scope-note', text: note }),
    );
  }

  private groupView(group: GroupNode, isRoot: boolean): HTMLElement {
    const header = h(
      'div',
      { class: 'row group-header' },
      select(
        [
          { value: 'and', label: 'all of (AND)' },
          { value: 'or', label: 'any of (OR)' },
        ],
        group.op,
        (value) => {
          group.op = value as 'and' | 'or';
          this.syncFromModel();
        },
        { class: 'op-select' },
      ),
      this.matchModeSelect(group),
      h('button', { class: 'ghost', text: '+ filter', onclick: () => this.addFilter(group) }),
      h('button', { class: 'ghost', text: '+ group', onclick: () => this.addGroup(group) }),
      !isRoot && h('button', { class: 'ghost danger', text: 'remove', onclick: () => this.removeNode(group.id) }),
    );

    const children = group.children.map((child) =>
      child.kind === 'group' ? this.groupView(child, false) : this.filterView(child),
    );

    return h(
      'div',
      { class: `group ${group.op}${isRoot ? ' root' : ''}` },
      header,
      children.length
        ? h('div', { class: 'children' }, ...children)
        : h('p', { class: 'empty', text: 'No filters yet.' }),
    );
  }

  private filterView(filter: FilterNode): HTMLElement {
    const scope = this.scope();
    const def = fieldDef(this.schema, filter.family, scope);
    const row = h('div', { class: 'row filter' });

    row.append(this.matchModeSelect(filter), this.fieldSelect(filter, scope));

    if (!def) {
      row.append(h('span', { class: 'error-inline', text: `unknown field '${filter.family}'` }));
      row.append(h('button', { class: 'ghost danger', text: '×', onclick: () => this.removeNode(filter.id) }));
      return row;
    }

    for (const slot of def.slots ?? []) row.append(this.slotInput(filter, slot));

    const ops = allowedOperators(def);
    row.append(
      select(
        ops.map((op) => ({ value: op.name, label: `${op.spell}  ${op.label}` })),
        filter.op,
        (value) => {
          filter.op = value;
          const opDef = operator(value);
          if (opDef?.booleanArg && !['true', 'false'].includes(filter.values[0] ?? '')) filter.values = ['true'];
          this.syncFromModel();
        },
        { class: 'op-select' },
      ),
      this.valueInput(filter, def),
      h('button', { class: 'ghost danger', text: '×', title: 'remove', onclick: () => this.removeNode(filter.id) }),
    );

    if (def.description) row.append(h('span', { class: 'hint', text: def.description }));
    return row;
  }

  private matchModeSelect(node: EditNode): HTMLSelectElement {
    const mode = modeOf(node.wrappers);
    const options = MATCH_MODES.map((m) => ({ value: m.value, label: m.label }));
    if (mode === 'custom') options.push({ value: 'custom', label: node.wrappers.join(' of ') || 'custom' });
    const el = select(options, mode, (value) => {
      if (value === 'custom') return;
      node.wrappers = wrappersFor(value);
      this.syncFromModel();
    }, { class: 'mode-select' });
    el.title = MATCH_MODES.find((m) => m.value === mode)?.hint ?? 'custom wrapper chain';
    return el;
  }

  private fieldSelect(filter: FilterNode, scope: string[]): HTMLSelectElement {
    const available = familiesInScope(this.schema, scope);
    const core = new Set(this.schema.coreFields.map((f) => f.family));
    const el = h('select', {
      class: 'field-select',
      onchange: (ev) => {
        const family = (ev.target as HTMLSelectElement).value;
        const def = fieldDef(this.schema, family, scope);
        filter.family = family;
        filter.slots = defaultSlots(def);
        filter.op = def ? (allowedOperators(def)[0]?.name ?? 'eq') : 'eq';
        filter.values = [''];
        this.syncFromModel();
      },
    });

    const coreGroup = h('optgroup', { label: 'core fields (all organisms)' });
    const scopedGroup = h('optgroup', { label: 'organism fields (in scope)' });
    for (const def of available) {
      const option = h('option', { value: def.family, text: def.label ?? def.family });
      if (def.family === filter.family) option.selected = true;
      (core.has(def.family) ? coreGroup : scopedGroup).append(option);
    }
    el.append(coreGroup);
    if (scopedGroup.childElementCount > 0) el.append(scopedGroup);

    // Keep a field that is no longer in scope visible, so narrowing the organism does not
    // silently rewrite the query.
    if (!available.some((d) => d.family === filter.family)) {
      const orphan = h('optgroup', { label: 'not available in this scope' });
      orphan.append(h('option', { value: filter.family, text: filter.family, selected: true }));
      el.append(orphan);
    }
    return el;
  }

  private slotInput(filter: FilterNode, slot: SlotDef): HTMLElement {
    const current = filter.slots[slot.name] ?? '';
    if (slot.kind === 'pos') {
      const input = h('input', {
        class: 'slot-input pos',
        type: 'number',
        min: '1',
        placeholder: 'position',
        value: current,
        title: `${slot.name} (1-based, alignment coordinates)`,
      });
      input.addEventListener('change', () => {
        filter.slots[slot.name] = input.value;
        this.syncFromModel();
      });
      return input;
    }
    const options = (slot.values ?? []).map((value) => ({ value, label: value }));
    return select([{ value: '', label: slot.name }, ...options], current, (value) => {
      filter.slots[slot.name] = value;
      this.syncFromModel();
    }, { class: 'slot-input', title: slot.name });
  }

  private valueInput(filter: FilterNode, def: FieldDef): HTMLElement {
    const opDef = operator(filter.op);

    if (opDef?.booleanArg) {
      return select(
        [
          { value: 'true', label: 'true' },
          { value: 'false', label: 'false' },
        ],
        filter.values[0] ?? 'true',
        (value) => {
          filter.values = [value];
          this.syncFromModel();
        },
        { class: 'value-input' },
      );
    }

    if (def.type === 'enum' && !opDef?.list) {
      return select(
        [{ value: '', label: '—' }, ...(def.values ?? []).map((v) => ({ value: v, label: v }))],
        filter.values[0] ?? '',
        (value) => {
          filter.values = [value];
          this.syncFromModel();
        },
        { class: 'value-input' },
      );
    }

    const input = h('input', {
      class: 'value-input',
      type: 'text',
      value: opDef?.list ? filter.values.join(',') : (filter.values[0] ?? ''),
      placeholder: placeholderFor(def, Boolean(opDef?.list)),
      spellcheck: 'false',
    });

    const suggestions = suggestionsFor(this.schema, def);
    if (suggestions.length > 0) {
      const listId = `dl-${filter.id}`;
      input.setAttribute('list', listId);
      const datalist = h('datalist', { id: listId });
      for (const value of suggestions) datalist.append(h('option', { value }));
      input.after(datalist);
      const wrapper = h('span', { class: 'value-wrapper' }, input, datalist);
      input.addEventListener('change', () => {
        filter.values = opDef?.list ? input.value.split(',').map((v) => v.trim()) : [input.value];
        this.syncFromModel();
      });
      return wrapper;
    }

    input.addEventListener('change', () => {
      filter.values = opDef?.list ? input.value.split(',').map((v) => v.trim()) : [input.value];
      this.syncFromModel();
    });
    return input;
  }

  private diagnosticsView(): HTMLElement {
    if (this.result.diagnostics.length === 0) return h('div', { class: 'diagnostics empty' });
    return h(
      'div',
      { class: 'diagnostics' },
      ...this.result.diagnostics.map((d) =>
        h(
          'div',
          {
            class: 'diagnostic',
            onclick: () => {
              this.textarea.focus();
              this.textarea.setSelectionRange(d.span.start, d.span.end);
            },
          },
          h('span', { class: 'phase', text: d.phase }),
          h('span', { class: 'message', text: d.message }),
          h('span', { class: 'at', text: `at ${d.span.start}–${d.span.end}` }),
          d.hint && h('span', { class: 'hint', text: d.hint }),
        ),
      ),
    );
  }

  /* -------------------------------- outputs -------------------------------- */

  private outputPanel(): HTMLElement {
    const { result } = this;
    const panel = h('section', { class: 'panel output' }, h('h2', { text: 'Output' }));

    if (!result.ok) {
      panel.append(h('p', { class: 'empty', text: 'Fix the errors above to see the canonical strings.' }));
      return panel;
    }

    panel.append(
      this.stringOutput('Minimal', result.minimal, 'shortest form, URL-safe'),
      this.stringOutput('Strict', result.strict, 'self-contained, URL-safe'),
      this.stringOutput('Readable', result.readable, 'display only — NOT URL-safe (§13)', true),
      this.roundTripView(),
      this.jsonView('AST (canonical output)', result.json),
      this.lapisView(),
    );
    return panel;
  }

  private stringOutput(label: string, value: string, note: string, unsafe = false): HTMLElement {
    const button = h('button', { class: 'ghost', text: 'copy' });
    button.addEventListener('click', () => void copy(value, button));
    return h(
      'div',
      { class: `string-output${unsafe ? ' unsafe' : ''}` },
      h('div', { class: 'string-head' }, h('span', { class: 'label', text: label }), h('span', { class: 'note', text: note }), button),
      h('code', { class: 'string-value', text: value || '(empty)' }),
    );
  }

  private roundTripView(): HTMLElement {
    const { roundTrip } = this.result;
    return h(
      'div',
      { class: `roundtrip ${roundTrip.ok ? 'ok' : 'bad'}` },
      h('span', { text: roundTrip.ok ? '✓ round-trip check passed' : '✗ round-trip check failed' }),
      ...roundTrip.failures.map((f) => h('div', { class: 'failure', text: f })),
    );
  }

  private jsonView(label: string, value: unknown): HTMLElement {
    const text = JSON.stringify(value, null, 2);
    const button = h('button', { class: 'ghost', text: 'copy' });
    button.addEventListener('click', () => void copy(text, button));
    return h(
      'details',
      { class: 'json', open: true },
      h('summary', {}, h('span', { text: label }), button),
      h('pre', { text }),
    );
  }

  private lapisView(): HTMLElement {
    const { lapis } = this.result;
    const body = h(
      'div',
      { class: `lapis class-${lapis.klass}` },
      h('div', { class: 'lapis-head' }, h('span', { class: 'badge', text: `Class ${lapis.klass}` }), h('span', { text: lapis.summary })),
      ...lapis.warnings.map((w) => h('div', { class: 'warning', text: w })),
    );
    if (!lapis.unsupported) {
      body.append(h('pre', { text: JSON.stringify(lapis.requests, null, 2) }));
    }
    return h(
      'details',
      { class: 'json' },
      h('summary', {}, h('span', { text: 'LAPIS target (provisional — see spec §11.2)' })),
      body,
    );
  }

  /* ------------------------------- mutations ------------------------------- */

  private addFilter(group: GroupNode): void {
    const scope = this.scope();
    const available = familiesInScope(this.schema, scope);
    const def = available[0];
    group.children.push({
      id: nextId(),
      kind: 'filter',
      wrappers: [],
      family: def?.family ?? 'accession',
      slots: defaultSlots(def),
      op: def ? (allowedOperators(def)[0]?.name ?? 'eq') : 'eq',
      values: [''],
    });
    this.syncFromModel();
  }

  private addGroup(group: GroupNode): void {
    group.children.push(emptyGroup(group.op === 'and' ? 'or' : 'and'));
    this.syncFromModel();
  }

  private removeNode(id: string): void {
    if (find(this.root, id) === this.root) return;
    remove(this.root, id);
    this.syncFromModel();
  }
}

/* --------------------------------- helpers --------------------------------- */

function defaultSlots(def: FieldDef | undefined): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const slot of def?.slots ?? []) {
    if (slot.default !== undefined) slots[slot.name] = slot.default;
    else if (slot.values?.length === 1) slots[slot.name] = slot.values[0]!;
    else slots[slot.name] = '';
  }
  return slots;
}

function placeholderFor(def: FieldDef, list: boolean): string {
  if (list) return 'comma, separated, values';
  switch (def.type) {
    case 'date':
      return 'YYYY, YYYY-MM or YYYY-MM-DD';
    case 'sequenceState':
      return "A, -, or ref";
    case 'integer':
    case 'number':
      return 'number';
    default:
      return 'value';
  }
}

function suggestionsFor(schema: Schema, def: FieldDef): string[] {
  if (def.type === 'hierarchical') {
    const hierarchy = schema.hierarchies[def.hierarchy ?? ''];
    if (!hierarchy) return [];
    return [...allTaxa(hierarchy.roots), ...Object.keys(hierarchy.aliases ?? {})];
  }
  if (def.type === 'enum') return def.values ?? [];
  return [];
}

export { coreField };
