// Runs the vendored SwiftLaTeX pdfTeX WebAssembly engine under Node.js.
//
// The Emscripten glue (public/engine/swiftlatexpdftex.js) was written for a
// Web Worker: it expects `self`, `postMessage` and a synchronous XHR file
// resolver. This module shims those so the exact same binary can be used at
// build time to dump the LaTeX format and to discover which TeX Live files a
// document needs. File lookups are delegated to a caller-supplied resolver.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENGINE_DIR = path.join(__dirname, '..', '..', 'public', 'engine');

let loaded = null;

/**
 * @param {{ resolve: (name: string, format: number) => string | null }} opts
 *   resolve() returns an absolute path on disk for a TeX Live file, or null.
 */
function loadEngine(opts) {
  if (loaded) throw new Error('engine already loaded in this process');
  const lookups = [];
  const cache = new Map();

  loaded = new Promise((resolveReady) => {
    globalThis.self = globalThis;
    globalThis.require = require;
    globalThis.__dirname = ENGINE_DIR;
    globalThis.__filename = path.join(ENGINE_DIR, 'swiftlatexpdftex.js');
    globalThis.postMessage = (msg) => {
      if (msg && msg.result === 'ok' && !msg.cmd) resolveReady();
    };
    // Node's fetch() cannot load file paths; hide it so the glue falls back to fs.
    const savedFetch = globalThis.fetch;
    delete globalThis.fetch;
    const src = fs.readFileSync(globalThis.__filename, 'utf8');
    vm.runInThisContext(src, { filename: 'swiftlatexpdftex.js' });
    globalThis.fetch = savedFetch;

    globalThis.kpse_find_file_impl = function (nameptr, format) {
      const name = UTF8ToString(nameptr);
      const key = format + '/' + name;
      let dest = cache.get(key);
      if (dest === undefined) {
        dest = null;
        if (!name.includes('/')) {
          const found = opts.resolve(name, format);
          lookups.push({ format, name, path: found });
          if (found) {
            dest = '/tex/' + path.basename(found);
            FS.writeFile(dest, fs.readFileSync(found));
          }
        }
        cache.set(key, dest);
      }
      return dest ? allocate(intArrayFromString(dest), 'i8', ALLOC_NORMAL) : 0;
    };
    globalThis.kpse_find_pk_impl = function (nameptr, dpi) {
      lookups.push({ format: 'pk', name: UTF8ToString(nameptr) + '@' + dpi, path: null });
      return 0;
    };
  });

  const api = {
    lookups,
    ready: loaded,
    log: () => self.memlog,
    /** Dump the LaTeX format (pdflatex.ini). Returns the .fmt bytes. */
    buildFormat() {
      prepareExecutionContext();
      const status = _compileFormat();
      if (status !== 0) {
        throw new Error('format build failed (status ' + status + ')\n' + self.memlog.slice(-3000));
      }
      return Buffer.from(FS.readFile('/work/pdflatex.fmt'));
    },
    /** Forget earlier lookups so the next compile records every file it opens. */
    resetLookups() {
      cache.clear();
      lookups.length = 0;
    },
    installFormat(bytes) {
      FS.writeFile('/tex/swiftlatexpdftex.fmt', bytes);
      cache.set('10/swiftlatexpdftex.fmt', '/tex/swiftlatexpdftex.fmt');
    },
    /** Replace the contents of /work with a directory from disk. */
    loadProject(dir) {
      cleanDir('/work');
      const walk = (abs, rel) => {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
          const r = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) {
            FS.mkdir('/work/' + r);
            walk(path.join(abs, e.name), r);
          } else {
            FS.writeFile('/work/' + r, fs.readFileSync(path.join(abs, e.name)));
          }
        }
      };
      walk(dir, '');
    },
    /** One pdfLaTeX pass. Returns { status, log }. */
    latex(mainFile) {
      prepareExecutionContext();
      cwrap('setMainEntry', 'number', ['string'])(mainFile);
      const status = _compileLaTeX();
      return { status, log: self.memlog };
    },
    bibtex(mainFile) {
      prepareExecutionContext();
      cwrap('setMainEntry', 'number', ['string'])(mainFile);
      const status = _compileBibtex();
      return { status, log: self.memlog };
    },
    readFile(p) {
      try {
        return Buffer.from(FS.readFile('/work/' + p));
      } catch {
        return null;
      }
    },
  };
  return api;
}

/** Load public/engine/driver.js (a classic browser script) as a Node object. */
function loadDriver() {
  const sandbox = { self: {}, TextDecoder, Math };
  vm.runInNewContext(fs.readFileSync(path.join(ENGINE_DIR, 'driver.js'), 'utf8'), sandbox, {
    filename: 'driver.js',
  });
  return sandbox.self.PocketTeXDriver;
}

module.exports = { loadEngine, loadDriver, ENGINE_DIR };
