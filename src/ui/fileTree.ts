// Project file tree with add/rename/delete, uploads and camera capture.
import type { ProjectFile } from '../db.ts';
import { h, icon, formatBytes } from './dom.ts';
import { actionSheet, type SheetAction } from './dialogs.ts';
import { basename, ext, isImagePath } from '../util/paths.ts';

export interface FileTreeHandlers {
  open(path: string): void;
  newFile(dir: string): void;
  newFolder(dir: string): void;
  upload(dir: string): void;
  photo(dir: string): void;
  rename(path: string, isDir: boolean): void;
  remove(path: string, isDir: boolean): void;
  setMain(path: string): void;
  insertFigure(path: string): void;
  download(path: string): void;
}

interface Node {
  name: string;
  path: string;
  dir: boolean;
  file?: ProjectFile;
  children: Map<string, Node>;
}

function buildTree(files: ProjectFile[]): Node {
  const root: Node = { name: '', path: '', dir: true, children: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, dir: !last || f.kind === 'dir', children: new Map() };
        node.children.set(part, child);
      }
      if (last && f.kind !== 'dir') child.file = f;
      node = child;
    });
  }
  return root;
}

function size(f?: ProjectFile): number {
  if (!f) return 0;
  return typeof f.data === 'string' ? new Blob([f.data]).size : f.data.byteLength;
}

export class FileTree {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private collapsed = new Set<string>();
  private last: { files: ProjectFile[]; main: string; current: string | null } = { files: [], main: '', current: null };

  constructor(private handlers: FileTreeHandlers) {
    const btn = (label: string, ic: string, run: () => void, testid: string) =>
      h('button', { type: 'button', class: 'tool-btn', onclick: run, 'data-testid': testid }, icon(ic), h('span', {}, label));
    const head = h(
      'div',
      { class: 'pane-head files-head' },
      btn('File', 'newdoc', () => handlers.newFile(''), 'new-file'),
      btn('Folder', 'folder', () => handlers.newFolder(''), 'new-folder'),
      btn('Upload', 'upload', () => handlers.upload(''), 'upload'),
      btn('Photo', 'camera', () => handlers.photo('figures'), 'take-photo'),
    );
    this.list = h('div', { class: 'tree', role: 'tree' });
    this.root = h('div', { class: 'file-tree' }, head, this.list);
  }

  render(files: ProjectFile[], main: string, current: string | null) {
    this.last = { files, main, current };
    const tree = buildTree(files);
    const rows: HTMLElement[] = [];
    const walk = (node: Node, depth: number) => {
      const kids = [...node.children.values()].sort((a, b) =>
        a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
      );
      for (const n of kids) {
        rows.push(this.row(n, depth, main, current));
        if (n.dir && !this.collapsed.has(n.path)) walk(n, depth + 1);
      }
    };
    walk(tree, 0);
    if (!rows.length) rows.push(h('p', { class: 'muted pad' }, 'No files.'));
    this.list.replaceChildren(...rows);
  }

  private row(n: Node, depth: number, main: string, current: string | null): HTMLElement {
    const isMain = !n.dir && n.path === main;
    const kind = n.dir ? 'folder' : isImagePath(n.path) ? 'image' : 'file';
    const more = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn row-more',
        'aria-label': `Actions for ${n.name}`,
        onclick: (e: Event) => {
          e.stopPropagation();
          this.menu(n, main);
        },
      },
      icon('more'),
    );
    return h(
      'div',
      {
        class: 'tree-row' + (n.path === current ? ' current' : '') + (n.dir ? ' dir' : ''),
        role: 'treeitem',
        tabindex: '0',
        'data-path': n.path,
        style: `--depth:${depth}`,
        onclick: () => {
          if (n.dir) {
            if (this.collapsed.has(n.path)) this.collapsed.delete(n.path);
            else this.collapsed.add(n.path);
            this.render(this.last.files, this.last.main, this.last.current);
          } else this.handlers.open(n.path);
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLElement).click();
        },
      },
      n.dir ? icon('chevron', 'icon chevron' + (this.collapsed.has(n.path) ? '' : ' open')) : h('span', { class: 'chevron-space' }),
      icon(kind),
      h('span', { class: 'name' }, n.name),
      isMain ? h('span', { class: 'badge' }, 'main') : null,
      !n.dir ? h('span', { class: 'size' }, formatBytes(size(n.file))) : null,
      more,
    );
  }

  private menu(n: Node, main: string) {
    const hd = this.handlers;
    const actions: SheetAction[] = [];
    if (n.dir) {
      actions.push(
        { label: 'New file here', icon: 'newdoc', run: () => hd.newFile(n.path) },
        { label: 'New folder here', icon: 'folder', run: () => hd.newFolder(n.path) },
        { label: 'Upload here', icon: 'upload', run: () => hd.upload(n.path) },
        { label: 'Take photo here', icon: 'camera', run: () => hd.photo(n.path) },
      );
    } else {
      if (ext(n.path) === 'tex' && n.path !== main) actions.push({ label: 'Set as main file', icon: 'star', run: () => hd.setMain(n.path) });
      if (isImagePath(n.path) || ext(n.path) === 'pdf') actions.push({ label: 'Insert figure at cursor', icon: 'image', run: () => hd.insertFigure(n.path) });
      actions.push({ label: 'Download', icon: 'download', run: () => hd.download(n.path) });
    }
    actions.push(
      { label: 'Rename / move', icon: 'rename', run: () => hd.rename(n.path, n.dir) },
      { label: 'Delete', icon: 'trash', danger: true, disabled: n.path === main, run: () => hd.remove(n.path, n.dir) },
    );
    actionSheet(n.dir ? n.path + '/' : basename(n.path), actions);
  }
}
