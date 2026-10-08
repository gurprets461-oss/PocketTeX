// Service worker registration, update prompts, persistent storage and the
// per-project "make available offline" prefetch.
import { appBaseUrl } from './config.ts';
import { toast } from './ui/dialogs.ts';

const TREE_CACHE = 'pockettex-texlive';

export interface OfflineStatus {
  supported: boolean;
  /** The service worker controls this page: app shell + engine are cached. */
  ready: boolean;
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
}

let controlled: Promise<boolean> = Promise.resolve(false);
const listeners = new Set<() => void>();

export function onOfflineChange(fn: () => void): void {
  listeners.add(fn);
}

function notify() {
  for (const fn of listeners) fn();
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  const sw = navigator.serviceWorker;
  const base = appBaseUrl();
  controlled = new Promise((resolve) => {
    if (sw.controller) resolve(true);
    sw.addEventListener('controllerchange', () => {
      resolve(true);
      notify();
    });
  });
  let reloading = false;
  sw.register(base + 'sw.js', { scope: base })
    .then((reg) => {
      const watch = (w: ServiceWorker | null) => {
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && sw.controller) {
            toast('A new version of PocketTeX is ready.', {
              label: 'Reload',
              run: () => {
                reloading = true;
                w.postMessage('SKIP_WAITING');
              },
            }, 15000);
          }
          if (w.state === 'activated' && !reloading) notify();
        });
      };
      if (reg.waiting && sw.controller) watch(reg.waiting);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      // Check for updates when the app comes back to the foreground.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update().catch(() => {});
      });
    })
    .catch((e) => console.warn('Service worker registration failed', e));
  sw.addEventListener('controllerchange', () => {
    if (reloading) location.reload();
  });
}

/**
 * Wait (up to `ms`) for the service worker to control the page, so the engine's
 * downloads are served from / stored in the offline cache.
 */
export async function waitForServiceWorker(ms = 60000): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return false;
  return Promise.race([controlled, new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
}

export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export async function offlineStatus(): Promise<OfflineStatus> {
  const supported = 'serviceWorker' in navigator && 'caches' in window;
  let persisted: boolean | null = null;
  let usage: number | null = null;
  let quota: number | null = null;
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? null;
    const est = await navigator.storage?.estimate?.();
    usage = est?.usage ?? null;
    quota = est?.quota ?? null;
  } catch {
    /* ignore */
  }
  return { supported, ready: !!navigator.serviceWorker?.controller, persisted, usage, quota };
}

/** Which of these on-demand package URLs are not yet in the offline cache. */
export async function uncachedFiles(urls: string[]): Promise<string[]> {
  if (!('caches' in window) || !urls.length) return [];
  const cache = await caches.open(TREE_CACHE);
  const out: string[] = [];
  for (const u of urls) if (!(await cache.match(u))) out.push(u);
  return out;
}

/** Download (through the service worker, which caches them) any missing package files. */
export async function prefetch(urls: string[], onProgress?: (done: number, total: number) => void): Promise<{ fetched: number; failed: string[]; bytes: number }> {
  const todo = await uncachedFiles(urls);
  let done = 0;
  let bytes = 0;
  const failed: string[] = [];
  const cache = 'caches' in window ? await caches.open(TREE_CACHE) : null;
  const queue = [...todo];
  async function worker() {
    while (queue.length) {
      const url = queue.shift()!;
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(String(resp.status));
        const buf = await resp.clone().arrayBuffer();
        bytes += buf.byteLength;
        // Without a controlling service worker, store it ourselves.
        if (cache && !navigator.serviceWorker?.controller) await cache.put(url, resp);
      } catch {
        failed.push(url);
      }
      onProgress?.(++done, todo.length);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { fetched: todo.length - failed.length, failed, bytes };
}
