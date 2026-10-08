#!/usr/bin/env node
// Builds everything PocketTeX needs from a local TeX Live installation:
//
//   texlive-build/
//     texlive.json                      metadata read by the app
//     swiftlatexpdftex-<hash>.fmt.gz    LaTeX format dumped by the wasm engine
//     bundle-<hash>.bin.gz              precached files (lab-report closure)
//     tree/manifest.json                name -> path index of the package tree
//     tree/<texmf relative path>        on-demand package files
//
// Requires TeX Live with kpsewhich on PATH (CI uses Ubuntu's texlive-* packages,
// see .github/workflows/deploy.yml). Options:
//   --out <dir>        output directory (default: texlive-build)
//   --tree full|seeds  on-demand tree contents (default: full). "seeds" only
//                      contains the bundled files; useful for fast local builds.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadEngine, loadDriver } = require('./texlive/engine-node.cjs');
const driver = loadDriver();

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const OUT = path.resolve(ROOT, opt('out', 'texlive-build'));
const TREE_MODE = opt('tree', process.env.TEXLIVE_TREE || 'full');

// Seed documents whose complete file closure is precached.
const SEEDS = [
  ['tests/fixtures/orgo-lab', 'main.tex'],
  ['templates/lab-report', 'main.tex'],
  ['scripts/texlive/seeds/common', 'main.tex'],
  ['scripts/texlive/seeds/t1-fonts', 'main.tex'],
  ['scripts/texlive/seeds/t1-lmodern', 'main.tex'],
];

// ---------------------------------------------------------------------------
// TeX Live discovery

function sh(cmd, argv) {
  return execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
}

try {
  sh('kpsewhich', ['--version']);
} catch {
  console.error('kpsewhich not found: install TeX Live first (see README, "Building").');
  process.exit(1);
}

// Search roots in kpathsea priority order (first wins on duplicates).
const ROOTS = sh('kpsewhich', ['-progname=pdflatex', '-expand-path=$TEXMF'])
  .split(':')
  .filter((d) => d && fs.existsSync(d) && !d.includes('/root/') && !d.startsWith(process.env.HOME || '/nonexistent'));

let texliveVersion = 'unknown';
try {
  texliveVersion = 'TeX Live ' + sh('dpkg-query', ['-W', '-f=${Version}', 'texlive-base']) + ' (Ubuntu)';
} catch {
  try {
    texliveVersion = sh('pdftex', ['--version']).split('\n')[0];
  } catch { /* keep unknown */ }
}

// Which files go into the on-demand tree.
const INCLUDE_DIRS = [
  'tex/latex/', 'tex/generic/', 'tex/plain/',
  'fonts/tfm/', 'fonts/vf/', 'fonts/type1/', 'fonts/enc/', 'fonts/map/pdftex/', 'fonts/map/dvips/',
  'bibtex/bst/',
];
// Large packages that are of no use in a lab report, or need another engine.
const EXCLUDE_DIRS = [
  'tex/generic/tex4ht/', 'tex/latex/utfsym/', 'tex/latex/worldflags/', 'tex/latex/hwemoji/',
  'tex/latex/twemojis/', 'tex/latex/realhats/', 'tex/latex/lwarp/', 'tex/latex/ucs/data/',
];
const EXCLUDE_FILE = /(^README|^readme|\.(md|txt|html?|lua|py|pl|sh|bat|ps1|log|ins|dtx|zip|gz)$|^Makefile$)/;

function treeRelPath(abs) {
  for (const root of ROOTS) {
    if (abs.startsWith(root + '/')) return abs.slice(root.length + 1);
  }
  return null;
}

function included(rel) {
  return (
    INCLUDE_DIRS.some((d) => rel.startsWith(d)) &&
    !EXCLUDE_DIRS.some((d) => rel.startsWith(d)) &&
    !EXCLUDE_FILE.test(path.basename(rel))
  );
}

