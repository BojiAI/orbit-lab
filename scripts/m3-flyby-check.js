import { currentFlybySnapshot } from './flyby.js';
import { captureDownload, importFile } from './experiment-file-check.js';

const byId = id => document.getElementById(id);
const mode = byId('flyby-mode');
const play = byId('flyby-play');
const next = byId('flyby-next');
const initialForm = byId('flyby-initial');
const preset = byId('flyby-preset');

const cases = [
  { id: 'baseline', suffix: '', fixed: 2048, adaptive: 240 },
  { id: 'closer', suffix: '-closer', fixed: 4096, adaptive: 267 },
  { id: 'faster', suffix: '-faster', fixed: 1024, adaptive: 214 },
  { id: 'closer-faster', suffix: '-closer-faster', fixed: 2048, adaptive: 243 },
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function assert(ok, message) {
  if (!ok) throw Error(message);
}

async function waitFor(predicate, description) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    assert(performance.now() < deadline, `Flyby timed out: ${description}`);
    await sleep(10);
  }
}

async function select(name) {
  mode.value = name;
  mode.dispatchEvent(new Event('change'));
  await waitFor(() => currentFlybySnapshot()?.step === 0 && !next.disabled, `start ${name}`);
  const frame = currentFlybySnapshot();
  assert(frame.mode === name && frame.steps === 0, 'Changing flyby mode must restart at the initial state');
  return frame;
}

async function applyPreset(id) {
  preset.value = id;
  preset.dispatchEvent(new Event('change'));
  initialForm.requestSubmit();
  await waitFor(() => currentFlybySnapshot()?.preset === id && !next.disabled, `apply ${id}`);
  assert(currentFlybySnapshot().step === 0, 'Applying a preset must restart at checkpoint zero');
}

function checkPlot(frame) {
  const box = byId('flyby-xy').viewBox.baseVal;
  for (const i of [0, 1, 2]) {
    const trail = byId(`trail${i + 1}`), star = byId(`star${i + 1}`);
    assert(trail.points.length === frame.step + 1, `Wrong flyby trail length at checkpoint ${frame.step}`);
    const tip = trail.points.getItem(frame.step);
    const x = frame.values[1 + 6 * i], y = frame.values[2 + 6 * i];
    assert(getComputedStyle(star).visibility === 'visible' && star.getBoundingClientRect().width > 0,
      'Flyby star must be visible');
    assert(Math.hypot(tip.x - x, tip.y - y) < 3e-7 &&
      Math.hypot(star.cx.baseVal.value - x, star.cy.baseVal.value - y) < 3e-7,
      'Flyby plot disagrees with the received snapshot');
    assert(x >= box.x && x <= box.x + box.width && -y >= box.y && -y <= box.y + box.height,
      'Flyby camera bounds must include the latest position');
  }
}

function outgoing(values, masses) {
  const [primary, companion] = masses;
  return [0, 1, 2].map(i => values[16 + i] -
    (primary * values[4 + i] + companion * values[10 + i]) / (primary + companion));
}

function directionError(a, b) {
  const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = a.reduce((sum, x, i) => sum + x * b[i], 0);
  return Math.atan2(Math.hypot(...cross), dot);
}

async function verifyMode(name, expectedSteps, reference, masses) {
  let frame = await select(name);
  const initial = frame.values;
  const scene = frame.preset;
  assert(initial.every((value, i) => value === reference[0][i]), `${scene} received the wrong initial state`);
  if (name === 'fixed') {
    assert(byId('flyby-step-detail').textContent.includes(`1/${expectedSteps / 4}`),
      `${scene} must show the fixed timestep used for this preset`);
  }
  const end = reference.length - 1;
  let maxPosition = 0;
  for (const [i, expected] of reference.entries()) {
    if (i > 0) {
      const previousSteps = frame.steps;
      next.click();
      await waitFor(() => currentFlybySnapshot()?.step === i && (i === end || !next.disabled), `${name} checkpoint ${i}`);
      frame = currentFlybySnapshot();
      assert(frame.steps > previousSteps, `${name} did not advance any physical steps`);
    }
    assert(frame.values[0] === expected[0] && frame.end === end, 'Flyby snapshot time disagrees with IAS15 checkpoint');
    checkPlot(frame);
    for (const offset of [1, 7, 13]) {
      const distance = Math.hypot(...[0, 1, 2].map(axis => frame.values[offset + axis] - expected[offset + axis]));
      maxPosition = Math.max(maxPosition, distance);
    }
  }
  const direction = directionError(outgoing(frame.values, masses), outgoing(reference[end], masses));
  assert(maxPosition < 2e-3 && direction < 1e-3, `${scene} ${name} exceeds the flyby accuracy budget`);
  assert(frame.steps === expectedSteps && byId('snapshot').textContent.includes(`已计算 ${expectedSteps} 步`),
    `${name} must display its actual integrator step count`);
  assert(next.disabled && play.disabled, 'Flyby controls must stop at the final checkpoint');
  return { initial, report: `${name} ${frame.steps} steps (position ${maxPosition.toExponential(3)}, direction ${direction.toExponential(3)} rad)` };
}

