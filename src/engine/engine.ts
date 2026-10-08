// Main-thread side of the compiler: owns the engine worker, keeps the worker's
// in-memory copy of the project in sync and runs compiles one at a time.
import type { ProjectFile } from '../db.ts';
import { appBaseUrl, texliveBaseUrl, texliveEndpoint } from '../config.ts';

export interface TexliveMeta {
  texlive: string;
  engine: string;
  built: string;
  format: { file: string; bytes: number; gzBytes: number };
  bundle: { file: string; files: number; bytes: number; gzBytes: number };
  tree: { mode: string; files: number; bytes: number };
}

export interface CompileResult {
  status: number;
  passes: number;
  bibtex: boolean;
  log: string;
  bibtexLog: string;
  pdf: Uint8Array | null;
  onDemand: string[];
  missing: string[];
  ms: number;
}

export interface Progress {
  phase: 'init' | 'sync' | 'latex' | 'bibtex';
  pass?: number;
}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: (p: Progress) => void;
};

export class EngineCrash extends Error {}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url} (HTTP ${r.status}). Reconnect once to finish the download.`);
  return r.arrayBuffer();
}

let metaPromise: Promise<TexliveMeta> | null = null;
export function texliveMeta(): Promise<TexliveMeta> {
  if (!metaPromise) {
    metaPromise = fetch(texliveBaseUrl() + 'texlive.json').then((r) => {
      if (!r.ok) throw new Error('texlive.json missing (HTTP ' + r.status + ')');
      return r.json();
    });
    metaPromise.catch(() => (metaPromise = null));
  }
  return metaPromise;
}

class Engine {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private projectId: string | null = null;
  private sent = new Map<string, number>(); // path -> rev in the worker
  private queue: Promise<unknown> = Promise.resolve();
  busy = false;

  /** Resolves once the service worker (if any) controls the page, so engine downloads get cached. */
  beforeStart: () => Promise<void> = async () => {};

  private request<T>(msg: Record<string, unknown>, transfer: Transferable[] = [], onProgress?: Pending['onProgress']) {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker!.postMessage({ ...msg, id }, transfer);
    });
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await this.beforeStart();
      const meta = await texliveMeta();
      const w = new Worker(appBaseUrl() + 'engine/engine-worker.js');
      this.worker = w;
      w.onmessage = (ev) => this.onMessage(ev.data);
      w.onerror = (ev) => {
        ev.preventDefault();
        this.crash(new EngineCrash(ev.message || 'Engine worker failed'));
      };
      // Fetch on the main thread: it is always controlled by the service
      // worker, so these come from the offline cache.
      const base = texliveBaseUrl();
      const endpoint = texliveEndpoint();
      const [format, bundle, manifest] = await Promise.all([
        fetchBuffer(base + meta.format.file),
        fetchBuffer(base + meta.bundle.file),
        fetch(endpoint + 'manifest.json')
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      await this.request({ type: 'init', format, bundle, manifest, endpoint }, [format, bundle]);
    })();
    this.ready.catch(() => this.reset());
    return this.ready;
  }

  private onMessage(msg: any) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') {
      p.onProgress?.({ phase: msg.phase, pass: msg.pass });
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === 'error') {
      const err = new EngineCrash(msg.message + (msg.log ? '\n' + String(msg.log).slice(-2000) : ''));
      p.reject(err);
      if (msg.fatal) this.reset();
    } else {
      p.resolve(msg);
    }
  }

  private crash(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.reset();
  }

  /** Throw away the worker; the next compile starts a fresh one. */
  reset() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.projectId = null;
    this.sent.clear();
  }

  /** Abort a running compile (e.g. an infinite loop in a macro). */
  stop() {
    if (!this.worker) return;
    this.crash(new EngineCrash('Compilation stopped.'));
  }

  warmUp(): Promise<void> {
    return this.start();
  }

  compile(
    projectId: string,
    files: ProjectFile[],
    main: string,
    preload: string[],
    onProgress?: (p: Progress) => void,
  ): Promise<CompileResult> {
    const run = async () => {
      this.busy = true;
      try {
        onProgress?.({ phase: 'init' });
        await this.start();
        onProgress?.({ phase: 'sync' });
        await this.sync(projectId, files);
        const r = await this.request<CompileResult & { type: string }>({ type: 'compile', main, preload }, [], onProgress);
        return r;
      } finally {
        this.busy = false;
      }
    };
    const job = this.queue.then(run, run);
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async sync(projectId: string, files: ProjectFile[]) {
    const reset = this.projectId !== projectId;
    if (reset) {
      this.sent.clear();
      this.projectId = projectId;
    }
    const writes: { path: string; data: Uint8Array }[] = [];
    const transfer: Transferable[] = [];
    const present = new Set<string>();
    const enc = new TextEncoder();
    for (const f of files) {
      if (f.kind === 'dir') continue;
      present.add(f.path);
      if (this.sent.get(f.path) === f.rev) continue;
      const data = typeof f.data === 'string' ? enc.encode(f.data) : new Uint8Array(f.data.slice(0));
      writes.push({ path: f.path, data });
      transfer.push(data.buffer);
    }
    const deletes = [...this.sent.keys()].filter((p) => !present.has(p));
    await this.request({ type: 'sync', reset, writes, deletes }, transfer);
    for (const p of deletes) this.sent.delete(p);
    for (const f of files) if (f.kind !== 'dir') this.sent.set(f.path, f.rev);
  }
}

export const engine = new Engine();
