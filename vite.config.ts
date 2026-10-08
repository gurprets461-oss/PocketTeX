import { defineConfig, loadEnv, type Plugin, type ResolvedConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = __dirname;
const TEXLIVE_BUILD = path.join(ROOT, 'texlive-build');
const DEFAULT_ENDPOINT = 'texlive/tree/';

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.gz': 'application/gzip',
  '.map': 'text/plain',
};

/**
 * - Serves texlive-build/ at <base>texlive/ in dev and copies it into dist/.
 * - Generates dist/sw.js from src/sw-template.js with the precache list.
 */
function pockettex(endpoint: string): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'pockettex',
    configResolved(c) {
      config = c;
    },
    configureServer(server) {
      const prefix = server.config.base + 'texlive/';
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (!url.startsWith(prefix)) return next();
        const file = path.join(TEXLIVE_BUILD, decodeURIComponent(url.slice(prefix.length)));
        if (!file.startsWith(TEXLIVE_BUILD) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.statusCode = 404;
          return res.end('not found');
        }
        res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (config.command !== 'build') return;
      const out = path.resolve(config.root, config.build.outDir);
      if (!fs.existsSync(path.join(TEXLIVE_BUILD, 'texlive.json'))) {
        throw new Error('texlive-build/ is missing: run `npm run build:texlive` first.');
      }
      copyDir(TEXLIVE_BUILD, path.join(out, 'texlive'));
      const meta = JSON.parse(fs.readFileSync(path.join(TEXLIVE_BUILD, 'texlive.json'), 'utf8'));

      // Precache everything except the on-demand tree (only its manifest).
      const files = walk(out).filter(
        (f) =>
          f !== 'sw.js' &&
          (!f.startsWith('texlive/tree/') || f === 'texlive/tree/manifest.json') &&
          !f.endsWith('.LICENSE.txt'),
      );
      const precache = files.sort().map((f) => {
        const rev = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, f))).digest('hex').slice(0, 12);
        return [f, rev];
      });
      const version = crypto.createHash('sha256').update(JSON.stringify(precache)).digest('hex').slice(0, 12);
      const texliveId = crypto
        .createHash('sha256')
        .update(meta.texlive + meta.format.file)
        .digest('hex')
        .slice(0, 12);
      const sw = fs
        .readFileSync(path.join(ROOT, 'src', 'sw-template.js'), 'utf8')
        .replace('__PRECACHE__', JSON.stringify(precache))
        .replace('__VERSION__', JSON.stringify(version))
        .replace('__TEXLIVE_ENDPOINT__', JSON.stringify(endpoint))
        .replace('__TEXLIVE_ID__', JSON.stringify(texliveId));
      fs.writeFileSync(path.join(out, 'sw.js'), sw);
      const bytes = precache.reduce((n, [f]) => n + fs.statSync(path.join(out, f)).size, 0);
      config.logger.info(
        `\n  sw.js: ${precache.length} precached files, ${(bytes / 1e6).toFixed(1)} MB, version ${version}`,
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, ['VITE_', 'BASE_PATH']);
  // GitHub Pages serves project sites from /<repo>/; the workflow sets BASE_PATH.
  let base = env.BASE_PATH || process.env.BASE_PATH || '/';
  if (!base.endsWith('/')) base += '/';
  const endpoint = env.VITE_TEXLIVE_ENDPOINT || DEFAULT_ENDPOINT;
  return {
    base,
    define: {
      __TEXLIVE_ENDPOINT__: JSON.stringify(endpoint),
    },
    build: {
      target: ['es2020', 'safari15', 'chrome90'],
      chunkSizeWarningLimit: 2000,
      assetsInlineLimit: 0,
    },
    worker: { format: 'es' },
    plugins: [pockettex(endpoint)],
    preview: { port: 4173 },
  };
});