function kpseFormatFor(name) {
  const ext = path.extname(name).toLowerCase();
  return {
    '.tfm': 'tfm', '.vf': 'vf', '.pfb': 'type1 fonts', '.pfa': 'type1 fonts', '.enc': 'enc files',
    '.map': 'map', '.bst': 'bst', '.bib': 'bib',
  }[ext] || 'tex';
}

/** Index every file in the TeX Live roots by basename (kpathsea-preferred path wins). */
function indexTexLive() {
  const byName = new Map(); // name -> [abs paths in root priority order]
  for (const root of ROOTS) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        let isDir = e.isDirectory();
        let isFile = e.isFile();
        if (e.isSymbolicLink()) {
          try {
            const st = fs.statSync(abs);
            isDir = st.isDirectory();
            isFile = st.isFile();
          } catch {
            continue;
          }
        }
        if (isDir) stack.push(abs);
        else if (isFile) {
          const rel = abs.slice(root.length + 1);
          if (!included(rel)) continue;
          const list = byName.get(e.name);
          if (list) list.push(abs);
          else byName.set(e.name, [abs]);
        }
      }
    }
  }
  // Ask kpathsea which copy wins for duplicated names, in batches per format.
  const dups = [...byName].filter(([, l]) => l.length > 1).map(([n]) => n);
  const byFormat = new Map();
  for (const n of dups) {
    const f = kpseFormatFor(n);
    if (!byFormat.has(f)) byFormat.set(f, []);
    byFormat.get(f).push(n);
  }
  const chosen = new Map();
  for (const [format, names] of byFormat) {
    for (let i = 0; i < names.length; i += 400) {
      const batch = names.slice(i, i + 400);
      let out = '';
      try {
        out = sh('kpsewhich', ['-progname=pdflatex', '-engine=pdftex', '-format=' + format, ...batch]);
      } catch (e) {
        out = String(e.stdout || '');
      }
      for (const p of out.split('\n')) if (p) chosen.set(path.basename(p), p);
    }
  }
  const index = new Map();
  for (const [name, list] of byName) {
    const pick = chosen.get(name);
    index.set(name, pick && list.includes(pick) ? pick : list[0]);
  }
  return index;
}

// ---------------------------------------------------------------------------

