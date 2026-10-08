// The project workspace: editor, files, PDF and log, laid out as tabs on
// phones and side by side on wide screens.
import { db, type Project, type ProjectFile } from '../db.ts';
import { engine, EngineCrash, type Progress } from '../engine/engine.ts';
import { exportZip, safeFileName } from '../projects.ts';
import { h, icon, formatBytes } from './dom.ts';
import { Editor, type CompletionData } from './editor.ts';
import { PdfView } from './pdfView.ts';
import { LogView } from './logView.ts';
import { FileTree } from './fileTree.ts';
import { actionSheet, confirmDialog, dismissToast, infoDialog, promptDialog, toast } from './dialogs.ts';
import { basename, dirname, ext, isImagePath, isTextPath, isValidName, join, mimeFor, normalizePath } from '../util/paths.ts';
import { canShareFile, downloadBlob, photoToJpeg, pickFiles, shareFile } from '../util/files.ts';
import { figureSnippet } from '../latex/snippets.ts';
import { summarize } from '../latex/logParser.ts';
import { prefetch, uncachedFiles, waitForServiceWorker } from '../offline.ts';
import { showAbout } from './about.ts';

type Tab = 'editor' | 'pdf' | 'files' | 'log';
const WIDE = window.matchMedia('(min-width: 900px)');

export class Workspace {
  readonly root: HTMLElement;
  private project: Project | null = null;
  private files: ProjectFile[] = [];
  private editor: Editor;
  private pdf: PdfView;
  private log: LogView;
  private tree: FileTree;
  private pdfBytes: Uint8Array | null = null;
  private titleBtn: HTMLButtonElement;
  private statusEl: HTMLElement;
  private compileBtn: HTMLButtonElement;
  private fileSelect: HTMLSelectElement;
  private tabButtons = new Map<Tab, HTMLButtonElement>();
  private logBadge: HTMLElement;
  private rightSwitch: HTMLElement;
  private completion: CompletionData | null = null;
  private compiling = false;

  constructor(private nav: { home(): void }) {
    this.editor = new Editor(
      (path, text) => this.saveText(path, text),
      () => this.completionData(),
      { compile: () => void this.compile() },
    );
    this.pdf = new PdfView({
      download: () => this.downloadPdf(),
      share: typeof navigator.share === 'function' ? () => void this.sharePdf() : null,
    });
    this.log = new LogView(
      (file, line) => void this.jumpTo(file, line),
      (p) => this.files.some((f) => f.path === p && f.kind === 'text'),
    );
    this.tree = new FileTree({
      open: (p) => void this.openFile(p),
      newFile: (d) => void this.newFile(d),
      newFolder: (d) => void this.newFolder(d),
      upload: (d) => void this.upload(d),
      photo: (d) => void this.photo(d),
      rename: (p, isDir) => void this.rename(p, isDir),
      remove: (p, isDir) => void this.remove(p, isDir),
      setMain: (p) => void this.setMain(p),
      insertFigure: (p) => void this.insertFigure(p),
      download: (p) => this.downloadFile(p),
    });

    this.titleBtn = h('button', { type: 'button', class: 'title-btn', title: 'Rename project', onclick: () => void this.renameProject() }, '');
    this.statusEl = h('span', { class: 'status', role: 'status', 'aria-live': 'polite', 'data-testid': 'status' });
    this.compileBtn = h(
      'button',
      { type: 'button', class: 'btn primary compile-btn', 'data-testid': 'compile', onclick: () => this.onCompileClick() },
      icon('play'),
      h('span', {}, 'Compile'),
    );
    this.rightSwitch = h(
      'div',
      { class: 'segmented wide-only', role: 'tablist' },
      h('button', { type: 'button', 'data-right': 'pdf', onclick: () => this.setRight('pdf') }, 'PDF'),
      h('button', { type: 'button', 'data-right': 'log', onclick: () => this.setRight('log') }, 'Log'),
    );
    const top = h(
      'header',
      { class: 'topbar' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'All projects', title: 'All projects', onclick: () => this.leave() }, icon('back')),
      h('div', { class: 'title-block' }, this.titleBtn, this.statusEl),
      this.rightSwitch,
      this.compileBtn,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Project menu', title: 'Project menu', 'data-testid': 'project-menu', onclick: () => this.menu() }, icon('more')),
    );

