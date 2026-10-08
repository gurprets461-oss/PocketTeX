// PocketTeX engine worker.
//
// Loads the unmodified SwiftLaTeX pdfTeX build (swiftlatexpdftex.js/.wasm,
// AGPL-3.0) and replaces its network file resolver: TeX Live files come from
// the precached bundle first, then from the on-demand package tree (fetched
// with synchronous XHR, which the service worker answers from its cache when
// offline). The compile loop itself lives in driver.js.
//
// The worker does not rely on the service worker intercepting its own requests
// (not every browser routes dedicated-worker traffic through it): the main
// thread hands over the format and bundle, and package files fetched from the
// tree are read from / written to Cache Storage directly.
//
// Protocol (main thread -> worker), every request carries an `id`:
//   { type: 'init', format, bundle, manifest, endpoint }   (ArrayBuffers + JSON)
//   { type: 'sync', reset, writes: [{ path, data }], deletes: [path] }
//   { type: 'compile', main, preload: [tree URLs the project used last time] }
// Replies: { type: 'ready' | 'synced' | 'result' | 'error', id, ... }
// Progress: { type: 'progress', id, phase, pass }
/* global importScripts, FS, UTF8ToString, allocate, intArrayFromString, ALLOC_NORMAL,
   prepareExecutionContext, cleanDir, cwrap, _compileLaTeX, _compileBibtex */
'use strict';

const realPost = self.postMessage.bind(self);
let resolveRuntime;
let rejectRuntime;
const runtimeReady = new Promise((resolve, reject) => {
  resolveRuntime = resolve;
  rejectRuntime = reject;
});

// The glue announces readiness and aborts through postMessage; keep those
// messages inside the worker.
self.postMessage = function (msg, transfer) {
  if (msg && msg.cmd === undefined && msg.result === 'ok') {
    resolveRuntime();
    return;
  }
  if (msg && msg.status === -254) {
    rejectRuntime(new Error('engine aborted'));
    return;
  }
  realPost(msg, transfer);
};

importScripts('swiftlatexpdftex.js', 'driver.js');
const driver = self.PocketTeXDriver;

let bundle = new Map(); // name -> Uint8Array (precached files)
let manifest = null; // { dirs: [], files: { name: [dirIndex, size] } }
let endpoint = '';
const resolved = new Map(); // "format/name" -> MEMFS path, or null when definitely absent
const fromTree = new Map(); // MEMFS path -> URL, for files fetched from the on-demand tree
let compileState = {};
let usedOnDemand = new Set(); // URLs fetched from the on-demand tree this compile
let missing = new Set(); // names in the tree that could not be fetched (offline?)
const TREE_CACHE = 'pockettex-texlive';
const treeMem = new Map(); // URL -> bytes loaded from Cache Storage ahead of a compile
let fetchedNow = []; // [url, bytes] downloaded during this compile, to store in the cache

function cString(s) {
  return allocate(intArrayFromString(s), ALLOC_NORMAL);
}

function syncFetch(url) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false);
  xhr.responseType = 'arraybuffer';
  try {
    xhr.send();
  } catch (e) {
    return null;
  }
  return xhr.status === 200 && xhr.response ? new Uint8Array(xhr.response) : null;
}

function treeUrl(name) {
  const entry = manifest && Object.prototype.hasOwnProperty.call(manifest.files, name) ? manifest.files[name] : null;
  return entry ? endpoint + manifest.dirs[entry[0]] + '/' + name : null;
}

function resolveTexFile(name, format) {
  let unreachable = false;
  for (const c of driver.candidates(name, format)) {
    const dest = '/tex/' + c;
    const data = bundle.get(c);
    if (data) {
      FS.writeFile(dest, data, { canOwn: true });
      bundle.delete(c);
      return dest;
    }
    if (FS.analyzePath(dest).exists) return dest;
    const url = treeUrl(c);
    if (url) {
      let bytes = treeMem.get(url) || null;
      if (bytes) treeMem.delete(url);
      else {
        bytes = syncFetch(url);
        if (bytes) fetchedNow.push([url, bytes]);
      }
      if (bytes) {
        FS.writeFile(dest, bytes, { canOwn: true });
        fromTree.set(dest, url);
        return dest;
      }
      missing.add(c);
      unreachable = true;
    }
  }
  // Do not remember failures caused by the network; retry on the next compile.
  return unreachable ? undefined : null;
}

self.kpse_find_file_impl = function (nameptr, format) {
  const name = UTF8ToString(nameptr);
  if (name.includes('/')) return 0;
  const key = format + '/' + name;
  let path = resolved.get(key);
  if (path === undefined) {
    path = resolveTexFile(name, format);
    if (path !== undefined) resolved.set(key, path);
    else path = null;
  }
  if (path && fromTree.has(path)) usedOnDemand.add(fromTree.get(path));
  return path ? cString(path) : 0;
};

// Bitmap (PK) fonts cannot be generated in the browser; Type 1 fonts are used instead.
self.kpse_find_pk_impl = function () {
  return 0;
};