const t0 = Date.now();
console.log('TeX Live:', texliveVersion);
console.log('Roots:', ROOTS.join(' '));
const index = indexTexLive();
console.log(`Indexed ${index.size} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Files needed while dumping the format live outside the tree filter
// (pdflatex.ini, language.dat, hyphenation patterns), so resolve them with kpsewhich.
const kpseCache = new Map();
function kpsewhich(name) {
  if (!kpseCache.has(name)) {
    let p = null;
    try {
      p = sh('kpsewhich', ['-progname=pdflatex', '-engine=pdftex', name]) || null;
    } catch { /* not found */ }
    kpseCache.set(name, p);
  }
  return kpseCache.get(name);
}

let phase = 'format';
const engine = loadEngine({
  resolve(name, format) {
    for (const c of driver.candidates(name, format)) {
      const hit = index.get(c) || (phase === 'format' || format === 11 ? kpsewhich(c) : null);
      if (hit) return hit;
    }
    return null;
  },
});
await engine.ready;

const fmt = engine.buildFormat();
console.log(`Format: ${(fmt.length / 1e6).toFixed(1)} MB`);
engine.resetLookups();
engine.installFormat(fmt);
phase = 'seeds';

// Compile each seed and record what it loaded.
for (const [dir, main] of SEEDS) {
  const abs = path.join(ROOT, dir);
  engine.loadProject(abs);
  const state = {};
  const r = driver.compile(
    {
      latex: (m) => engine.latex(m),
      bibtex: (m) => engine.bibtex(m),
      readFile: (p) => engine.readFile(p),
    },
    main,
    state,
  );
  if (r.status !== 0 || !r.pdf) {
    console.error(r.log.slice(-4000));
    throw new Error(`seed ${dir} failed to compile (status ${r.status})`);
  }
  const pages = (r.log.match(/Output written on .*\((\d+) pages?/) || [])[1];
  console.log(`Seed ${dir}: ${pages} page(s), ${r.passes} pass(es)${r.bibtex ? ' + BibTeX' : ''}`);
}

const bundleFiles = new Map(); // name -> abs path
for (const l of engine.lookups) {
  if (l.path) bundleFiles.set(path.basename(l.path), l.path);
}

// ---------------------------------------------------------------------------
// Write outputs

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'tree'), { recursive: true });

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);

// Format
const fmtGz = zlib.gzipSync(fmt, { level: 9 });
const fmtName = `swiftlatexpdftex-${hash(fmtGz)}.fmt.gz`;
fs.writeFileSync(path.join(OUT, fmtName), fmtGz);

// Bundle: [u32 header length][header JSON][file data...], gzipped.
const names = [...bundleFiles.keys()].sort();
const blobs = names.map((n) => fs.readFileSync(bundleFiles.get(n)));
let offset = 0;
const header = Buffer.from(
  JSON.stringify(names.map((n, i) => {
    const entry = [n, offset, blobs[i].length];
    offset += blobs[i].length;
    return entry;
  })),
);
const len = Buffer.alloc(4);
len.writeUInt32LE(header.length);
const bundleRaw = Buffer.concat([len, header, ...blobs]);
const bundleGz = zlib.gzipSync(bundleRaw, { level: 9 });
const bundleName = `bundle-${hash(bundleGz)}.bin.gz`;
fs.writeFileSync(path.join(OUT, bundleName), bundleGz);

// On-demand tree + manifest (name -> [dir index, size]).
const treeEntries = new Map();
if (TREE_MODE === 'full') {
  for (const [name, abs] of index) treeEntries.set(name, abs);
}
for (const [name, abs] of bundleFiles) treeEntries.set(name, abs);

const dirs = [];
const dirIdx = new Map();
const files = {};
let treeBytes = 0;
for (const name of [...treeEntries.keys()].sort()) {
  const abs = treeEntries.get(name);
  let rel = treeRelPath(abs);
  if (!rel) continue;
  // Debian keeps generated files (pdftex.map, language.dat) in /var/lib/texmf;
  // they all live in distinct directories, so the relative path stays unique.
  const dest = path.join(OUT, 'tree', rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(abs, dest);
  const size = fs.statSync(dest).size;
  treeBytes += size;
  const d = path.dirname(rel);
  if (!dirIdx.has(d)) {
    dirIdx.set(d, dirs.length);
    dirs.push(d);
  }
  files[name] = [dirIdx.get(d), size];
}
const manifest = { version: 1, texlive: texliveVersion, dirs, files };
fs.writeFileSync(path.join(OUT, 'tree', 'manifest.json'), JSON.stringify(manifest));

const meta = {
  texlive: texliveVersion,
  engine: 'pdfTeX 1.40.21 (SwiftLaTeX release 2022-02-20)',
  built: new Date().toISOString(),
  format: { file: fmtName, bytes: fmt.length, gzBytes: fmtGz.length },
  bundle: { file: bundleName, files: names.length, bytes: bundleRaw.length, gzBytes: bundleGz.length },
  tree: { mode: TREE_MODE, files: Object.keys(files).length, bytes: treeBytes },
};
fs.writeFileSync(path.join(OUT, 'texlive.json'), JSON.stringify(meta, null, 2));

console.log(`Bundle: ${names.length} files, ${(bundleRaw.length / 1e6).toFixed(1)} MB (${(bundleGz.length / 1e6).toFixed(1)} MB gzipped)`);
console.log(`Tree (${TREE_MODE}): ${Object.keys(files).length} files, ${(treeBytes / 1e6).toFixed(0)} MB`);
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${path.relative(ROOT, OUT)}/`);
