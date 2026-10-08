// IndexedDB storage: projects, their files and the last compiled output.
// Deliberately tiny promise wrapper instead of a dependency.

export interface Project {
  id: string;
  name: string;
  main: string;
  created: number;
  updated: number;
  /** URLs of on-demand package files this project needed at its last compile. */
  onDemand?: string[];
  offlineCheckedAt?: number;
}

export type FileData = string | ArrayBuffer;

export interface ProjectFile {
  projectId: string;
  path: string;
  /** Text files are strings, everything else an ArrayBuffer. Folders: empty string. */
  data: FileData;
  kind: 'text' | 'binary' | 'dir';
  rev: number;
  mtime: number;
}

export interface Output {
  projectId: string;
  pdf: ArrayBuffer | null;
  log: string;
  bibtexLog: string;
  status: number;
  time: number;
  passes: number;
}

const DB_NAME = 'pockettex';
const DB_VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('projects', { keyPath: 'id' });
        const files = db.createObjectStore('files', { keyPath: ['projectId', 'path'] });
        files.createIndex('byProject', 'projectId');
        db.createObjectStore('outputs', { keyPath: 'projectId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Database upgrade blocked by another tab.'));
    });
  }
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (t: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await open();
  const t = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
  const result = await fn(t);
  await done;
  return result;
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const db = {
  async listProjects(): Promise<Project[]> {
    const all = await tx(['projects'], 'readonly', (t) => wrap(t.objectStore('projects').getAll()));
    return (all as Project[]).sort((a, b) => b.updated - a.updated);
  },

  getProject(id: string): Promise<Project | undefined> {
    return tx(['projects'], 'readonly', (t) => wrap(t.objectStore('projects').get(id)));
  },

  putProject(p: Project): Promise<void> {
    return tx(['projects'], 'readwrite', async (t) => {
      await wrap(t.objectStore('projects').put(p));
    });
  },

  async touchProject(id: string): Promise<void> {
    await tx(['projects'], 'readwrite', async (t) => {
      const store = t.objectStore('projects');
      const p = (await wrap(store.get(id))) as Project | undefined;
      if (p) {
        p.updated = Date.now();
        await wrap(store.put(p));
      }
    });
  },

  async deleteProject(id: string): Promise<void> {
    await tx(['projects', 'files', 'outputs'], 'readwrite', async (t) => {
      await wrap(t.objectStore('projects').delete(id));
      await wrap(t.objectStore('outputs').delete(id));
      const range = IDBKeyRange.bound([id, ''], [id, '￿']);
      await wrap(t.objectStore('files').delete(range));
    });
  },

  async listFiles(projectId: string): Promise<ProjectFile[]> {
    const all = await tx(['files'], 'readonly', (t) =>
      wrap(t.objectStore('files').index('byProject').getAll(projectId)),
    );
    return (all as ProjectFile[]).sort((a, b) => a.path.localeCompare(b.path));
  },

  getFile(projectId: string, path: string): Promise<ProjectFile | undefined> {
    return tx(['files'], 'readonly', (t) => wrap(t.objectStore('files').get([projectId, path])));
  },

  /** Insert or replace files, bumping their revision. */
  async putFiles(projectId: string, files: { path: string; data: FileData; kind: ProjectFile['kind'] }[]) {
    const now = Date.now();
    await tx(['files'], 'readwrite', async (t) => {
      const store = t.objectStore('files');
      for (const f of files) {
        const old = (await wrap(store.get([projectId, f.path]))) as ProjectFile | undefined;
        await wrap(
          store.put({ projectId, path: f.path, data: f.data, kind: f.kind, rev: (old?.rev ?? 0) + 1, mtime: now }),
        );
      }
    });
  },

  async deleteFiles(projectId: string, paths: string[]): Promise<void> {
    await tx(['files'], 'readwrite', async (t) => {
      for (const p of paths) await wrap(t.objectStore('files').delete([projectId, p]));
    });
  },

  /** Rename a file or a folder (and everything below it). */
  async renamePath(projectId: string, from: string, to: string): Promise<void> {
    const files = await this.listFiles(projectId);
    const moves = files.filter((f) => f.path === from || f.path.startsWith(from + '/'));
    const now = Date.now();
    await tx(['files'], 'readwrite', async (t) => {
      const store = t.objectStore('files');
      for (const f of moves) {
        const next = to + f.path.slice(from.length);
        await wrap(store.delete([projectId, f.path]));
        await wrap(store.put({ ...f, path: next, rev: f.rev + 1, mtime: now }));
      }
    });
  },

  getOutput(projectId: string): Promise<Output | undefined> {
    return tx(['outputs'], 'readonly', (t) => wrap(t.objectStore('outputs').get(projectId)));
  },

  putOutput(o: Output): Promise<void> {
    return tx(['outputs'], 'readwrite', async (t) => {
      await wrap(t.objectStore('outputs').put(o));
    });
  },
};