async function verifyCustomInitialConditions() {
  const previous = currentFlybySnapshot();
  function edit(id, value) {
    const input = byId(id);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  edit('flyby-y', -0.18);
  edit('flyby-vx', 0);
  assert(preset.value === 'custom', 'Editing either initial field must switch the draft to Custom');
  assert(!initialForm.checkValidity(), 'Zero incoming speed must be rejected');
  initialForm.requestSubmit();
  assert(currentFlybySnapshot().preset === previous.preset && currentFlybySnapshot().step === previous.step,
    'Invalid rows and unapplied drafts must preserve the current run');

  edit('flyby-vx', 1.72);
  initialForm.requestSubmit();
  await waitFor(() => currentFlybySnapshot()?.preset === 'custom' && !next.disabled, 'apply custom flyby');
  const initial = currentFlybySnapshot();
  assert(initial.step === 0 && initial.steps === 0, 'Applying custom parameters must start a new paused run');
  assert(initial.values[14] === -0.18 && initial.values[16] === 1.72, 'Worker received the wrong custom parameters');
  assert(byId('flyby-active-initial').textContent.includes('自定义'), 'Active Initial must show the new scene');
  const fixed = await select('fixed');
  assert(fixed.preset === 'custom' && fixed.values.every((value, index) => value === initial.values[index]),
    'Both modes must start from the same custom parameters');
  next.click();
  await waitFor(() => currentFlybySnapshot()?.step === 1 && !next.disabled, 'advance custom flyby');
  assert(currentFlybySnapshot().steps === 128, 'Custom fixed mode must use 1/1024 steps');
  checkPlot(currentFlybySnapshot());
}

async function verifyReplay() {
  async function collect() {
    const frames = [currentFlybySnapshot()];
    const { end } = frames[0];
    for (let checkpoint = 1; checkpoint <= end; checkpoint++) {
      next.click();
      await waitFor(() => currentFlybySnapshot()?.step === checkpoint &&
        (checkpoint === end || !next.disabled), `replay checkpoint ${checkpoint}`);
      frames.push(currentFlybySnapshot());
    }
    return frames;
  }

  await select('fixed');
  const original = await collect();
  const saved = captureDownload(byId('flyby-export'));
  const fileContents = JSON.parse(await saved.text());
  assert(fileContents.settings.y === -0.18 && fileContents.settings.vx === 1.72 &&
    fileContents.settings.fixedDt === 1 / 1024 && fileContents.settings.endTime === 4,
    'The export must record the applied initial conditions, step and endpoint');

  await applyPreset('baseline');
  await select('adaptive');
  importFile(byId('flyby-file'), saved);
  await waitFor(() => currentFlybySnapshot()?.preset === 'custom' && !next.disabled, 'load exported flyby');
  assert(mode.value === 'fixed' && currentFlybySnapshot().step === 0, 'Import must restore the mode and initialize at zero');
  const replayed = await collect();
  assert(JSON.stringify(original) === JSON.stringify(replayed), 'Exported and reloaded flyby trajectories differ');

  fileContents.settings.fixedDt *= 2;
  importFile(byId('flyby-file'), new Blob([JSON.stringify(fileContents)]));
  await waitFor(() => byId('flyby-file-status').textContent.includes('无效'), 'reject invalid replay');
  assert(JSON.stringify(currentFlybySnapshot()) === JSON.stringify(replayed.at(-1)),
    'A rejected file must preserve the active run');
}

function pixels(canvas, context) {
  const data = new Uint8Array(canvas.width * canvas.height * 4);
  context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, data);
  return data;
}

