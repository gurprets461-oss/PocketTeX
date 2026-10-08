// PocketTeX service worker. Generated at build time from src/sw-template.js by
// the `pockettex` plugin in vite.config.ts, which injects the precache list.
//
// Caches:
//   pockettex-precache  app shell, engine, LaTeX format and the package bundle.
//                       Entries are keyed by URL + content hash, so unchanged
//                       files (e.g. the 6 MB format) survive app updates.
//   pockettex-texlive   files fetched from the on-demand package tree;
//                       cache-first, kept across app versions.
/* global self, caches, fetch, URL, Response */
'use strict';

const PRECACHE = __PRECACHE__; // [[path relative to scope, revision], ...]
const VERSION = __VERSION__;
const TEXLIVE_ENDPOINT = new URL(__TEXLIVE_ENDPOINT__, self.registration.scope).href;
const TEXLIVE_ID = __TEXLIVE_ID__;

const PRECACHE_CACHE = 'pockettex-precache';
const TREE_CACHE = 'pockettex-texlive';
const scope = self.registration.scope;
const precacheKeys = new Map(PRECACHE.map(([path, rev]) => [new URL(path, scope).href, rev]));
const keyFor = (url, rev) => url + (url.includes('?') ? '&' : '?') + '__rev=' + rev;
const INDEX = new URL('index.html', scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE_CACHE);
      const existing = new Set((await cache.keys()).map((r) => r.url));
      const todo = [...precacheKeys].filter(([url, rev]) => !existing.has(keyFor(url, rev)));
      // A few parallel downloads; the format and bundle are several MB each.
      let next = 0;
      async function worker() {
        while (next < todo.length) {
          const [url, rev] = todo[next++];
          const resp = await fetch(url, { cache: 'reload' });
          if (!resp.ok) throw new Error(`precache ${url}: HTTP ${resp.status}`);
          await cache.put(keyFor(url, rev), resp);
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE_CACHE);
      const wanted = new Set([...precacheKeys].map(([url, rev]) => keyFor(url, rev)));
      for (const req of await cache.keys()) if (!wanted.has(req.url)) await cache.delete(req);
      // Drop on-demand files from an older TeX Live build.
      const tree = await caches.open(TREE_CACHE);
      const marker = await tree.match('/__texlive_id__');
      const id = marker ? await marker.text() : null;
      if (id !== TEXLIVE_ID) {
        await caches.delete(TREE_CACHE);
        const fresh = await caches.open(TREE_CACHE);
        await fresh.put('/__texlive_id__', new Response(TEXLIVE_ID));
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: VERSION });
});

async function fromPrecache(url) {
  const rev = precacheKeys.get(url);
  const cache = await caches.open(PRECACHE_CACHE);
  const hit = await cache.match(keyFor(url, rev));
  if (hit) return hit;
  const resp = await fetch(url);
  if (resp.ok) await cache.put(keyFor(url, rev), resp.clone());
  return resp;
}

async function fromTree(request) {
  const cache = await caches.open(TREE_CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  const resp = await fetch(request);
  if (resp.ok) await cache.put(request.url, resp.clone());
  return resp;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = request.url.split('#')[0];

  if (request.mode === 'navigate' && url.startsWith(scope)) {
    event.respondWith(fromPrecache(INDEX).catch(() => fetch(request)));
    return;
  }
  const bare = url.split('?')[0];
  if (precacheKeys.has(bare)) {
    event.respondWith(fromPrecache(bare));
    return;
  }
  if (url.startsWith(TEXLIVE_ENDPOINT)) {
    event.respondWith(fromTree(request));
  }
});
