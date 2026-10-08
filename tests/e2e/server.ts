// Minimal static server for dist/ under the GitHub Pages base path. Tests stop
// it to simulate airplane mode: unlike Playwright's setOffline(), a dead server
// also fails requests made by the service worker itself.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.gz': 'application/gzip',
};

export interface StaticServer {
  url: string;
  stop(): Promise<void>;
}

export async function startServer(root: string, base = '/PocketTeX/'): Promise<StaticServer> {
  if (!fs.existsSync(path.join(root, 'sw.js'))) throw new Error(`${root} has no build; run "npm run build" first`);
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (!url.startsWith(base)) {
      res.writeHead(404).end();
      return;
    }
    let file = path.join(root, url.slice(base.length));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  let stopped = false;
  return {
    url: `http://localhost:${port}${base}`,
    stop: () =>
      new Promise<void>((resolve) => {
        if (stopped) return resolve();
        stopped = true;
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
