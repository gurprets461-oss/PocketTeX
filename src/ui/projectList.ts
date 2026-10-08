// Home screen: list of projects, create from template, import .zip.
import { db, type Project } from '../db.ts';
import { createFromTemplate, exportZip, importZip, safeFileName } from '../projects.ts';
import { h, icon, timeAgo } from './dom.ts';
import { actionSheet, confirmDialog, promptDialog, toast } from './dialogs.ts';
import { downloadBlob, pickFiles } from '../util/files.ts';
import { uncachedFiles, requestPersistence, onOfflineChange, offlineStatus } from '../offline.ts';
import { showAbout } from './about.ts';

export class ProjectList {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private footer: HTMLElement;

  constructor(private nav: { open(id: string): void }) {
    this.list = h('div', { class: 'project-list', 'data-testid': 'project-list' });
    this.footer = h('footer', { class: 'home-footer' });
    this.root = h(
      'div',
      { class: 'screen home' },
      h(
        'header',
        { class: 'topbar' },
        h('img', { class: 'logo', src: `${import.meta.env.BASE_URL}icons/favicon.svg`, alt: '' }),
        h('h1', {}, 'PocketTeX'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'About & storage', title: 'About & storage', onclick: () => void showAbout() }, icon('info')),
      ),
      h(
        'div',
        { class: 'home-body' },
        h(
          'div',
          { class: 'home-actions' },
          h('button', { type: 'button', class: 'btn primary big', 'data-testid': 'new-project', onclick: () => void this.create() }, icon('plus'), 'New lab report'),
          h('button', { type: 'button', class: 'btn big', 'data-testid': 'import-zip', onclick: () => void this.importZip() }, icon('upload'), 'Import .zip'),
        ),
        this.list,
      ),
      this.footer,
    );
    onOfflineChange(() => void this.renderFooter());
  }

  async render() {
    const projects = await db.listProjects();
    if (!projects.length) {
      this.list.replaceChildren(
        h(
          'div',
          { class: 'empty' },
          h('p', {}, 'No projects yet.'),
          h('p', { class: 'hint' }, 'Start from the lab-report template, or import a .zip exported from Overleaf (Menu → Download → Source).'),
        ),
      );
    } else {
      this.list.replaceChildren(...projects.map((p) => this.card(p)));
      void this.markOffline(projects);
    }
    void this.renderFooter();
  }

  private card(p: Project): HTMLElement {
    const badge = h('span', { class: 'badge offline-badge', hidden: true }, 'offline ✓');
    badge.dataset.project = p.id;
    return h(
      'div',
      { class: 'project-card', 'data-testid': 'project-card' },
      h(
        'button',
        { type: 'button', class: 'project-open', onclick: () => this.nav.open(p.id) },
        icon('file'),
        h('span', { class: 'project-text' }, h('span', { class: 'project-name' }, p.name), h('span', { class: 'project-meta' }, `${p.main} · edited ${timeAgo(p.updated)}`)),
        badge,
      ),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Actions for ${p.name}`, onclick: () => this.menu(p) }, icon('more')),
    );
  }

  private async markOffline(projects: Project[]) {
    if (!navigator.serviceWorker?.controller) return;
    for (const p of projects) {
      if (!p.onDemand) continue;
      const missing = await uncachedFiles(p.onDemand);
      const badge = this.list.querySelector<HTMLElement>(`.offline-badge[data-project="${p.id}"]`);
      if (badge) badge.hidden = missing.length > 0;
    }
  }

  private async renderFooter() {
    const s = await offlineStatus();
    this.footer.replaceChildren(
      h('span', { class: s.ready ? 'ok' : 'muted' }, s.ready ? '● Ready offline' : s.supported ? '○ Preparing offline mode…' : 'Offline mode unavailable'),
      h('span', { class: 'muted' }, s.persisted ? ' · storage persistent' : ''),
    );
    if (!s.ready && s.supported && import.meta.env.PROD) setTimeout(() => void this.renderFooter(), 3000);
  }

  private async create() {
    const name = await promptDialog('New lab report', 'Lab report', { okLabel: 'Create' });
    if (!name) return;
    const p = await createFromTemplate(name);
    void requestPersistence();
    this.nav.open(p.id);
  }

  private async importZip() {
    const [file] = await pickFiles('.zip,application/zip,application/x-zip-compressed');
    if (!file) return;
    try {
      const { project, skipped } = await importZip(file, file.name.replace(/\.zip$/i, ''));
      void requestPersistence();
      if (skipped.length) toast(`Skipped ${skipped.length} unsafe path(s).`);
      this.nav.open(project.id);
    } catch (e) {
      toast('Import failed: ' + String((e as Error).message || e));
    }
  }

  private menu(p: Project) {
    actionSheet(p.name, [
      { label: 'Open', icon: 'edit', run: () => this.nav.open(p.id) },
      {
        label: 'Rename',
        icon: 'rename',
        run: async () => {
          const name = await promptDialog('Rename project', p.name, { okLabel: 'Rename' });
          if (!name) return;
          p.name = name;
          await db.putProject(p);
          await this.render();
        },
      },
      {
        label: 'Export .zip',
        icon: 'zip',
        run: async () => downloadBlob(await exportZip(p), safeFileName(p.name) + '.zip'),
      },
      {
        label: 'Delete',
        icon: 'trash',
        danger: true,
        run: async () => {
          if (!(await confirmDialog('Delete project?', `“${p.name}” and all its files will be removed from this device.`, 'Delete', true))) return;
          await db.deleteProject(p.id);
          await this.render();
        },
      },
    ]);
  }
}