async function verifySpatialView() {
  const frame = currentFlybySnapshot();
  const view = byId('flyby-view'), canvas = byId('flyby-3d');
  view.value = '3d';
  view.dispatchEvent(new Event('change'));
  await waitFor(() => !canvas.hidden || view.value === 'xy', 'three-dimensional flyby view');
  assert(!canvas.hidden && getComputedStyle(byId('flyby-xy')).display === 'none',
    'Flyby must show only its WebGL view');
  const context = canvas.getContext('webgl2');
  assert(context && canvas.width > 0 && canvas.height > 0, 'Missing WebGL renderer');
  byId('flyby-camera-reset').click();
  const unzoomed = pixels(canvas, context);
  assert(unzoomed.some((component, i) => i % 4 === 1 && component > 180 && component > unzoomed[i - 1] + 35),
    'The spatial view must render the visitor in green');
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true }));
  const zoomed = pixels(canvas, context);
  assert(zoomed.some((component, i) => component !== unzoomed[i]), 'Camera zoom must change the rendered view');

  const { createFlybyView } = await import('./flyby-3d.js');
  const probe = document.createElement('canvas');
  probe.style.cssText = 'display: block; width: 190px; height: 140px;';
  document.body.append(probe);
  try {
    const rendered = createFlybyView(probe);
    const probeContext = probe.getContext('webgl2');
    rendered.draw([frame]);
    const spatial = pixels(probe, probeContext);
    const flattened = frame.values.map((value, i) => [3, 9, 15].includes(i) ? 0 : value);
    rendered.draw([{ ...frame, values: flattened }]);
    const flat = pixels(probe, probeContext);
    assert(spatial.some((component, i) => component !== flat[i]), 'The spatial view must render the z coordinates');
  } finally {
    probe.remove();
  }

  view.value = 'xy';
  view.dispatchEvent(new Event('change'));
  assert(canvas.hidden && getComputedStyle(byId('flyby-xy')).display !== 'none',
    'Returning to XY projection must restore its plot');
  const after = currentFlybySnapshot();
  assert(after.steps === frame.steps && after.values.every((value, i) => value === frame.values[i]),
    'Changing views or moving the camera must leave the trajectory state intact');
  checkPlot(after);
}

try {
  const reports = [];
  for (const scene of cases) {
    const response = await fetch(`./flyby-reference${scene.suffix}.csv`);
    assert(response.ok, `Missing IAS15 reference for ${scene.id}`);
    const rows = (await response.text()).trim().split(/\r?\n/).slice(1).map(line => line.split(',').map(Number));
    assert(rows.length === 33 && rows.every(row => row.length === 22 && row.every(Number.isFinite)), 'Invalid flyby reference');
    const masses = [rows[0][1], rows[0][8]];
    const reference = rows.map(row => [row[0], ...row.slice(2, 8), ...row.slice(9, 15), ...row.slice(16, 22)]);
    await applyPreset(scene.id);
    const fixed = await verifyMode('fixed', scene.fixed, reference, masses);
    const adaptive = await verifyMode('adaptive', scene.adaptive, reference, masses);
    assert(fixed.initial.every((value, i) => value === adaptive.initial[i]), `${scene.id} modes started from different states`);
    reports.push(`${scene.id}: ${fixed.report}; ${adaptive.report}`);
  }
  await verifySpatialView();
  await verifyCustomInitialConditions();
  await verifyReplay();

  byId('flyby-controls').requestSubmit();
  await waitFor(() => currentFlybySnapshot()?.step > 0 && !play.disabled, 'flyby autoplay');
  play.click();
  await waitFor(() => !next.disabled, 'flyby pause');
  const paused = currentFlybySnapshot().step;
  await sleep(180);
  assert(currentFlybySnapshot().step === paused, 'Flyby advanced while paused');
  checkPlot(await select('fixed'));

  window.parent.postMessage({
    type: 'flyby-result',
    result: `Four flyby presets at t=4 passed IAS15 checks. ${reports.join(' | ')}. Custom inputs, exact file replay and WebGL view verified.`,
  }, location.origin);
} catch (error) {
  window.parent.postMessage({ type: 'flyby-result', error: String(error) }, location.origin);
}