    this.fileSelect = h('select', { class: 'file-select', 'aria-label': 'Open file', onchange: () => void this.openFile(this.fileSelect.value) });
    this.editor.head.append(this.fileSelect);

    const pane = (cls: string, ...children: HTMLElement[]) => h('section', { class: 'pane ' + cls }, ...children);
    const panes = h(
      'div',
      { class: 'panes' },
      pane('pane-files', this.tree.root),
      pane('pane-editor', this.editor.root),
      pane('pane-pdf', this.pdf.root),
      pane('pane-log', this.log.root),
    );

    this.logBadge = h('span', { class: 'tab-badge', hidden: true });
    const tab = (id: Tab, label: string, ic: string) => {
      const b = h(
        'button',
        { type: 'button', role: 'tab', class: 'tab', 'data-tab': id, 'data-testid': 'tab-' + id, onclick: () => this.setTab(id) },
        icon(ic),
        h('span', {}, label),
        id === 'log' ? this.logBadge : null,
      );
      this.tabButtons.set(id, b);
      return b;
    };
    const tabbar = h('nav', { class: 'tabbar', role: 'tablist' }, tab('editor', 'Editor', 'edit'), tab('pdf', 'PDF', 'pdf'), tab('files', 'Files', 'files'), tab('log', 'Log', 'log'));
    this.root = h('div', { class: 'screen workspace', 'data-tab': 'editor', 'data-right': 'pdf' }, top, panes, tabbar);
    this.setRight('pdf');
    this.setTab('editor');
  }

  get projectId(): string | null {
    return this.project?.id ?? null;
  }

  // ---------------------------------------------------------------- loading

  async open(id: string): Promise<boolean> {
    const project = await db.getProject(id);
    if (!project) return false;
    if (this.project?.id !== id) {
      this.editor.clear();
      this.pdf.clear();
      this.log.clear();
      this.pdfBytes = null;
      this.setLogBadge(0);
    }
    this.project = project;
    this.files = await db.listFiles(id);
    this.completion = null;
    this.titleBtn.textContent = project.name;
    this.statusEl.textContent = '';
    this.refreshFiles();
    const mainFile = this.files.find((f) => f.path === project.main) || this.files.find((f) => f.kind === 'text');
    if (mainFile && !this.editor.path) await this.openFile(mainFile.path, { switchTab: false });

    const out = await db.getOutput(id);
    if (out) {
      this.showLog({ status: out.status, log: out.log, bibtexLog: out.bibtexLog, missing: [], passes: out.passes, ms: 0 });
      if (out.pdf) {
        this.pdfBytes = new Uint8Array(out.pdf);
        void this.pdf.show(this.pdfBytes);
      }
      this.statusEl.textContent = out.status === 0 ? '' : 'Last compile failed';
    }
    void engine.warmUp().catch(() => {});
    return true;
  }

  private leave() {
    void this.editor.flush();
    this.nav.home();
  }

  private refreshFiles() {
    if (!this.project) return;
    this.tree.render(this.files, this.project.main, this.editor.path);
    const texts = this.files.filter((f) => f.kind === 'text');
    this.fileSelect.replaceChildren(
      ...texts.map((f) =>
        h('option', { value: f.path, selected: f.path === this.editor.path }, f.path + (f.path === this.project!.main ? '  (main)' : '')),
      ),
    );
  }

  // ------------------------------------------------------------------- tabs

  setTab(tab: Tab) {
    // On wide screens Editor and Files are always visible; PDF/Log share the right pane.
    if (WIDE.matches && (tab === 'pdf' || tab === 'log')) this.setRight(tab);
    this.root.dataset.tab = tab;
    for (const [id, b] of this.tabButtons) {
      b.classList.toggle('active', id === tab);
      b.setAttribute('aria-selected', String(id === tab));
    }
  }

  private setRight(which: 'pdf' | 'log') {
    this.root.dataset.right = which;
    for (const b of this.rightSwitch.querySelectorAll('button')) b.classList.toggle('active', b.dataset.right === which);
  }

  private showPanel(which: 'pdf' | 'log' | 'editor') {
    if (WIDE.matches) {
      if (which !== 'editor') this.setRight(which);
    } else this.setTab(which);
  }

  private setLogBadge(errors: number) {
    this.logBadge.hidden = errors === 0;
    this.logBadge.textContent = String(errors);
  }

  // ------------------------------------------------------------------ files

  private completionData(): CompletionData {
    if (!this.completion) {
      const labels = new Set<string>();
      const citeKeys = new Set<string>();
      for (const f of this.files) {
        if (typeof f.data !== 'string') continue;
        if (ext(f.path) === 'tex') for (const m of f.data.matchAll(/\\label\{([^}]+)\}/g)) labels.add(m[1]);
        if (ext(f.path) === 'bib') for (const m of f.data.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) citeKeys.add(m[1]);
      }
      this.completion = {
        labels: [...labels].sort(),
        citeKeys: [...citeKeys].sort(),
        files: this.files.filter((f) => f.kind !== 'dir').map((f) => f.path),
      };
    }
    return this.completion;
  }

  private async saveText(path: string, text: string) {
    if (!this.project) return;
    const pid = this.project.id;
    await db.putFiles(pid, [{ path, data: text, kind: 'text' }]);
    const f = this.files.find((x) => x.path === path);
    if (f) {
      f.data = text;
      f.rev++;
      f.mtime = Date.now();
    }
    this.completion = null;
    await db.touchProject(pid);
  }

  async openFile(path: string, opts: { switchTab?: boolean } = {}) {
    const f = this.files.find((x) => x.path === path);
    if (!f) return;
    if (f.kind === 'text' && typeof f.data === 'string') {
      await this.editor.open(path, f.data);
      this.refreshFiles();
      if (opts.switchTab !== false) this.setTab('editor');
    } else if (isImagePath(path)) {
      this.previewImage(f);
    } else {
      infoDialog(basename(path), `${formatBytes(f.data instanceof ArrayBuffer ? f.data.byteLength : 0)} binary file. It is included when compiling and exporting.`);
    }
  }

  private previewImage(f: ProjectFile) {
    const url = URL.createObjectURL(new Blob([f.data], { type: mimeFor(f.path) }));
    const img = h('img', { src: url, alt: f.path, class: 'preview-img' });
    const body = h(
      'div',
      { class: 'image-preview' },
      img,
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => { document.querySelector('.backdrop')?.remove(); void this.insertFigure(f.path); } }, icon('image'), 'Insert figure')),
    );
    infoDialog(f.path, body);
  }

  private async jumpTo(file: string, line: number) {
    await this.openFile(file, { switchTab: false });
    this.showPanel('editor');
    this.setTab('editor');
    requestAnimationFrame(() => this.editor.gotoLine(line));
  }

  private exists(path: string) {
    return this.files.some((f) => f.path === path || f.path.startsWith(path + '/'));
  }

  private async reloadFiles() {
    if (!this.project) return;
    this.files = await db.listFiles(this.project.id);
    this.completion = null;
    this.refreshFiles();
  }

  private async askPath(title: string, dir: string, fallback: string, okLabel: string): Promise<string | null> {
    const input = await promptDialog(title, join(dir, fallback), { okLabel, hint: 'Use / for folders, e.g. sections/methods.tex' });
    if (!input) return null;
    const path = normalizePath(input);
    if (!path || !path.split('/').every(isValidName)) {
      toast('Invalid name.');
      return null;
    }
    return path;
  }

  private async newFile(dir: string) {
    if (!this.project) return;
    const path = await this.askPath('New file', dir, 'untitled.tex', 'Create');
    if (!path) return;
    if (this.exists(path)) return toast(`${path} already exists.`);
    await db.putFiles(this.project.id, [{ path, data: '', kind: isTextPath(path) ? 'text' : 'binary' }]);
    await this.reloadFiles();
    if (isTextPath(path)) await this.openFile(path);
  }

  private async newFolder(dir: string) {
    if (!this.project) return;
    const path = await this.askPath('New folder', dir, 'figures', 'Create');
    if (!path) return;
    if (this.exists(path)) return toast(`${path} already exists.`);
    await db.putFiles(this.project.id, [{ path, data: '', kind: 'dir' }]);
    await this.reloadFiles();
  }

  private async addFiles(entries: { path: string; data: ArrayBuffer | string; kind: ProjectFile['kind'] }[]) {
    if (!this.project) return;
    const clashes = entries.filter((e) => this.files.some((f) => f.path === e.path));
    if (clashes.length && !(await confirmDialog('Replace files?', `${clashes.map((c) => c.path).join(', ')} already exist${clashes.length === 1 ? 's' : ''}.`, 'Replace'))) {
      return false;
    }
    await db.putFiles(this.project.id, entries);
    await this.reloadFiles();
    return true;
  }

  private async upload(dir: string) {
    const picked = await pickFiles('', { multiple: true });
    if (!picked.length) return;
    const entries = [];
    for (const file of picked) {
      const path = normalizePath(join(dir, file.name));
      if (!path) continue;
      const buf = await file.arrayBuffer();
      let data: ArrayBuffer | string = buf;
      let kind: ProjectFile['kind'] = 'binary';
      if (isTextPath(path)) {
        try {
          data = new TextDecoder('utf-8', { fatal: true }).decode(buf);
          kind = 'text';
        } catch {
          /* keep binary */
        }
      }
      entries.push({ path, data, kind });
    }
    if (await this.addFiles(entries)) toast(`Added ${entries.length} file${entries.length === 1 ? '' : 's'}.`);
  }

  private async photo(dir: string) {
    const [file] = await pickFiles('image/*', { capture: 'environment' });
    if (!file) return;
    let jpeg: Blob;
    try {
      jpeg = await photoToJpeg(file);
    } catch (e) {
      return toast(String((e as Error).message || e));
    }
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    const path = await this.askPath('Save photo as', dir || 'figures', `photo-${stamp}.jpg`, 'Save');
    if (!path) return;
    const finalPath = /\.(jpe?g)$/i.test(path) ? path : path + '.jpg';
    if (await this.addFiles([{ path: finalPath, data: await jpeg.arrayBuffer(), kind: 'binary' }])) {
      toast(`Saved ${finalPath} (${formatBytes(jpeg.size)}).`, { label: 'Insert figure', run: () => void this.insertFigure(finalPath) });
    }
  }

  private async rename(path: string, isDir: boolean) {
    if (!this.project) return;
    const to = await this.askPath(isDir ? 'Rename folder' : 'Rename file', dirname(path), basename(path), 'Rename');
    if (!to || to === path) return;
    if (this.exists(to)) return toast(`${to} already exists.`);
    await this.editor.flush();
    await db.renamePath(this.project.id, path, to);
    const moveMain = this.project.main === path || this.project.main.startsWith(path + '/');
    if (moveMain) {
      this.project.main = to + this.project.main.slice(path.length);
      await db.putProject(this.project);
    }
    const cur = this.editor.path;
    await this.reloadFiles();
    if (cur && (cur === path || cur.startsWith(path + '/'))) {
      this.editor.forget(cur);
      this.editor.clear();
      await this.openFile(to + cur.slice(path.length), { switchTab: false });
    }
  }

  private async remove(path: string, isDir: boolean) {
    if (!this.project) return;
    const affected = this.files.filter((f) => f.path === path || f.path.startsWith(path + '/'));
    if (affected.some((f) => f.path === this.project!.main)) return toast('The main file cannot be deleted. Set another main file first.');
    const what = isDir ? `the folder ${path} and ${affected.length - 1} item(s) in it` : path;
    if (!(await confirmDialog('Delete?', `Delete ${what}? This cannot be undone.`, 'Delete', true))) return;
    await db.deleteFiles(this.project.id, affected.map((f) => f.path));
    const cur = this.editor.path;
    await this.reloadFiles();
    if (cur && affected.some((f) => f.path === cur)) {
      this.editor.clear();
      await this.openFile(this.project.main, { switchTab: false });
    }
  }

  private async setMain(path: string) {
    if (!this.project) return;
    this.project.main = path;
    await db.putProject(this.project);
    this.refreshFiles();
    toast(`${path} is now the main file.`);
  }

  private async insertFigure(path: string) {
    if (!this.editor.path || ext(this.editor.path) !== 'tex') {
      if (this.project) await this.openFile(this.project.main, { switchTab: false });
    }
    this.showPanel('editor');
    this.setTab('editor');
    requestAnimationFrame(() => this.editor.insertSnippet(figureSnippet(path)));
  }

  private downloadFile(path: string) {
    const f = this.files.find((x) => x.path === path);
    if (f) downloadBlob(new Blob([f.data], { type: mimeFor(path) }), basename(path));
  }

  // ---------------------------------------------------------------- compile

  private onCompileClick() {
    if (this.compiling) {
      engine.stop();
      return;
    }
    void this.compile();
  }

  private setCompiling(on: boolean, label = '') {
    this.compiling = on;
    this.compileBtn.classList.toggle('running', on);
    this.compileBtn.replaceChildren(on ? h('span', { class: 'spinner' }) : icon('play'), h('span', {}, on ? 'Stop' : 'Compile'));
    this.compileBtn.title = on ? 'Stop compiling' : 'Compile (Ctrl+Enter)';
    if (label) this.statusEl.textContent = label;
  }

  async compile(): Promise<boolean> {
    if (!this.project || this.compiling) return false;
    const project = this.project;
    dismissToast();
    this.setCompiling(true, 'Preparing…');
    await this.editor.flush();
    const files = await db.listFiles(project.id);
    this.files = files;
    const progress = (p: Progress) => {
      this.statusEl.textContent =
        p.phase === 'init' ? 'Starting engine…' : p.phase === 'sync' ? 'Preparing…' : p.phase === 'bibtex' ? 'BibTeX…' : `Pass ${p.pass}…`;
    };
    try {
      const r = await engine.compile(project.id, files, project.main, project.onDemand || [], progress);
      if (this.project?.id !== project.id) return false;
      const entries = this.showLog(r);
      const s = summarize(entries);
      const ok = r.status === 0 && !!r.pdf;
      if (r.pdf) {
        this.pdfBytes = r.pdf;
        await this.pdf.show(r.pdf);
      }
      await db.putOutput({
        projectId: project.id,
        pdf: r.pdf ? r.pdf.slice().buffer : this.pdfBytes ? this.pdfBytes.slice().buffer : null,
        log: r.log,
        bibtexLog: r.bibtexLog,
        status: r.status,
        time: Date.now(),
        passes: r.passes,
      });
      project.onDemand = r.onDemand;
      await db.putProject(project);
      if (ok) {
        this.statusEl.textContent = `${this.pdf.pageCount} page${this.pdf.pageCount === 1 ? '' : 's'} · ${(r.ms / 1000).toFixed(1)} s`;
        if (!WIDE.matches && this.root.dataset.tab !== 'pdf') {
          toast(`Compiled: ${this.pdf.pageCount} page${this.pdf.pageCount === 1 ? '' : 's'}.`, { label: 'View PDF', run: () => this.setTab('pdf') });
        }
      } else {
        const n = Math.max(1, s.errors);
        this.statusEl.textContent = r.missing.length ? 'Missing packages (offline?)' : `${n} error${n === 1 ? '' : 's'}`;
        this.showPanel('log');
      }
      return ok;
    } catch (e) {
      const msg = e instanceof EngineCrash ? e.message : String((e as Error)?.message || e);
      this.statusEl.textContent = msg.startsWith('Compilation stopped') ? 'Stopped' : 'Engine error';
      this.showLog({ status: -1, log: '', bibtexLog: '', missing: [], passes: 0, ms: 0, error: msg });
      if (!msg.startsWith('Compilation stopped')) this.showPanel('log');
      return false;
    } finally {
      this.setCompiling(false);
    }
  }

  private showLog(r: Parameters<LogView['set']>[0]) {
    const entries = this.log.set(r);
    this.setLogBadge(entries.filter((e) => e.level === 'error').length + (r.error ? 1 : 0));
    return entries;
  }

  // ------------------------------------------------------------------- menu

  private pdfFile(): File | null {
    if (!this.pdfBytes || !this.project) return null;
    const name = safeFileName(basename(this.project.main).replace(/\.tex$/i, '') === 'main' ? this.project.name : basename(this.project.main).replace(/\.tex$/i, ''));
    return new File([this.pdfBytes.slice()], name + '.pdf', { type: 'application/pdf' });
  }

  private downloadPdf() {
    const f = this.pdfFile();
    if (!f) return toast('Compile first.');
    downloadBlob(f, f.name);
  }

  private async sharePdf() {
    const f = this.pdfFile();
    if (!f) return toast('Compile first.');
    if (!canShareFile(f)) {
      downloadBlob(f, f.name);
      return;
    }
    try {
      await shareFile(f, f.name);
    } catch (e) {
      toast('Sharing failed: ' + String((e as Error).message || e));
    }
  }

  private async exportProject(share: boolean) {
    if (!this.project) return;
    await this.editor.flush();
    const blob = await exportZip(this.project);
    const file = new File([blob], safeFileName(this.project.name) + '.zip', { type: 'application/zip' });
    if (share && canShareFile(file)) {
      try {
        await shareFile(file, file.name);
        return;
      } catch {
        /* fall back to download */
      }
    }
    downloadBlob(file, file.name);
  }

  async makeOffline() {
    if (!this.project) return;
    if (!navigator.onLine) return toast('Connect to the internet first, then try again.');
    this.statusEl.textContent = 'Preparing offline copy…';
    await waitForServiceWorker(30000);
    const ok = await this.compile();
    const urls = this.project.onDemand || [];
    if (!ok && !urls.length) {
      toast('Fix the compile errors first, so the needed packages can be detected.');
      return;
    }
    const r = await prefetch(urls, (d, t) => (this.statusEl.textContent = `Caching packages ${d}/${t}…`));
    const missing = await uncachedFiles(urls);
    this.project.offlineCheckedAt = Date.now();
    await db.putProject(this.project);
    this.statusEl.textContent = missing.length ? 'Offline copy incomplete' : 'Available offline';
    if (missing.length) toast(`${missing.length} package file(s) could not be cached. Try again on a better connection.`);
    else if (!urls.length) toast('Available offline: everything this project needs is bundled with the app.');
    else toast(`Available offline: ${urls.length} extra package file(s) cached${r.bytes ? ` (${formatBytes(r.bytes)} downloaded)` : ''}.`);
  }

  private async renameProject() {
    if (!this.project) return;
    const name = await promptDialog('Rename project', this.project.name, { okLabel: 'Rename' });
    if (!name) return;
    this.project.name = name;
    await db.putProject(this.project);
    this.titleBtn.textContent = name;
  }

  private menu() {
    const shareable = typeof navigator.share === 'function';
    actionSheet(this.project?.name ?? null, [
      { label: 'Download PDF', icon: 'download', disabled: !this.pdfBytes, run: () => this.downloadPdf() },
      ...(shareable ? [{ label: 'Share PDF…', icon: 'share', disabled: !this.pdfBytes, run: () => this.sharePdf() }] : []),
      { label: 'Export project (.zip)', icon: 'zip', run: () => this.exportProject(false) },
      ...(shareable ? [{ label: 'Share project (.zip)…', icon: 'share', run: () => this.exportProject(true) }] : []),
      { label: 'Make available offline', icon: 'offline', run: () => this.makeOffline() },
      { label: 'Rename project', icon: 'rename', run: () => this.renameProject() },
      { label: 'About & storage', icon: 'info', run: () => showAbout() },
    ]);
  }
}
