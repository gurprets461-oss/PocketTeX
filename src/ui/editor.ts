// CodeMirror 6 editor: LaTeX highlighting (legacy stex mode), completions for
// commands/labels/citations/files, snippets, autosave and the mobile accessory bar.
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  highlightSpecialChars,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
  cursorCharLeft,
  cursorCharRight,
  indentMore,
} from '@codemirror/commands';
import { StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching, indentUnit } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  autocompletion,
  completionKeymap,
  snippet,
  nextSnippetField,
  hasNextSnippetField,
  type CompletionContext,
  type CompletionResult,
  type Completion,
} from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { h } from './dom.ts';
import { BAR_KEYS, COMMANDS, ENVIRONMENTS } from '../latex/snippets.ts';

export interface CompletionData {
  labels: string[];
  citeKeys: string[];
  files: string[];
}

const highlight = HighlightStyle.define([
  { tag: t.tagName, color: 'var(--cm-command)' },
  { tag: t.keyword, color: 'var(--cm-math)', fontWeight: '600' },
  { tag: t.atom, color: 'var(--cm-atom)' },
  { tag: t.comment, color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: t.number, color: 'var(--cm-number)' },
  { tag: t.bracket, color: 'var(--cm-bracket)' },
  { tag: [t.string, t.special(t.variableName)], color: 'var(--cm-string)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font-size, 15px)', backgroundColor: 'var(--bg)', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5', overscrollBehavior: 'contain' },
  '.cm-content': { paddingBottom: '40vh', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-subtle)', color: 'var(--fg-muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-tooltip': { backgroundColor: 'var(--bg-raised)', color: 'var(--fg)', border: '1px solid var(--border)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: '#fff' },
  '.cm-panels': { backgroundColor: 'var(--bg-subtle)', color: 'var(--fg)' },
  '.cm-snippetField': { backgroundColor: 'var(--snippet-field)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--selection)', outline: 'none' },
});

function argumentCompletion(ctx: CompletionContext, data: () => CompletionData): CompletionResult | null {
  const before = ctx.matchBefore(/\\([A-Za-z]+)\*?(\[[^\]]*\])?\{([^}{\\]*)$/);
  if (!before) return null;
  const m = /\\([A-Za-z]+)\*?(?:\[[^\]]*\])?\{([^}{\\]*)$/.exec(before.text)!;
  const cmd = m[1];
  const typed = m[2];
  // For comma lists (\cite{a,b}) complete only the last item.
  const lastComma = typed.lastIndexOf(',');
  const from = before.to - typed.length + (lastComma + 1);
  const d = data();
  let options: Completion[] = [];
  if (/^(c|C|eq|auto|page|name|v)?ref$|^cref$/.test(cmd)) {
    options = d.labels.map((l) => ({ label: l, type: 'variable' }));
  } else if (/cite/i.test(cmd)) {
    options = d.citeKeys.map((k) => ({ label: k, type: 'constant' }));
  } else if (cmd === 'begin' || cmd === 'end') {
    options = ENVIRONMENTS.map((e) => ({ label: e, type: 'type' }));
  } else if (cmd === 'includegraphics') {
    options = d.files.filter((f) => /\.(png|jpe?g|pdf)$/i.test(f)).map((f) => ({ label: f, type: 'text' }));
  } else if (cmd === 'input' || cmd === 'include') {
    options = d.files.filter((f) => /\.tex$/i.test(f)).map((f) => ({ label: f.replace(/\.tex$/, ''), type: 'text' }));
  } else if (cmd === 'bibliography' || cmd === 'addbibresource') {
    options = d.files.filter((f) => /\.bib$/i.test(f)).map((f) => ({ label: cmd === 'bibliography' ? f.replace(/\.bib$/, '') : f, type: 'text' }));
  } else {
    return null;
  }
  return { from, options, validFor: /^[^},\\]*$/ };
}

function commandCompletion(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/\\[A-Za-z]*$/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const options: Completion[] = COMMANDS.map(([name, tpl]) => ({
    label: '\\' + name,
    type: 'keyword',
    apply: tpl ? snippet(tpl) : '\\' + name,
    boost: tpl ? 1 : 0,
  }));
  options.push(
    ...ENVIRONMENTS.map((env) => ({
      label: '\\begin{' + env + '}',
      type: 'class',
      apply: snippet('\\begin{' + env + '}\n\t${}\n\\end{' + env + '}'),
      boost: -1,
    })),
  );
  return { from: word.from, options, validFor: /^\\[A-Za-z]*$/ };
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem('pockettex.' + key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem('pockettex.' + key, value);
  } catch {
    /* private mode: not remembered */
  }
}

export class Editor {
  readonly root: HTMLElement;
  readonly head: HTMLElement;
  private host: HTMLElement;
  private view: EditorView;
  private states = new Map<string, EditorState>();
  private currentPath: string | null = null;
  private saveTimer: number | undefined;
  private dirty = false;
  private extensions: Extension[];

