// Build the M3 site before running this script. See M3_WORKER.md for the render command.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../../web/m3/node_modules/esbuild/lib/main.js';
import { PLANET_PRESETS } from '../../web/m3/planet-presets.ts';
import { trisolarisSettings } from '../../web/m3/scene-presets.js';
import { renderScore } from './score.mjs';

const stage = new URL('../../target/m3-site/', import.meta.url);
const output = fileURLToPath(new URL('../../target/orbit-lab-promo/', import.meta.url));
const title = 'orbit-lab-three-suns-continuous-daylight.mp4';
const fps = 30, duration = 37, totalFrames = fps * duration;
const assets = [
  ['textures/earth-day.jpg', 'image/jpeg'], ['textures/earth-night.jpg', 'image/jpeg'], ['textures/earth-clouds.jpg', 'image/jpeg'],
];
const [trajectory, renderer, ...textures] = await Promise.all([
  sampleTrajectory(),
  build({
    entryPoints: [fileURLToPath(new URL('./shots.js', import.meta.url))], bundle: true, format: 'esm', write: false,
    nodePaths: [fileURLToPath(new URL('../../web/m3/node_modules/', import.meta.url))],
  }),
  ...assets.map(async ([path, mime]) => [path, [mime, await readFile(new URL(path, stage))]]),
]);

const prefix = `/${randomUUID()}/`;
const files = new Map([
  ['', ['text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><title>Orbit Lab · Frame render</title>
<script type="module">import('./shots.js').catch(error => fetch('./error', { method: 'POST', body: String(error.stack ?? error) }));</script>`]],
  ['shots.js', ['text/javascript', renderer.outputFiles[0].contents]],
  ['manifest.json', ['application/json', JSON.stringify({ ...trajectory, fps, duration })]],
  ...textures,
]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(output, 'render-'));
const video = join(scratch, title);
const score = join(scratch, 'score.wav');
const completed = Promise.withResolvers();
let browser, browserClosed, encoder, encoderClosed, timer, written = 0;

const server = createServer(async (req, res) => {
  const path = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : undefined;
  try {
    if (req.method === 'GET' && files.has(path)) {
      const [mime, content] = files.get(path);
      res.writeHead(200, { 'Content-Type': mime }).end(content);
    } else if (req.method === 'POST' && (path === 'frame' || path === 'error')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (path === 'error') throw Error(bytes.toString());
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || written >= totalFrames) throw Error('Unexpected render frame');
      if (!encoder.stdin.write(bytes)) await once(encoder.stdin, 'drain');
      written++;
      res.writeHead(204).end();
      if (written % 120 === 0) console.log(`Rendered ${written}/${totalFrames} frames`);
      if (written === totalFrames) completed.resolve();
    } else res.writeHead(404).end();
  } catch (error) {
    res.writeHead(500).end();
    completed.reject(error);
  }
});

try {
  await writeFile(score, renderScore(duration));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  encoder = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-i', score, '-vf', 'scale=out_color_matrix=bt709:out_range=limited,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-metadata', 'title=Orbit Lab - Three Suns',
    '-metadata', 'comment=Orbit Lab simulation. Earth imagery: NASA Earth Observatory; clouds: Matt Eason / NASA GIBS.', video,
  ], { stdio: ['pipe', 'ignore', 'inherit'] });
  encoderClosed = new Promise(resolve => encoder.once('close', (code, signal) => {
    if (written !== totalFrames || code !== 0) completed.reject(Error(`FFmpeg exited (${signal || code})`));
    resolve(code);
  }));
  encoder.on('error', completed.reject);
  encoder.stdin.on('error', completed.reject);
  const chrome = process.env.CHROME_BIN || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  browser = spawn(chrome, [
    '--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-background-timer-throttling', '--enable-unsafe-swiftshader',
    `--user-data-dir=${join(scratch, 'chrome')}`, `http://127.0.0.1:${server.address().port}${prefix}`,
  ], { stdio: 'ignore' });
  browserClosed = new Promise(resolve => browser.once('close', (code, signal) => {
    if (written !== totalFrames) completed.reject(Error(`Frame renderer exited (${signal || code})`));
    resolve();
  }));
  browser.on('error', completed.reject);
  timer = setTimeout(() => completed.reject(Error(`Timed out after rendering ${written} frames`)), 240_000);
  await completed.promise;
  encoder.stdin.end();
  const exit = await encoderClosed;
  if (exit !== 0) throw Error(`FFmpeg exited with status ${exit}`);
  await rename(video, join(output, title));
  console.log(`Rendered ${written} frames to ${join(output, title)}`);
} finally {
  clearTimeout(timer);
  if (encoder && encoder.exitCode === null) encoder.kill();
  if (browser) {
    browser.kill();
    const kill = setTimeout(() => browser.kill('SIGKILL'), 3000);
    await browserClosed;
    clearTimeout(kill);
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
}

async function sampleTrajectory() {
  const { dt, bodies } = trisolarisSettings(PLANET_PRESETS);
  const wasm = await readFile(new URL('orbit_lab_m3.wasm', stage));
  const { instance: { exports: engine } } = await WebAssembly.instantiate(wasm);
  engine.scene_clear_draft();
  for (const { radius, density, position, velocity } of bodies) {
    if (engine.scene_add_body(radius, density, ...position, ...velocity) !== 0) throw Error('Invalid Trisolaris initial state');
  }
  if (engine.scene_start(dt, 0) !== 0) throw Error('Unable to start the Trisolaris preset');
  const samples = [];
  for (let step = 0; step <= Math.ceil(74 / dt); step++) {
    if (step > 0 && engine.scene_advance(1) !== 0) throw Error(`Integration failed at step ${step}`);
    // The scene snapshot is time followed by position and velocity for each body.
    samples.push(bodies.flatMap((_, i) => [1, 2, 3].map(axis => engine.scene_value(6 * i + axis))));
  }
  return { dt, radii: bodies.map(body => body.radius), samples };
}
