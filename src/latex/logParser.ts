// Parses a pdfTeX/LaTeX .log into errors and warnings with file:line locations.
//
// TeX does not tag messages with the current file; instead it prints "(file"
// when it opens a file and ")" when it closes it. We replay those parentheses
// to know which file each message belongs to, skipping error-context lines
// (which echo user text with unbalanced parentheses). Lines are hard-wrapped
// at max_print_line (79 for this engine), so they are re-joined first.

export type LogLevel = 'error' | 'warning' | 'typesetting';

export interface LogEntry {
  level: LogLevel;
  message: string;
  /** Project-relative path, or null when unknown / not a project file. */
  file: string | null;
  line: number | null;
  /** Extra context (TeX's error context lines, offending text). */
  context: string;
}

const MAX_PRINT_LINE = 79;

function unwrap(log: string): string[] {
  const raw = log.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let buf = '';
  for (const line of raw) {
    buf += line;
    // A line exactly at the wrap width continues on the next one.
    if (line.length === MAX_PRINT_LINE && !/^(l\.\d+ |! )/.test(line)) continue;
    out.push(buf);
    buf = '';
  }
  if (buf) out.push(buf);
  return out;
}

/** Turn an engine path into a project path: "./sec/a.tex" -> "sec/a.tex"; system files -> null. */
export function projectPath(p: string | null): string | null {
  if (!p) return null;
  let s = p.trim();
  if (s.startsWith('/work/')) s = s.slice(6);
  if (s.startsWith('/')) return null;
  while (s.startsWith('./')) s = s.slice(2);
  return s || null;
}

const FILE_TOKEN = /^\(([^\s()[\]{}<>]+)/;

function looksLikeFile(tok: string): boolean {
  return /\.[A-Za-z0-9]{1,8}$/.test(tok) || tok.startsWith('/') || tok.startsWith('./');
}

class FileStack {
  stack: (string | null)[] = [];

  feed(line: string) {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '(') {
        const m = FILE_TOKEN.exec(line.slice(i));
        if (m && looksLikeFile(m[1])) {
          this.stack.push(m[1]);
          i += m[1].length;
        } else {
          this.stack.push(null);
        }
      } else if (ch === ')') {
        if (this.stack.length) this.stack.pop();
      }
    }
  }

  current(): string | null {
    for (let i = this.stack.length - 1; i >= 0; i--) if (this.stack[i]) return this.stack[i];
    return null;
  }
}

const WARNING = /^((?:LaTeX|Package [^\s]+|Class [^\s]+|pdfTeX)(?: Font)?) Warning: (.*)$/;
const BOX = /^((?:Over|Under)full \\[hv]box .*?)(?: in paragraph at lines (\d+)--(\d+)| in alignment at lines (\d+)--(\d+)| detected at line (\d+)| has occurred while \\output is active)/;
const INPUT_LINE = /on input line (\d+)/;

export function parseLog(log: string): LogEntry[] {
  const lines = unwrap(log);
  const files = new FileStack();
  const entries: LogEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('! ')) {
      let message = line.slice(2).trim();
      if (/^\s*==> Fatal error occurred/.test(message)) continue;
      const file = projectPath(files.current());
      // Collect continuation lines and find "l.<n>" within the next lines.
      const context: string[] = [];
      let lineNo: number | null = null;
      let j = i + 1;
      for (; j < lines.length && j < i + 25; j++) {
        const l = lines[j];
        const m = /^l\.(\d+) ?(.*)$/.exec(l);
        if (m) {
          lineNo = Number(m[1]);
          const after = lines[j + 1] && /^\s+\S/.test(lines[j + 1]) ? lines[j + 1].trim() : '';
          context.push((m[2] + (after ? ' ⏎ ' + after : '')).trim());
          if (after) j++;
          break;
        }
        if (l.startsWith('! ') && !/Emergency stop/.test(l)) {
          j--;
          break;
        }
        if (/^(Type|See the|Enter file name|or enter new name|Try typing|You're in trouble)/.test(l)) continue;
        if (l.trim()) context.push(l.trim());
      }
      // "Emergency stop" right after a "file not found" belongs to that error.
      const prev = entries[entries.length - 1];
      if (/^Emergency stop/.test(message) && prev && prev.level === 'error' && prev.line === null) {
        prev.line = lineNo;
        i = j;
        continue;
      }
      if (/^LaTeX Error: File `/.test(message)) {
        // The l.<n> for a missing file comes after the "Emergency stop" line.
        lineNo = null;
        j = i;
        context.length = 0;
      }
      if (message === 'Undefined control sequence.' && context.length) {
        const m = /(\\[A-Za-z@]+|\\.)\s*(?:⏎.*)?$/.exec(context[context.length - 1].split(' ⏎ ')[0]);
        if (m) message = `Undefined control sequence ${m[1]}`;
      }
      entries.push({ level: 'error', message, file, line: lineNo, context: context.join('\n') });
      i = Math.max(i, j);
      continue;
    }

    const w = WARNING.exec(line);
    if (w) {
      let message = w[2];
      const pkg = /^Package (\S+)/.exec(w[1]);
      const cont = pkg ? `(${pkg[1]})` : /^Class (\S+)/.exec(w[1]) ? `(${/^Class (\S+)/.exec(w[1])![1]})` : null;
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && !WARNING.test(lines[j])) {
        const l = lines[j];
        if (cont && l.startsWith(cont)) message += ' ' + l.slice(cont.length).trim();
        else if (!cont && !/^[([<]/.test(l)) message += ' ' + l.trim();
        else break;
        j++;
      }
      const m = INPUT_LINE.exec(message);
      message = message.replace(/\s+/g, ' ').trim();
      const source = w[1].replace(/^Package /, '').replace(/^Class /, '');
      entries.push({
        level: /Font$/.test(w[1]) && !/^LaTeX$/.test(source) ? 'typesetting' : 'warning',
        message: source === 'LaTeX' ? message : `${source}: ${message}`,
        file: projectPath(files.current()),
        line: m ? Number(m[1]) : null,
        context: '',
      });
      i = j - 1;
      continue;
    }

    const b = BOX.exec(line);
    if (b) {
      const ln = b[2] || b[4] || b[6];
      entries.push({
        level: 'typesetting',
        message: b[1],
        file: projectPath(files.current()),
        line: ln ? Number(ln) : null,
        context: '',
      });
      // Skip the box contents dump (until a blank line).
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && !lines[j].startsWith('(')) j++;
      i = j - 1;
      continue;
    }

    files.feed(line);
  }
  return entries;
}

export function summarize(entries: LogEntry[]) {
  return {
    errors: entries.filter((e) => e.level === 'error').length,
    warnings: entries.filter((e) => e.level === 'warning').length,
    typesetting: entries.filter((e) => e.level === 'typesetting').length,
  };
}