async function gunzip(buf) {
  // Gzip magic: decompress unless the server already did (Content-Encoding).
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser lacks DecompressionStream (needs Safari 16.4+ / Chrome 80+).');
    }
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return buf;
}

function unpackBundle(raw) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + headerLen)));
  const start = 4 + headerLen;
  const map = new Map();
  for (const [name, off, len] of header) map.set(name, raw.subarray(start + off, start + off + len));
  return map;
}

async function init(msg) {
  endpoint = msg.endpoint.endsWith('/') ? msg.endpoint : msg.endpoint + '/';
  const [fmt, bundleRaw] = await Promise.all([
    gunzip(new Uint8Array(msg.format)),
    gunzip(new Uint8Array(msg.bundle)),
  ]);
  await runtimeReady;
  bundle = unpackBundle(bundleRaw);
  manifest = msg.manifest || null;
  FS.writeFile('/tex/swiftlatexpdftex.fmt', fmt, { canOwn: true });
  resolved.set('10/swiftlatexpdftex.fmt', '/tex/swiftlatexpdftex.fmt');
  return { bundleFiles: bundle.size, treeFiles: manifest ? Object.keys(manifest.files).length : 0 };
}

function mkdirs(path) {
  const parts = path.split('/').slice(0, -1);
  let cur = '/work';
  for (const p of parts) {
    cur += '/' + p;
    if (!FS.analyzePath(cur).exists) FS.mkdir(cur);
  }
}

function sync(msg) {
  if (msg.reset) {
    cleanDir('/work');
    compileState = {};
  }
  for (const p of msg.deletes || []) {
    try {
      FS.unlink('/work/' + p);
    } catch (e) {
      /* already gone */
    }
  }
  for (const f of msg.writes || []) {
    mkdirs(f.path);
    FS.writeFile('/work/' + f.path, f.data);
  }
}

async function openTreeCache() {
  try {
    return self.caches ? await caches.open(TREE_CACHE) : null;
  } catch (e) {
    return null; // e.g. storage disabled
  }
}

/** Load tree files from Cache Storage into memory so the sync lookup needs no network. */
async function preload(urls) {
  const cache = await openTreeCache();
  if (!cache) return 0;
  const inMemfs = new Set(fromTree.values());
  let n = 0;
  for (const url of urls) {
    if (treeMem.has(url) || inMemfs.has(url)) continue;
    const hit = await cache.match(url);
    if (hit) {
      treeMem.set(url, new Uint8Array(await hit.arrayBuffer()));
      n++;
    }
  }
  return n;
}

async function persistFetched() {
  const items = fetchedNow;
  fetchedNow = [];
  const cache = await openTreeCache();
  if (!cache) return;
  for (const [url, bytes] of items) {
    if (!(await cache.match(url))) await cache.put(url, new Response(bytes));
  }
}

async function compile(msg) {
  const t0 = performance.now();
  await preload(msg.preload || []);
  let r = runLatex(msg);
  // Offline and a file was missing from the preload list but is in the cache: retry once.
  if (r.missing.length) {
    const urls = r.missing.map(treeUrl).filter(Boolean);
    if ((await preload(urls)) > 0) r = runLatex(msg);
  }
  const pdf = r.pdf ? r.pdf.slice() : null;
  realPost(
    {
      type: 'result',
      id: msg.id,
      status: r.status,
      passes: r.passes,
      bibtex: r.bibtex,
      log: r.log,
      bibtexLog: r.bibtexLog,
      pdf,
      onDemand: r.onDemand,
      missing: r.missing,
      ms: Math.round(performance.now() - t0),
    },
    pdf ? [pdf.buffer] : [],
  );
  await persistFetched().catch(() => {});
}

function runLatex(msg) {
  usedOnDemand = new Set();
  missing = new Set();
  const setMain = cwrap('setMainEntry', 'number', ['string']);
  const engine = {
    latex(main) {
      prepareExecutionContext();
      setMain(main);
      return { status: _compileLaTeX(), log: self.memlog };
    },
    bibtex(main) {
      prepareExecutionContext();
      setMain(main);
      return { status: _compileBibtex(), log: self.memlog };
    },
    readFile(p) {
      try {
        return FS.readFile('/work/' + p);
      } catch (e) {
        return null;
      }
    },
  };
  const r = driver.compile(engine, msg.main, compileState, (p) =>
    realPost({ type: 'progress', id: msg.id, phase: p.phase, pass: p.pass }),
  );
  return { ...r, onDemand: [...usedOnDemand], missing: [...missing] };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      const info = await init(msg);
      realPost({ type: 'ready', id: msg.id, ...info });
    } else if (msg.type === 'sync') {
      await runtimeReady;
      sync(msg);
      realPost({ type: 'synced', id: msg.id });
    } else if (msg.type === 'compile') {
      await runtimeReady;
      await compile(msg);
    } else {
      throw new Error('unknown message ' + msg.type);
    }
  } catch (err) {
    realPost({
      type: 'error',
      id: msg.id,
      message: String((err && err.message) || err),
      log: self.memlog || '',
      fatal: msg.type !== 'sync',
    });
  }
};
