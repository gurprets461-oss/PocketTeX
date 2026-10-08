// Project lifecycle: create from template, import/export .zip.
import JSZip from 'jszip';
import { db, newId, type Project, type ProjectFile, type FileData } from './db.ts';
import { basename, ext, isTextPath, normalizePath } from './util/paths.ts';

const templateText = import.meta.glob('/templates/lab-report/**/*.{tex,bib}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const templateBinary = import.meta.glob('/templates/lab-report/**/*.{png,jpg}', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const TEMPLATE_ROOT = '/templates/lab-report/';

export type NewFile = { path: string; data: FileData; kind: ProjectFile['kind'] };

export async function createFromTemplate(name: string): Promise<Project> {
  const files: NewFile[] = [];
  for (const [p, text] of Object.entries(templateText)) {
    files.push({ path: p.slice(TEMPLATE_ROOT.length), data: text, kind: 'text' });
  }
  for (const [p, url] of Object.entries(templateBinary)) {
    const buf = await (await fetch(url)).arrayBuffer();
    files.push({ path: p.slice(TEMPLATE_ROOT.length), data: buf, kind: 'binary' });
  }
  return saveNewProject(name, files, 'main.tex');
}

async function saveNewProject(name: string, files: NewFile[], main: string): Promise<Project> {
  const now = Date.now();
  const project: Project = { id: newId(), name, main, created: now, updated: now };
  await db.putProject(project);
  await db.putFiles(project.id, files);
  return project;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeText(bytes: Uint8Array): string | null {
  try {
    let s = utf8.decode(bytes);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  } catch {
    return null;
  }
}

/** Pick the root document: a .tex with \documentclass, preferring main.tex and shallow paths. */
export function detectMain(files: { path: string; data: FileData }[]): string | null {
  const candidates = files.filter(
    (f) => ext(f.path) === 'tex' && typeof f.data === 'string' && /^[^%\n]*\\documentclass/m.test(f.data),
  );
  if (!candidates.length) {
    const anyTex = files.find((f) => ext(f.path) === 'tex');
    return anyTex ? anyTex.path : null;
  }
  const score = (p: string) =>
    (basename(p) === 'main.tex' ? 0 : 10) + p.split('/').length * 2 + (/(^|\/)(output|build)\//.test(p) ? 50 : 0);
  candidates.sort((a, b) => score(a.path) - score(b.path) || a.path.localeCompare(b.path));
  return candidates[0].path;
}

const JUNK = /(^|\/)(__MACOSX|\.git)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/;
const BUILD_ARTIFACTS = /\.(aux|log|out|toc|lof|lot|fls|fdb_latexmk|synctex\.gz|blg|bcf|run\.xml)$/i;

export async function importZip(file: Blob, name: string): Promise<{ project: Project; skipped: string[] }> {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter((e) => !e.dir && !JUNK.test(e.name));
  if (!entries.length) throw new Error('The archive is empty.');

  // Strip a single top-level folder ("project/main.tex" -> "main.tex").
  const firstParts = new Set(entries.map((e) => e.name.split('/')[0]));
  const strip = firstParts.size === 1 && entries.every((e) => e.name.includes('/')) ? [...firstParts][0] + '/' : '';

  const files: NewFile[] = [];
  const skipped: string[] = [];
  for (const e of entries) {
    const path = normalizePath(e.name.slice(strip.length));
    if (!path) {
      skipped.push(e.name);
      continue;
    }
    if (BUILD_ARTIFACTS.test(path)) continue;
    const bytes = await e.async('uint8array');
    if (isTextPath(path)) {
      const text = decodeText(bytes);
      if (text !== null) {
        files.push({ path, data: text, kind: 'text' });
        continue;
      }
    }
    files.push({ path, data: bytes.slice().buffer, kind: 'binary' });
  }
  const main = detectMain(files);
  if (!main) throw new Error('No .tex file found in the archive.');
  const project = await saveNewProject(name, files, main);
  return { project, skipped };
}

export async function exportZip(project: Project): Promise<Blob> {
  const zip = new JSZip();
  for (const f of await db.listFiles(project.id)) {
    if (f.kind === 'dir') zip.folder(f.path);
    else zip.file(f.path, f.data);
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export function safeFileName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').trim() || 'project';
}
