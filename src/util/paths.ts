// Path helpers for project-relative paths ("sections/intro.tex").

const TEXT_EXT = new Set([
  'tex', 'bib', 'sty', 'cls', 'bst', 'bbx', 'cbx', 'lbx', 'def', 'cfg', 'clo', 'ltx', 'dtx', 'ins',
  'txt', 'md', 'csv', 'tsv', 'dat', 'json', 'xml', 'yml', 'yaml', 'tikz', 'pgf', 'gnuplot', 'gp',
  'bbl', 'latexmkrc', 'gitignore', 'svg', 'fd', 'ist', 'rnw', 'lua',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

export function ext(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : base.startsWith('.') ? base.slice(1).toLowerCase() : '';
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function join(dir: string, name: string): string {
  return dir ? dir + '/' + name : name;
}

export function isTextPath(path: string): boolean {
  return TEXT_EXT.has(ext(path));
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.has(ext(path));
}

/** Normalise a user-entered or archive path; returns null if it escapes the project. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    out.push(part);
  }
  return out.length ? out.join('/') : null;
}

export function isValidName(name: string): boolean {
  return !!name && !/[/\\:*?"<>|]/.test(name) && name !== '.' && name !== '..';
}

export function mimeFor(path: string): string {
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      pdf: 'application/pdf',
    }[ext(path)] || 'application/octet-stream'
  );
}
