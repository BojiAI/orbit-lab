// Run after installing the web/m3 npm dependencies. Chrome renders the catalog from the scene models.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../web/m3/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../web/m3/', import.meta.url));
const { outputFiles: [module] } = await build({
  entryPoints: [join(root, 'body-portraits.ts')], format: 'esm', bundle: true, write: false,
});
const result = Promise.withResolvers();
const server = createServer(async (req, res) => {
  const path = req.url;
  try {
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><script type="module" src="./render.js"></script>');
    } else if (req.method === 'GET' && path === '/render.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(module.contents);
    } else if (req.method === 'GET' && /^\/textures\/[a-z-]+\.(jpg|png)$/.test(path)) {
      const bytes = await readFile(join(root, path));
      res.writeHead(200, { 'Content-Type': path.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }).end(bytes);
    } else if (req.method === 'POST' && (path === '/portrait-result' || path === '/portrait-error')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (path === '/portrait-error') result.reject(Error(bytes.toString()));
      else result.resolve(bytes);
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  } catch (error) {
    result.reject(error);
    res.writeHead(500).end();
  }
});
const profile = await mkdtemp(join(tmpdir(), 'orbit-catalog-chrome-'));
let browser, exited, timer;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const chrome = process.env.CHROME_BIN || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  browser = spawn(chrome, [
    '--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--enable-unsafe-swiftshader', `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`,
  ], { stdio: 'ignore' });
  browser.on('error', result.reject);
  exited = once(browser, 'close').then(([code, signal]) => {
    result.reject(Error(`Chrome closed before rendering the portraits (${signal || code}).`));
  }, result.reject);
  timer = setTimeout(() => result.reject(Error('Timed out rendering the catalog.')), 20000);
  const portraits = await result.promise;
  if (portraits.toString('ascii', 8, 12) !== 'WEBP') throw Error('Invalid portrait atlas.');
  await writeFile(join(root, 'body-portraits.webp'), portraits);
  console.log(`Rendered the catalog atlas (${portraits.length} bytes).`);
} finally {
  clearTimeout(timer);
  if (browser) {
    browser.kill();
    await exited;
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