  constructor(
    private save: (path: string, text: string) => Promise<void>,
    private completionData: () => CompletionData,
    private shortcuts: { compile: () => void },
  ) {
    this.head = h('div', { class: 'pane-head editor-head' });
    this.host = h('div', { class: 'cm-host' });
    const bar = h(
      'div',
      { class: 'accessory', role: 'toolbar', 'aria-label': 'LaTeX keys' },
      BAR_KEYS.map((k) =>
        h(
          'button',
          {
            type: 'button',
            class: 'key' + (k.wide ? ' wide' : ''),
            title: k.title,
            'aria-label': k.title,
            // Keep focus (and the on-screen keyboard) in the editor.
            onpointerdown: (e: Event) => e.preventDefault(),
            onmousedown: (e: Event) => e.preventDefault(),
            onclick: () => this.barKey(k),
          },
          k.label,
        ),
      ),
    );
    this.root = h('div', { class: 'editor' }, this.head, this.host, bar);
    const fontBtn = (label: string, delta: number) =>
      h('button', { type: 'button', class: 'icon-btn font-btn', title: `Text size ${delta > 0 ? '+' : '−'}`, 'aria-label': `Text size ${delta > 0 ? 'larger' : 'smaller'}`, onclick: () => this.setFontSize(this.fontSize + delta) }, label);
    this.head.append(fontBtn('A−', -1), fontBtn('A+', 1));
    this.setFontSize(Number(readPref('fontSize')) || 14);

    this.extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      StreamLanguage.define(stex),
      syntaxHighlighting(highlight),
      indentUnit.of('  '),
      EditorView.lineWrapping,
      autocompletion({
        override: [commandCompletion, (ctx) => argumentCompletion(ctx, this.completionData)],
        icons: false,
      }),
      keymap.of([
        { key: 'Mod-s', run: () => (this.flush(), true), preventDefault: true },
        { key: 'Mod-Enter', run: () => (this.shortcuts.compile(), true) },
        ...completionKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.contentAttributes.of({
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        'aria-label': 'LaTeX source',
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) this.scheduleSave();
      }),
      theme,
    ];
    this.view = new EditorView({ parent: this.host, state: EditorState.create({ doc: '', extensions: this.extensions }) });
    this.view.contentDOM.setAttribute('data-testid', 'editor');
    window.addEventListener('pagehide', () => this.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush();
    });
  }

  private fontSize = 14;

  setFontSize(px: number) {
    this.fontSize = Math.min(22, Math.max(11, px));
    this.root.style.setProperty('--editor-font-size', this.fontSize + 'px');
    writePref('fontSize', String(this.fontSize));
    this.view?.requestMeasure();
  }

  get path(): string | null {
    return this.currentPath;
  }

  /** Show a file; keeps per-file undo history while the project stays open. */
  async open(path: string, text: string, opts: { keepState?: boolean } = {}) {
    await this.flush();
    if (this.currentPath) this.states.set(this.currentPath, this.view.state);
    let state = opts.keepState !== false ? this.states.get(path) : undefined;
    if (!state || state.doc.toString() !== text) {
      state = EditorState.create({ doc: text, extensions: this.extensions });
    }
    this.currentPath = path;
    this.view.setState(state);
  }

  /** Forget cached states (when switching projects). */
  clear() {
    this.states.clear();
    this.currentPath = null;
    this.view.setState(EditorState.create({ doc: '', extensions: this.extensions }));
  }

  forget(path: string) {
    this.states.delete(path);
  }

  text(): string {
    return this.view.state.doc.toString();
  }

  gotoLine(line: number) {
    const doc = this.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
    this.view.dispatch({
      selection: { anchor: l.from, head: l.to },
      effects: EditorView.scrollIntoView(l.from, { y: 'center' }),
    });
    this.view.focus();
  }

  focus() {
    this.view.focus();
  }

  insertSnippet(template: string) {
    const { from, to } = this.view.state.selection.main;
    snippet(template)(this.view, { label: '' } as Completion, from, to);
    this.view.focus();
  }

  private barKey(k: (typeof BAR_KEYS)[number]) {
    const view = this.view;
    if (k.snippet) return this.insertSnippet(k.snippet);
    if (k.insert) {
      view.dispatch(view.state.replaceSelection(k.insert), { scrollIntoView: true, userEvent: 'input.type' });
    } else if (k.action === 'left') cursorCharLeft(view);
    else if (k.action === 'right') cursorCharRight(view);
    else if (k.action === 'undo') undo(view);
    else if (k.action === 'redo') redo(view);
    else if (k.action === 'tab') {
      if (hasNextSnippetField(view.state)) nextSnippetField(view);
      else indentMore(view);
    }
    if (!view.hasFocus) view.focus();
  }

  private scheduleSave() {
    this.dirty = true;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), 600);
  }

  /** Write pending edits to IndexedDB now. */
  async flush(): Promise<void> {
    window.clearTimeout(this.saveTimer);
    if (!this.dirty || !this.currentPath) return;
    this.dirty = false;
    await this.save(this.currentPath, this.view.state.doc.toString());
  }
}
