// Compile log panel: tappable errors/warnings plus the raw TeX and BibTeX logs.
import { h, icon } from './dom.ts';
import { parseLog, summarize, type LogEntry } from '../latex/logParser.ts';

export interface LogInput {
  status: number;
  log: string;
  bibtexLog: string;
  missing: string[];
  passes: number;
  ms: number;
  error?: string;
}

export class LogView {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private head: HTMLElement;
  entries: LogEntry[] = [];

  constructor(
    private onJump: (file: string, line: number) => void,
    private knownFile: (path: string) => boolean,
  ) {
    this.head = h('div', { class: 'pane-head log-head' }, h('span', { class: 'muted' }, 'No compile yet'));
    this.body = h('div', { class: 'log-body', 'data-testid': 'log-body' });
    this.root = h('div', { class: 'log-view' }, this.head, this.body);
  }

  clear() {
    this.entries = [];
    this.head.replaceChildren(h('span', { class: 'muted' }, 'No compile yet'));
    this.body.replaceChildren();
  }

  set(r: LogInput): LogEntry[] {
    this.entries = parseLog(r.log);
    const s = summarize(this.entries);
    const ok = r.status === 0 && !r.error;
    this.head.replaceChildren(
      h(
        'span',
        { class: 'log-summary ' + (ok ? 'ok' : 'bad') },
        icon(ok ? 'check' : 'error'),
        ok ? 'Compiled' : 'Failed',
        r.passes ? ` · ${r.passes} pass${r.passes === 1 ? '' : 'es'} · ${(r.ms / 1000).toFixed(1)} s` : '',
      ),
      h('span', { class: 'counts' }, `${s.errors} error${s.errors === 1 ? '' : 's'} · ${s.warnings} warning${s.warnings === 1 ? '' : 's'}`),
    );

    const items: HTMLElement[] = [];
    if (r.error) {
      items.push(h('div', { class: 'log-entry error' }, icon('error'), h('div', {}, h('div', { class: 'msg' }, r.error))));
    }
    if (r.missing.length) {
      items.push(
        h(
          'div',
          { class: 'log-entry warning' },
          icon('offline'),
          h(
            'div',
            {},
            h('div', { class: 'msg' }, 'Package files could not be downloaded (offline?):'),
            h('div', { class: 'ctx' }, r.missing.join(', ')),
            h('div', { class: 'hint' }, 'Reconnect and compile again, or use “Make available offline” while online.'),
          ),
        ),
      );
    }
    if (!ok && !this.entries.some((e) => e.level === 'error') && !r.error) {
      items.push(
        h(
          'div',
          { class: 'log-entry error' },
          icon('error'),
          h('div', {}, h('div', { class: 'msg' }, 'TeX stopped without a clear error message; see the raw log below.')),
        ),
      );
    }
    const main = this.entries.filter((e) => e.level !== 'typesetting');
    items.push(...main.map((e) => this.entryEl(e)));
    const boxes = this.entries.filter((e) => e.level === 'typesetting');
    if (boxes.length) {
      items.push(
        h('details', { class: 'log-boxes' }, h('summary', {}, `${boxes.length} typesetting note${boxes.length === 1 ? '' : 's'} (over/underfull boxes, fonts)`), boxes.map((e) => this.entryEl(e))),
      );
    }
    if (!items.length) items.push(h('p', { class: 'muted pad' }, 'No errors or warnings.'));
    items.push(h('details', { class: 'raw-log' }, h('summary', {}, 'Raw TeX log'), h('pre', {}, r.log || '(empty)')));
    if (r.bibtexLog) items.push(h('details', { class: 'raw-log' }, h('summary', {}, 'BibTeX log'), h('pre', {}, r.bibtexLog)));
    this.body.replaceChildren(...items);
    return this.entries;
  }

  private entryEl(e: LogEntry): HTMLElement {
    const canJump = !!e.file && e.line !== null && this.knownFile(e.file);
    const loc = e.file ? `${e.file}${e.line !== null ? ':' + e.line : ''}` : e.line !== null ? `line ${e.line}` : '';
    return h(
      canJump ? 'button' : 'div',
      {
        type: canJump ? 'button' : undefined,
        class: `log-entry ${e.level}${canJump ? ' jump' : ''}`,
        onclick: canJump ? () => this.onJump(e.file!, e.line!) : undefined,
      },
      icon(e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : 'info'),
      h(
        'div',
        {},
        h('div', { class: 'msg' }, e.message),
        loc ? h('div', { class: 'loc' }, loc) : null,
        e.context ? h('div', { class: 'ctx' }, e.context) : null,
      ),
    );
  }
}
