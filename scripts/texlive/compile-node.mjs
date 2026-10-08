#!/usr/bin/env node
// Compiles a project directory with the wasm engine in Node, resolving TeX Live
// files exactly like the browser worker does: precached bundle first, then the
// on-demand tree via its manifest. Only needs a prior `npm run build:texlive`.
//
//   node scripts/texlive/compile-node.mjs <project dir> [main.tex] [--out out.pdf] [--log out.log]
//                                         [--expect-pages N]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { loadEngine, loadDriver } = require('./engine-node.cjs');
const driver = loadDriver();

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const outPdf = flag('--out');
const outLog = flag('--log');
const expectPages = flag('--expect-pages');
const [projectDir, mainFile = 'main.tex'] = args;
if (!projectDir) {
  console.error('usage: compile-node.mjs <project dir> [main.tex] [--out file.pdf] [--log file.log]');
  process.exit(2);
}

const BUILD = path.join(ROOT, 'texlive-build');
const meta = JSON.parse(fs.readFileSync(path.join(BUILD, 'texlive.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(BUILD, 'tree', 'manifest.json'), 'utf8'));
const raw = zlib.gunzipSync(fs.readFileSync(path.join(BUILD, meta.bundle.file)));
const headerLen = raw.readUInt32LE(0);
const bundle = new Map();
const dataStart = 4 + headerLen;
for (const [name, off, len] of JSON.parse(raw.subarray(4, dataStart).toString())) {
  bundle.set(name, raw.subarray(dataStart + off, dataStart + off + len));
}

const tmp = fs.mkdtempSync(path.join(BUILD, '.node-cache-'));
const onDemand = [];
const engine = loadEngine({
  resolve(name, format) {
    for (const c of driver.candidates(name, format)) {
      if (bundle.has(c)) {
        const p = path.join(tmp, c);
        fs.writeFileSync(p, bundle.get(c));
        return p;
      }
      const entry = manifest.files[c];
      if (entry) {
        onDemand.push(c);
        return path.join(BUILD, 'tree', manifest.dirs[entry[0]], c);
      }
    }
    return null;
  },
});
await engine.ready;
engine.installFormat(zlib.gunzipSync(fs.readFileSync(path.join(BUILD, meta.format.file))));
engine.loadProject(path.resolve(projectDir));

const t = Date.now();
const r = driver.compile(
  { latex: (m) => engine.latex(m), bibtex: (m) => engine.bibtex(m), readFile: (p) => engine.readFile(p) },
  mainFile,
  {},
  (p) => process.stderr.write(`  ${p.phase} pass ${p.pass}\n`),
);
fs.rmSync(tmp, { recursive: true, force: true });

const pages = Number((r.log.match(/Output written on .*\((\d+) pages?/) || [])[1] || 0);
console.log(JSON.stringify({
  status: r.status,
  passes: r.passes,
  bibtex: r.bibtex,
  pages,
  pdfBytes: r.pdf ? r.pdf.length : 0,
  onDemand,
  ms: Date.now() - t,
}));
if (outPdf && r.pdf) fs.writeFileSync(outPdf, r.pdf);
if (outLog) fs.writeFileSync(outLog, r.log);
if (r.status !== 0 || !r.pdf) {
  console.error(r.log.slice(-3000));
  process.exit(1);
}
if (expectPages && pages !== Number(expectPages)) {
  console.error(`expected ${expectPages} pages, got ${pages}`);
  process.exit(1);
}
