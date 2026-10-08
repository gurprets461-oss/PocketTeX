import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// public/engine/driver.js is a classic browser script; load it like the worker does.
const sandbox: { self: Record<string, any>; TextDecoder: typeof TextDecoder; Math: Math } = { self: {}, TextDecoder, Math };
vm.runInNewContext(fs.readFileSync(new URL('../../public/engine/driver.js', import.meta.url), 'utf8'), sandbox);
const driver = sandbox.self.PocketTeXDriver;

const enc = new TextEncoder();

/** Fake engine: `script` decides what each pdfLaTeX pass writes. */
function fakeEngine(files: Record<string, string>, script: (pass: number, files: Record<string, string>) => void) {
  let pass = 0;
  const calls: string[] = [];
  return {
    calls,
    files,
    latex(main: string) {
      calls.push('latex:' + main);
      script(++pass, files);
      files['main.log'] = `Output written on main.pdf (1 page).`;
      files['main.pdf'] = '%PDF';
      return { status: 0, log: files['main.log'] };
    },
    bibtex(main: string) {
      calls.push('bibtex:' + main);
      files['main.bbl'] = '\\begin{thebibliography}{1}\\end{thebibliography}';
      return { status: 0, log: '' };
    },
    readFile(p: string) {
      return p in files ? enc.encode(files[p]) : null;
    },
  };
}

test('candidates follow kpathsea suffix rules', () => {
  assert.deepEqual([...driver.candidates('cmr10', 3)], ['cmr10.tfm', 'cmr10']);
  assert.deepEqual([...driver.candidates('article.cls', 26)], ['article.cls', 'article.cls.tex']);
  assert.deepEqual([...driver.candidates('intro.tex', 26)], ['intro.tex']);
  assert.deepEqual([...driver.candidates('cmr10.pfb', 32)], ['cmr10.pfb', 'cmr10.pfb.pfa']);
});

test('reruns until the .aux is stable', () => {
  const e = fakeEngine({ 'main.tex': '' }, (pass, f) => {
    f['main.aux'] = pass === 1 ? '\\newlabel{a}{{1}{1}}' : '\\newlabel{a}{{1}{1}}\\newlabel{b}{{2}{1}}';
  });
  const r = driver.compile(e, 'main.tex', {});
  assert.equal(r.status, 0);
  assert.equal(r.passes, 3); // aux created, aux changed, stable
  assert.equal(r.bibtex, false);
});

test('a warm recompile with an unchanged .aux takes one pass', () => {
  const files = { 'main.tex': '', 'main.aux': '\\relax' };
  const e = fakeEngine(files, (_p, f) => (f['main.aux'] = '\\relax'));
  assert.equal(driver.compile(e, 'main.tex', {}).passes, 1);
});

test('BibTeX runs once when citations appear, not again when unchanged', () => {
  const aux = '\\citation{x}\n\\bibstyle{plain}\n\\bibdata{refs}\n';
  const files = { 'main.tex': '', 'refs.bib': '@book{x, title={T}}' };
  const e = fakeEngine(files, (pass, f) => (f['main.aux'] = aux + (pass > 1 ? '\\bibcite{x}{1}\n' : '')));
  const state = {};
  const r = driver.compile(e, 'main.tex', state);
  assert.equal(r.bibtex, true);
  assert.equal(e.calls.filter((c) => c.startsWith('bibtex')).length, 1);
  assert.ok(r.passes >= 2);

  const again = driver.compile(e, 'main.tex', state);
  assert.equal(again.bibtex, false);

  // Editing the .bib triggers BibTeX again.
  files['refs.bib'] += '@book{y, title={U}}';
  assert.equal(driver.compile(e, 'main.tex', state).bibtex, true);
});

test('jobname files are read from the root for a main file in a folder', () => {
  const e = fakeEngine({ 'report/main.tex': '' }, (_p, f) => (f['main.aux'] = '\\relax'));
  const r = driver.compile(e, 'report/main.tex', {});
  assert.ok(r.pdf);
  assert.match(r.log, /Output written/);
});
