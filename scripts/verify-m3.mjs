// Usage: node scripts/verify-m3.mjs STAGE_DIR  (optional: CHROME_BIN)
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

if (process.argv.length !== 3) throw Error('Usage: node scripts/verify-m3.mjs STAGE_DIR');
const stage = resolve(process.argv[2]);
const fixtureDir = new URL('../tests/fixtures/m3-pages/', import.meta.url);
const assets = new Map();
for (const [name, mime] of Object.entries({
  'index.html': 'text/html; charset=utf-8', 'worker-client.js': 'text/javascript',
  'experiment-file.js': 'text/javascript',
  'flyby-presets.js': 'text/javascript', 'flyby-3d.js': 'text/javascript',
  'scene.html': 'text/html; charset=utf-8', 'scene.css': 'text/css; charset=utf-8',
  'scene.js': 'text/javascript', 'scene-presets.js': 'text/javascript', 'scene-worker.js': 'text/javascript',
  'body-portraits.webp': 'image/webp',
  'LICENSE.txt': 'text/plain; charset=utf-8', 'THIRD_PARTY_NOTICES.txt': 'text/plain; charset=utf-8',
  'THREE-LICENSE.txt': 'text/plain; charset=utf-8',
  'solar-system-start.csv': 'text/csv; charset=utf-8',
  'm3-reference.json': 'application/json', 'm3-unequal.json': 'application/json',
  'orbit_lab_m3.wasm': 'application/wasm',
})) {
  assets.set(name, { mime, body: await readFile(join(stage, name)) });
}
if (!assets.get('index.html').body.equals(assets.get('scene.html').body)) {
  throw Error('The space lab must be the staged home page.');
}
for (const page of ['binary.html', 'flyby.html']) {
  const redirect = await readFile(join(stage, page), 'utf8');
  if (!redirect.includes('<meta http-equiv="refresh" content="0; url=./index.html">')) {
    throw Error(`${page} must redirect to the staged space lab.`);
  }
  assets.set(page, {
    mime: 'text/html; charset=utf-8',
    body: await readFile(new URL(page, fixtureDir)),
  });
}
// The original benches and their scripts are served only by the regression server.
for (const script of ['page.js', 'worker.js', 'plot.js', 'flyby.js', 'flyby-worker.js']) {
  assets.set(script, {
    mime: 'text/javascript',
    body: await readFile(new URL(script, fixtureDir)),
  });
}
for (const file of await readdir(join(stage, 'textures'), { withFileTypes: true })) {
  if (!file.isFile() || !/\.(jpg|png)$/.test(file.name)) continue;
  const name = `textures/${file.name}`;
  const mime = file.name.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
  assets.set(name, { mime, body: await readFile(join(stage, name)) });
}
// Attach the test drivers only to the served test pages.
for (const [page, check] of [
  ['binary.html', 'm3-browser-check.js'], ['flyby.html', 'm3-flyby-check.js'], ['scene.html', 'm3-scene-check.js'],
]) {
  const asset = assets.get(page);
  asset.body = asset.body.toString().replace('</html>', `<script type="module" src="./${check}"></script></html>`);
  assets.set(check, { mime: 'text/javascript', body: await readFile(new URL(check, import.meta.url)) });
}
assets.set('experiment-file-check.js', {
  mime: 'text/javascript', body: await readFile(new URL('./experiment-file-check.js', import.meta.url)),
});
for (const suffix of ['', '-closer', '-faster', '-closer-faster']) {
  assets.set(`flyby-reference${suffix}.csv`, {
    mime: 'text/csv', body: await readFile(new URL(`../tests/fixtures/flyby-ias15${suffix}.csv`, import.meta.url)),
  });
}
const prefix = `/${randomUUID()}/`;
const done = Promise.withResolvers();
const server = createServer(async (req, res) => {
  const name = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : '';
  if (req.method === 'POST' && name === 'result') {
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) throw Error('Oversized test result');
      }
      const { result, error } = JSON.parse(body);
      if (typeof result !== 'string' || error) throw Error(error || 'Missing browser result');
      done.resolve(result);
    } catch (error) { done.reject(error); }
    res.writeHead(204).end();
  } else if (req.method === 'GET' && assets.has(name)) {
    const { mime, body } = assets.get(name);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }).end(body);
  } else { res.writeHead(404).end(); }
});

const tmp = resolve(tmpdir());
const profile = await mkdtemp(join(tmp, 'orbit-m3-chrome-'));
let browser, exited, timer;
const interrupt = () => done.reject(Error('Browser verification interrupted'));
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}${prefix}binary.html`;
  const chrome = process.env.CHROME_BIN || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  browser = spawn(chrome, ['--headless', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--enable-unsafe-swiftshader',
    `--user-data-dir=${profile}`, url], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
  browser.on('error', error => done.reject(error));
  exited = new Promise(resolve => browser.once('close', (code, signal) => {
    done.reject(Error(`Chrome closed (${signal || code}) before reporting: ${stderr}`));
    resolve();
  }));
  timer = setTimeout(() => done.reject(Error(`Browser verification timed out: ${stderr}`)), 30000);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  console.log(await done.promise);
} finally {
  clearTimeout(timer);
  if (browser) {
    browser.kill('SIGTERM');
    const kill = setTimeout(() => browser.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(kill);
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (dirname(profile) !== tmp || !profile.startsWith(join(tmp, 'orbit-m3-chrome-'))) throw Error('Unexpected profile path');
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
