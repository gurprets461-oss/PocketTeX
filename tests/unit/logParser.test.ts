import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseLog, projectPath, summarize } from '../../src/latex/logParser.ts';

const log = (name: string) => fs.readFileSync(new URL(`./logs/${name}`, import.meta.url), 'utf8');

test('clean compile has no errors or warnings', () => {
  const s = summarize(parseLog(log('orgo-lab-ok.log')));
  assert.equal(s.errors, 0);
  assert.equal(s.warnings, 0);
});

test('undefined control sequence is located in the \\input file', () => {
  const errors = parseLog(log('undefined-macro.log')).filter((e) => e.level === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'sections/results.tex');
  assert.equal(errors[0].line, 4);
  assert.match(errors[0].message, /\\badmacro/);
});

test('missing $ points at the offending line', () => {
  const errors = parseLog(log('missing-dollar.log')).filter((e) => e.level === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'sections/results.tex');
  assert.equal(errors[0].line, 31);
  assert.equal(errors[0].message, 'Missing $ inserted.');
});

test('missing package error merges with the emergency stop', () => {
  const entries = parseLog(log('missing-package.log'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file, 'main.tex');
  assert.equal(entries[0].line, 8);
  assert.match(entries[0].message, /doesnotexist\.sty' not found/);
});

test('undefined references are warnings with input lines', () => {
  const w = parseLog(log('undefined-macro.log')).filter((e) => e.level === 'warning');
  const ref = w.find((e) => e.message.includes('sec:procedure'));
  assert.ok(ref);
  assert.equal(ref.file, 'sections/introduction.tex');
  assert.equal(ref.line, 22);
});

test('package warnings join continuation lines', () => {
  const text = [
    '(./main.tex',
    'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
    '(hyperref)                removing `math shift\' on input line 12.',
    '',
    ')',
  ].join('\n');
  const [e] = parseLog(text);
  assert.equal(e.level, 'warning');
  assert.equal(e.file, 'main.tex');
  assert.equal(e.line, 12);
  assert.match(e.message, /^hyperref: Token not allowed .* removing/);
});

test('box warnings are typesetting entries with a line range start', () => {
  const text = [
    '(./chapter.tex',
    'Overfull \\hbox (15.0pt too wide) in paragraph at lines 7--9',
    '[]\\OT1/cmr/m/n/10 Some text',
    '',
    ')',
  ].join('\n');
  const [e] = parseLog(text);
  assert.equal(e.level, 'typesetting');
  assert.equal(e.file, 'chapter.tex');
  assert.equal(e.line, 7);
});

test('wrapped file names are re-joined', () => {
  const name = './' + 'a'.repeat(70) + '/x.tex';
  const first = ('(' + name).slice(0, 79);
  const rest = ('(' + name).slice(79);
  const text = [first, rest, '! Undefined control sequence.', 'l.3 \\oops', '         ', ')'].join('\n');
  const [e] = parseLog(text);
  assert.equal(e.file, name.slice(2));
  assert.equal(e.line, 3);
});

test('projectPath strips ./ and rejects system files', () => {
  assert.equal(projectPath('./sections/a.tex'), 'sections/a.tex');
  assert.equal(projectPath('/tex/article.cls'), null);
  assert.equal(projectPath('/work/main.tex'), 'main.tex');
});
