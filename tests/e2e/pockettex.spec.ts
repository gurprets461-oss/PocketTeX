// End-to-end: import an Overleaf-style .zip through the UI, compile it, then
// reload with the network disabled and compile again (service worker cache).
// Also screenshots every panel at 390x844 into tests/artifacts/screens/.
import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { fileURLToPath } from 'node:url';
import { startServer, type StaticServer } from './server.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(ROOT, 'tests', 'artifacts', 'screens');
const EXPECTED_PAGES = 3; // tests/fixtures/orgo-lab, verified against TeX Live's native pdflatex

// Each test gets its own server (and so its own origin and service worker).
const test = base.extend<{ server: StaticServer }>({
  server: async ({}, use) => {
    const server = await startServer(path.join(ROOT, 'dist'), process.env.BASE_PATH || '/PocketTeX/');
    await use(server);
    await server.stop();
  },
});

async function zipDir(dir: string): Promise<Buffer> {
  const zip = new JSZip();
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else zip.file(`orgo-lab/${r}`, fs.readFileSync(path.join(abs, e.name)));
    }
  };
  walk(dir, '');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function pdfPageCount(bytes: Buffer): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  return doc.numPages;
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function waitForOfflineReady(page: Page) {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 180_000 });
}

async function importZip(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-zip').click();
  await (await chooser).setFiles({ name, mimeType: 'application/zip', buffer });
  await expect(page.getByTestId('compile')).toBeVisible();
}

async function compileAndExpectPages(page: Page, pages: number) {
  await page.getByTestId('compile').click();
  await expect(page.getByTestId('status')).toHaveText(new RegExp(`^${pages} pages? ·`), { timeout: 180_000 });
}

async function downloadPdf(page: Page): Promise<Buffer> {
  await page.getByTestId('project-menu').click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download PDF' }).click();
  const file = await (await download).path();
  return fs.readFileSync(file!);
}

/** Airplane mode: the server is gone and the browser reports offline. */
async function goOffline(context: BrowserContext, page: Page, server: StaticServer) {
  await server.stop();
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await expect(page.evaluate(() => navigator.onLine)).resolves.toBe(false);
  // Prove the network is really gone: an uncached package file must fail.
  const reachable = await page.evaluate(() =>
    fetch('texlive/tree/tex/latex/pgfplots/pgfplots.sty', { cache: 'no-store' }).then(
      (r) => r.ok,
      () => false,
    ),
  );
  expect(reachable).toBe(false);
}

test('import Overleaf zip, compile, then compile again offline', async ({ page, context, server }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));

  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: 'PocketTeX' })).toBeVisible();
  await waitForOfflineReady(page);
  await shot(page, '01-home-empty');

  // 1. Import the fixture as an Overleaf-style zip (single top-level folder).
  await importZip(page, 'orgo-lab.zip', await zipDir(path.join(ROOT, 'tests/fixtures/orgo-lab')));
  await expect(page.locator('.title-btn')).toHaveText('orgo-lab');
  await shot(page, '02-editor');

  // 2. Compile online; check the PDF itself, not just the UI.
  await compileAndExpectPages(page, EXPECTED_PAGES);
  const pdf = await downloadPdf(page);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(50_000);
  expect(await pdfPageCount(pdf)).toBe(EXPECTED_PAGES);

  await page.getByTestId('tab-pdf').click();
  await expect(page.getByTestId('pdf-pages')).toHaveText(`${EXPECTED_PAGES} pages`);
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible();
  await shot(page, '03-pdf');

  // Scroll position survives a recompile.
  const scroller = page.getByTestId('pdf-scroller');
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
  const before = await scroller.evaluate((el) => el.scrollTop);
  await compileAndExpectPages(page, EXPECTED_PAGES);
  await page.waitForTimeout(500);
  const after = await scroller.evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before)).toBeLessThan(5);
  // ...also when compiling from the Editor tab (the usual phone workflow).
  await page.getByTestId('tab-editor').click();
  await compileAndExpectPages(page, EXPECTED_PAGES);
  await page.getByTestId('tab-pdf').click();
  await page.waitForTimeout(500);
  expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - before)).toBeLessThan(5);

  await page.getByTestId('tab-files').click();
  await expect(page.locator('.tree-row[data-path="figures/tlc-plate.png"]')).toBeVisible();
  await shot(page, '04-files');
  await page.getByTestId('tab-log').click();
  await expect(page.locator('.log-summary')).toContainText('Compiled');
  await shot(page, '05-log');

  // 3. Airplane mode: reload from the service worker cache and compile again.
  await goOffline(context, page, server);
  await expect(page.getByTestId('compile')).toBeVisible();
  await compileAndExpectPages(page, EXPECTED_PAGES);
  const offlinePdf = await downloadPdf(page);
  expect(await pdfPageCount(offlinePdf)).toBe(EXPECTED_PAGES);

  // An error in an \input file is listed and jumps to file:line (still offline).
  await page.getByTestId('tab-files').click();
  await page.locator('.tree-row[data-path="sections/results.tex"]').click();
  const editor = page.getByTestId('editor');
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('\\undefinedmacro ');
  await page.getByTestId('compile').click();
  await expect(page.getByTestId('status')).toHaveText(/1 error/, { timeout: 120_000 });
  const entry = page.locator('.log-entry.error.jump').first();
  await expect(entry).toContainText('sections/results.tex:1');
  await shot(page, '06-log-error');
  await entry.click();
  await expect(page.locator('.file-select')).toHaveValue('sections/results.tex');
  await expect(page.locator('.cm-activeLine')).toContainText('\\undefinedmacro');
  await shot(page, '07-editor-jump');

  expect(consoleErrors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e))).toEqual([]);
});

test('on-demand packages are cached by "Make available offline"', async ({ page, context, server }) => {
  await page.goto(server.url);
  await waitForOfflineReady(page);
  const zip = new JSZip();
  zip.file('main.tex', fs.readFileSync(path.join(ROOT, 'tests/fixtures/ondemand/main.tex')));
  await importZip(page, 'ondemand.zip', await zip.generateAsync({ type: 'nodebuffer' }));

  await page.getByTestId('project-menu').click();
  await page.getByRole('menuitem', { name: 'Make available offline' }).click();
  await expect(page.getByTestId('status')).toHaveText('Available offline', { timeout: 180_000 });

  await goOffline(context, page, server);
  await compileAndExpectPages(page, 1);
});

test('new project from the template compiles', async ({ page, server }) => {
  await page.goto(server.url);
  await page.getByTestId('new-project').click();
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('compile')).toBeVisible();
  await compileAndExpectPages(page, 2);
  await page.getByTestId('tab-pdf').click();
  await shot(page, '08-template-pdf');
  await page.getByTestId('tab-editor').click();
  await page.getByTestId('editor').click();
  await shot(page, '09-editor-accessory');
  await page.getByTestId('project-menu').click();
  await shot(page, '10-menu');
});

test.describe('wide screens', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('editor, files and PDF side by side', async ({ page, server }) => {
    await page.goto(server.url);
    await page.getByTestId('new-project').click();
    await page.getByRole('button', { name: 'Create' }).click();
    await compileAndExpectPages(page, 2);
    await expect(page.locator('.pane-files')).toBeVisible();
    await expect(page.locator('.pane-editor')).toBeVisible();
    await expect(page.locator('.pane-pdf')).toBeVisible();
    await expect(page.locator('.pdf-page canvas').first()).toBeVisible();
    await shot(page, '11-wide');
  });
});
