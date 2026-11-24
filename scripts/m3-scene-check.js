import { currentSceneSnapshot } from './scene.js';
import { captureDownload, importFile } from './experiment-file-check.js';
import { createOrbitView, PLANET_PRESETS } from './flyby-3d.js';

const byId = id => document.getElementById(id);
const form = byId('scene-form');
const bodies = byId('scene-body-list');
const canvas = byId('scene-view');
const preset = byId('scene-library').querySelector('[data-preset="basic"]');
const play = byId('scene-play');
const playLabel = byId('scene-play-label');
const end = byId('scene-end');
const field = name => form.elements.namedItem(name);

function assert(ok, message) {
  if (!ok) throw Error(message);
}

async function waitFor(predicate, description, timeout = 2500) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    assert(performance.now() < deadline, `Scene timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function set(name, value) {
  const input = field(name);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function viewportPoint(x, y) {
  const rect = canvas.getBoundingClientRect();
  return { clientX: rect.left + x * rect.width, clientY: rect.top + y * rect.height };
}

function clickCanvas(point) {
  canvas.dispatchEvent(new MouseEvent('click', { ...point, bubbles: true }));
}

function withCanvasPointers(exercise, target = canvas) {
  const setPointerCapture = target.setPointerCapture;
  const releasePointerCapture = target.releasePointerCapture;
  // Synthetic pointers can exercise the scene and OrbitControls without native capture.
  target.setPointerCapture = target.releasePointerCapture = () => {};
  const gesture = (type, location, { pointerId = 1, pointerType = 'mouse', button = 0 } = {}) => {
    target.dispatchEvent(new PointerEvent(type, {
      ...location, pointerId, pointerType, isPrimary: pointerId === 1, button,
      buttons: type === 'pointerup' ? 0 : button === 2 ? 2 : 1, bubbles: true,
    }));
  };
  try {
    exercise(gesture);
  } finally {
    target.setPointerCapture = setPointerCapture;
    target.releasePointerCapture = releasePointerCapture;
  }
}

async function verifyLabEntrance() {
  await waitFor(() => currentSceneSnapshot()?.masses.length === 10 && !byId('scene-next').disabled, 'open the solar system');
  const panelIds = ['scenarios', 'library', 'inspector', 'view'];
  assert(panelIds.every(name => byId(`scene-${name}-panel`).hidden),
    'The full-screen scene must open with all panels collapsed');
  assert(canvas.clientWidth === innerWidth && canvas.clientHeight === innerHeight,
    'The canvas must fill the workspace');
  byId('scene-library-trigger').click();
  const asset = new URL('./body-portraits.webp', location.href).href;
  await waitFor(() => performance.getEntriesByName(asset).some(entry => entry.responseStatus === 200), 'the model portraits');
  assert(!byId('scene-library-panel').hidden &&
    byId('scene-library').querySelectorAll('.catalog-portrait').length === 11, 'The catalog must show all rendered portraits');
  byId('scene-inspector-trigger').click();
  assert(byId('scene-library-panel').hidden && !byId('scene-inspector-panel').hidden,
    'Opening parameters must dismiss the catalog');
  byId('scene-simulation-tab').click();
  assert(!byId('scene-settings').hidden && byId('scene-body-editor').hidden, 'Run settings must be available on demand');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert(byId('scene-inspector-panel').hidden, 'Escape must close an open panel');
  play.click();
  await waitFor(() => currentSceneSnapshot()?.steps > 0, 'begin solar-system playback before switching');
  byId('scene-scenarios-trigger').click();
  const scenarioPanel = byId('scene-scenarios-panel');
  const choices = [...scenarioPanel.querySelectorAll('.menu-links > button')].map(button => button.id);
  assert(!scenarioPanel.hidden && JSON.stringify(choices) ===
    JSON.stringify(['scene-system-example', 'scene-trisolaris-example', 'scene-custom-experiment']),
    'The scene selector must offer both presets and a custom experiment');
  assert(!scenarioPanel.querySelector('a[href="./binary.html"], a[href="./flyby.html"]'),
    'The space lab must not offer links to the old experiment pages');
  byId('scene-custom-experiment').click();
  assert(currentSceneSnapshot() === null && bodies.children.length === 0 && byId('scene-legend').children.length === 0 &&
    byId('scene-title').textContent === '自定义实验' && !byId('scene-axes').hidden &&
    !byId('scene-progress').textContent.includes('TDB'), 'Custom mode must replace the active simulation with an empty grid');
  assert(play.disabled && byId('scene-next').disabled && byId('scene-apply').disabled &&
    byId('scene-restart').disabled && byId('scene-export').disabled && !byId('scene-library-trigger').disabled,
    'An empty experiment must allow placement and wait for a body before applying or advancing');
  byId('scene-inspector-trigger').click();
  assert(!byId('scene-settings').hidden && byId('scene-body-editor').hidden && end.value === '',
    'The empty experiment must allow setting run conditions and default to continuous mode');
  set('dt', 1 / 256);
  byId('scene-inspector-panel').querySelector('.close-panel').click();
}

function tapToPlace(x, y) {
  byId('scene-library-trigger').click();
  preset.click();
  assert(byId('scene-library-panel').hidden && !byId('scene-cancel-placement').hidden,
    'Tap placement must clear the scene and offer a cancel action');
  clickCanvas(viewportPoint(x, y));
}

function verifyPlacement() {
  byId('scene-library-trigger').click();
  const point = viewportPoint(0.69, 0.57);
  const dataTransfer = new DataTransfer();
  preset.dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true }));
  canvas.dispatchEvent(new DragEvent('dragover', { ...point, dataTransfer, bubbles: true, cancelable: true }));
  assert(bodies.children.length === 0 && byId('scene-placement').textContent.includes('z 0'),
    'Dragging over the plane must preview the coordinates before adding a body');
  canvas.dispatchEvent(new DragEvent('drop', { ...point, dataTransfer, bubbles: true, cancelable: true }));
  preset.dispatchEvent(new DragEvent('dragend', { dataTransfer, bubbles: true }));
  assert(bodies.children.length === 1 && bodies.firstElementChild.getAttribute('aria-pressed') === 'true',
    'A dropped body must be added to the draft and selected');
  assert(byId('scene-library-panel').hidden && !byId('scene-inspector-panel').hidden &&
    !byId('scene-body-editor').hidden && !byId('scene-apply').disabled,
    'Placing the first body must reveal its parameters and enable applying the draft');
  const landed = ['x', 'y', 'z'].map(name => field(name).valueAsNumber);
  assert(landed.every(Number.isFinite) && landed[2] === 0 && (landed[0] !== 0 || landed[1] !== 0),
    'Placement must fill the intersection with the plane');
  assert(field('radius').valueAsNumber === 0.1 && Number(byId('scene-mass').textContent) === 0.06,
    'The placed body must use the catalog radius and mass');
  tapToPlace(0.35, 0.67);
  assert(bodies.children.length === 2 && field('z').valueAsNumber === 0,
    'Choosing the catalog entry and tapping the plane must also place a body');
  clickCanvas(point);
  assert(bodies.firstElementChild.getAttribute('aria-pressed') === 'true' &&
    ['x', 'y', 'z'].every((name, axis) => field(name).valueAsNumber === landed[axis]),
  'Clicking the dropped sphere must reopen its fields at the same coordinates');

  byId('scene-library-trigger').click();
  preset.click();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert(preset.getAttribute('aria-pressed') === 'false' && bodies.children.length === 2,
    'Canceling placement must leave the draft intact');
  assert(currentSceneSnapshot() === null && play.disabled && field('dt').valueAsNumber === 1 / 256,
    'Bodies and conditions must remain editable before creating a simulation');
}

function verifyBodyDrag(applied) {
  const readFields = names => names.map(name => field(name).valueAsNumber);
  const original = readFields(['x', 'y', 'z']);
  const velocity = readFields(['vx', 'vy', 'vz']);
  const initial = JSON.stringify(applied);

  withCanvasPointers(gesture => {
    byId('scene-focus').click();
    const center = viewportPoint(0.5, 0.5);
    const destination = viewportPoint(0.58, 0.55);
    gesture('pointerdown', center);
    gesture('pointermove', destination);
    gesture('pointerup', destination);
    const moved = readFields(['x', 'y', 'z']);
    assert(byId('scene-draft-view').getAttribute('aria-pressed') === 'true' &&
      !byId('scene-inspector-panel').hidden, 'Dragging must open the body in the draft editor');
    assert(moved[0] !== original[0] && moved[1] !== original[1] && moved[2] === original[2] &&
      JSON.stringify(readFields(['vx', 'vy', 'vz'])) === JSON.stringify(velocity),
      'Moving a body must edit its horizontal position and preserve its height and velocity');
    assert(JSON.stringify(currentSceneSnapshot()) === initial, 'Dragging must preserve the applied simulation until submission');

    byId('scene-focus').click();
    const touch = { pointerType: 'touch' };
    gesture('pointerdown', center, touch);
    gesture('pointermove', destination, touch);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    gesture('pointerup', destination, touch);
    clickCanvas(destination);
    assert(JSON.stringify(readFields(['x', 'y', 'z'])) === JSON.stringify(moved) && !canvas.hasAttribute('data-moving-body'),
      'Escape must cancel a touch drag and restore normal pointer controls');
  });
}

async function simulate() {
  byId('scene-next').click();
  await waitFor(() => currentSceneSnapshot()?.steps === 1 && !byId('scene-next').disabled, 'one scene step');
  const first = currentSceneSnapshot();
  play.click();
  await waitFor(() => currentSceneSnapshot()?.steps === 24 && playLabel.textContent === '继续推演' && !play.disabled, 'scene endpoint');
  return [first, currentSceneSnapshot()];
}

async function verifyContinuation(initial) {
  const rate = byId('scene-speed');
  rate.value = '0.01';
  play.click();
  rate.value = '1';
  rate.dispatchEvent(new Event('change'));
  await waitFor(() => currentSceneSnapshot()?.steps > 24 && playLabel.textContent === '暂停', 'continue past the endpoint');
  play.click();
  await waitFor(() => !byId('scene-next').disabled, 'pause the continuous run');
  const paused = currentSceneSnapshot();
  assert(paused.values[0] === paused.steps / 256 && end.value === '', 'Continuing must lift the limit without restarting the clock');
  await new Promise(resolve => setTimeout(resolve, 140));
  assert(currentSceneSnapshot().steps === paused.steps, 'The continuous run must still pause');

  const saved = captureDownload(byId('scene-export'));
  assert(JSON.parse(await saved.text()).settings.end === null, 'Export must retain continuous mode');
  importFile(byId('scene-file'), saved);
  await waitFor(() => currentSceneSnapshot()?.steps === 0 && !byId('scene-next').disabled, 'restore a continuous run');
  assert(end.value === '' && JSON.stringify(currentSceneSnapshot()) === JSON.stringify(initial),
    'Continuous mode must restore the original initial state');
  play.click();
  await waitFor(() => currentSceneSnapshot()?.steps > 24, 'play the restored scene past the previous end');
  play.click();
  await waitFor(() => !byId('scene-next').disabled, 'pause after import');
}

async function verifySunEarthFile() {
  const earthMass = 5.9722 / 1_988_400;
  const auKm = 149_597_870.7;
  const draftTab = byId('scene-draft-view');
  const runTab = byId('scene-run-view');
  const guides = byId('scene-guides');
  // Exports of the former two-body example use appearance IDs and have no calendar epoch.
  const pair = [
    ['太阳', 'sun', 695_700, 1, -earthMass / (1 + earthMass)],
    ['地球', 'earth', 6371, earthMass, 1 / (1 + earthMass)],
  ].map(([name, appearance, radiusKm, mass, x]) => {
    const radius = radiusKm / auKm;
    return {
      name, appearance, radius, density: mass / (radius * radius * radius * (4 * Math.PI / 3)),
      position: [x, 0, 0], velocity: [0, x * Math.sqrt(1 + earthMass), 0],
    };
  });
  importFile(byId('scene-file'), new Blob([JSON.stringify({
    version: 1, kind: 'scene', settings: { dt: 1 / 128, end: null, bodies: pair },
  })]));
  await waitFor(() => currentSceneSnapshot()?.masses.length === 2 &&
    Math.abs(currentSceneSnapshot().masses[0] - 1) < 2e-15 && !byId('scene-next').disabled, 'import the Sun–Earth scene');
  const initial = currentSceneSnapshot();
  runTab.click();
  bodies.lastElementChild.click();
  assert(runTab.getAttribute('aria-pressed') === 'true' && guides.getAttribute('aria-pressed') === 'false' &&
    bodies.lastElementChild.getAttribute('aria-pressed') === 'true', 'The imported Earth must be selectable in the run view');
  assert(byId('scene-moon-orbit').hidden, 'The Earth–Moon orbit view requires both bodies');
  assert(Math.abs(initial.masses[1] - earthMass) < 2e-20 && Math.abs(initial.values[7] - initial.values[1] - 1) < 2e-15,
    'The Sun–Earth scene must use the published Earth mass and 1 AU separation');
  assert(Math.abs((initial.values[11] - initial.values[5]) ** 2 - (1 + earthMass)) < 5e-15,
    'The relative speed must balance gravity in the 1 AU circular orbit');
  const saved = captureDownload(byId('scene-export'));
  const { settings } = JSON.parse(await saved.text());
  assert(settings.bodies[0].appearance === 'sun' && settings.bodies[0].radius === 695_700 / auKm &&
    settings.bodies[1].appearance === 'earth' && settings.bodies[1].radius === 6371 / auKm,
    'The saved scene must retain the models and the physical radii');

  for (const file of ['earth-day.jpg', 'earth-night.jpg', 'earth-clouds.jpg']) {
    const asset = new URL(`./textures/${file}`, location.href).href;
    await waitFor(() => performance.getEntriesByName(asset).some(entry => entry.responseStatus === 200), file);
  }
  byId('scene-fit').click();
  byId('scene-focus').click();
  const gl = canvas.getContext('webgl2');
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let blue = 0;
  let bright = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 2] > 80 && pixels[i + 2] > pixels[i] + 16) blue++;
    if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 400) bright++;
  }
  assert(blue > pixels.length / 400 && bright > pixels.length / 1000,
    'The focused Earth must contain a visible illuminated surface and blue atmosphere');
  guides.click();
  assert(!byId('scene-axes').hidden, 'Space view must be able to show the axes');
  draftTab.click();
  assert(!byId('scene-axes').hidden && guides.hidden, 'The placement grid must stay available in the draft');
  assert(JSON.stringify(currentSceneSnapshot()) === JSON.stringify(initial), 'Camera and guide changes must leave the snapshot intact');

  runTab.click();
  guides.click();
  byId('scene-focus').click();
  function brightSurfaceX() {
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let sum = 0, count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] <= 400) continue;
      sum += (i / 4) % canvas.width;
      count++;
    }
    assert(count > 0, 'The focused surface must remain visible');
    return sum / count;
  }
  const centered = brightSurfaceX();
  withCanvasPointers(gesture => {
    const from = viewportPoint(0.5, 0.5);
    const to = viewportPoint(0.68, 0.5);
    const right = { button: 2 };
    gesture('pointerdown', from, right);
    gesture('pointermove', to, right);
    gesture('pointerup', to, right);
  });
  await new Promise(resolve => requestAnimationFrame(resolve));
  const panned = brightSurfaceX();
  assert(panned - centered > 0.1 * canvas.width,
    'A right drag must pan the camera even when following Earth');
  assert(JSON.stringify(currentSceneSnapshot()) === JSON.stringify(initial), 'Panning must preserve the snapshot');

  byId('scene-next').click();
  await waitFor(() => currentSceneSnapshot()?.steps === 1, 'advance the Sun–Earth orbit');
  assert(currentSceneSnapshot().values[8] > initial.values[8], 'The Earth must move along the orbit');
  runTab.click();
  assert(Math.abs(brightSurfaceX() - panned) < 0.025 * canvas.width,
    'Following a moving body must retain the camera pan');
  const advanced = JSON.stringify(currentSceneSnapshot());
  withCanvasPointers(gesture => {
    const first = { pointerType: 'touch' };
    const second = { pointerType: 'touch', pointerId: 2 };
    gesture('pointerdown', viewportPoint(0.64, 0.48), first);
    gesture('pointerdown', viewportPoint(0.75, 0.54), second);
    gesture('pointermove', viewportPoint(0.49, 0.48), first);
    gesture('pointermove', viewportPoint(0.60, 0.54), second);
    gesture('pointerup', viewportPoint(0.60, 0.54), second);
    gesture('pointerup', viewportPoint(0.49, 0.48), first);
  });
  clickCanvas(viewportPoint(0.49, 0.48));
  await new Promise(resolve => requestAnimationFrame(resolve));
  const touchPanned = brightSurfaceX();
  assert(panned - touchPanned > 0.08 * canvas.width &&
    runTab.getAttribute('aria-pressed') === 'true' && byId('scene-inspector-panel').hidden &&
    JSON.stringify(currentSceneSnapshot()) === advanced,
    'A two-finger pan over Earth must move the camera without editing the scene');

  importFile(byId('scene-file'), saved);
  await waitFor(() => currentSceneSnapshot()?.steps === 0 && !byId('scene-next').disabled, 'restore Sun–Earth models');
  assert(JSON.stringify(currentSceneSnapshot()) === JSON.stringify(initial), 'Model metadata must preserve exact file replay');
  const restored = JSON.parse(await captureDownload(byId('scene-export')).text());
  assert(restored.settings.bodies[1].appearance === 'earth', 'Imported model IDs must survive another export');

  byId('scene-library').querySelector('[data-preset="earth"]').click();
  clickCanvas(viewportPoint(0.66, 0.68));
  assert(bodies.children.length === 3 && field('radius').valueAsNumber === 6371 / auKm,
    'The Earth catalog entry must also place a body with the preset radius');
  form.requestSubmit();
  await waitFor(() => currentSceneSnapshot()?.masses.length === 3 && !byId('scene-next').disabled, 'apply another Earth');
  assert(currentSceneSnapshot().masses[2] === initial.masses[1], 'Placing Earth must use the preset mass');
  const added = JSON.parse(await captureDownload(byId('scene-export')).text());
  assert(added.settings.bodies[2].appearance === 'earth', 'Placed Earth must carry its appearance');
}

async function verifySolarSystem() {
  const expected = [
    ['sun', 695_700], ['mercury', 2439.4], ['venus', 6051.8], ['earth', 6371],
    ['mars', 3389.5], ['jupiter', 69_911], ['saturn', 58_232],
    ['uranus', 25_362], ['neptune', 24_622], ['moon', 1737.4],
  ];
  const auKm = 149_597_870.7;
  const entries = [...byId('scene-library').children].map(entry => entry.dataset.preset);
  assert(JSON.stringify(entries) === JSON.stringify(['basic', ...expected.map(([id]) => id)]),
    'The catalog must provide eight planets, the Sun and the Moon');
  byId('scene-system-example').click();
  await waitFor(() => currentSceneSnapshot()?.masses.length === 10 && !byId('scene-next').disabled, 'full solar system');
  const initial = currentSceneSnapshot();
  const saved = captureDownload(byId('scene-export'));
  const { settings } = JSON.parse(await saved.text());
  const response = await fetch('./solar-system-start.csv');
  assert(response.ok, 'The staged site must provide the solar-system initial states');
  const rows = (await response.text()).trim().split(/\r?\n/).slice(1).map(row => row.split(','));
  const solarGm = Number(rows[0][2]);
  const daysPerUnit = Math.sqrt(auKm ** 3 / solarGm) / 86_400;
  assert(settings.epochJdTdb === 2461041.5 && byId('scene-progress').textContent.includes('2026-01-01 00:00:00 TDB'),
    'The solar-system example must start at the published DE440 epoch');
  assert(Math.abs(settings.dt * daysPerUnit - 1 / 64) < 1e-15, 'Each system step must cover 22.5 simulated minutes');
  expected.forEach(([id, radiusKm], index) => {
    assert(settings.bodies[index].appearance === id && Math.abs(settings.bodies[index].radius * auKm - radiusKm) < 1e-8,
      `The solar system must contain the published radius and model for ${id}`);
    const gm = Number(rows[index][2]);
    assert(rows[index][1] === id && Math.abs(initial.masses[index] * solarGm / gm - 1) < 3e-15,
      `The worker must receive the DE440 gravitational parameter for ${id}`);
    const offset = 1 + 6 * index;
    for (let component = 0; component < 6; component++) {
      const delta = initial.values[offset + component] - initial.values[1 + component];
      const expectedDelta = Number(rows[index][3 + component]) - Number(rows[0][3 + component]);
      const scale = component < 3 ? 1 : daysPerUnit;
      assert(Math.abs(delta - expectedDelta * scale) < 4e-14, `Incorrect DE440 state for ${id}, component ${component}`);
    }
  });
  for (const field of ['position', 'velocity']) {
    for (const axis of [0, 1, 2]) {
      const weightedSum = settings.bodies.reduce((sum, body, i) => sum + body[field][axis] * initial.masses[i], 0);
      assert(Math.abs(weightedSum) < 1e-14, 'The solar system must start in its barycentric frame');
    }
  }

  for (const [index, [id]] of expected.entries()) {
    if (id === 'sun' || id === 'earth') continue;
    bodies.children[index].click();
    byId('scene-focus').click();
    const asset = new URL(`./textures/${id}.jpg`, location.href).href;
    await waitFor(() => performance.getEntriesByName(asset).some(entry => entry.responseStatus === 200), `${id} texture`);
  }
  const rings = new URL('./textures/saturn-rings.png', location.href).href;
  assert(performance.getEntriesByName(rings).some(entry => entry.responseStatus === 200), 'Saturn must load its ring map');
  assert(JSON.stringify(initial) === JSON.stringify(currentSceneSnapshot()), 'Planet close-ups must preserve the system snapshot');
  byId('scene-next').click();
  await waitFor(() => currentSceneSnapshot()?.steps === 1 && !byId('scene-next').disabled, 'advance ten bodies together');
  assert(currentSceneSnapshot().values[0] === settings.dt && byId('scene-progress').textContent.includes('2026-01-01 00:22:30 TDB'),
    'One physics step must advance the date and simulation clock by the configured timestep');
  play.click();
  await waitFor(() => currentSceneSnapshot()?.steps >= 65 && playLabel.textContent === '暂停', 'play a full calendar-day batch');
  play.click();
  await waitFor(() => !byId('scene-next').disabled, 'pause after a calendar-day batch');
  assert((currentSceneSnapshot().steps - 1) % 64 === 0, 'Playback must batch 64 steps without changing the physical timestep');
  importFile(byId('scene-file'), saved);
  await waitFor(() => currentSceneSnapshot()?.steps === 0 && !byId('scene-next').disabled, 'replay the solar system');
  assert(JSON.stringify(currentSceneSnapshot()) === JSON.stringify(initial), 'All ten bodies must survive file replay');
  assert(byId('scene-progress').textContent.includes('2026-01-01 00:00:00 TDB'), 'File replay must restore the date');
  await verifyPlaybackControls(initial, settings.dt);
  await verifyMoonTrail();
}

async function verifyPlaybackControls(initial, dt) {
  const rate = byId('scene-speed');
  const restart = byId('scene-restart');
  assert(rate.getClientRects().length && restart.getClientRects().length && !restart.disabled,
    'Playback speed and reset must be visible next to the play controls');

  const timeout = window.setTimeout;
  let delay;
  window.setTimeout = (callback, milliseconds, ...args) => {
    delay = milliseconds;
    return timeout(callback, milliseconds, ...args);
  };
  try {
    rate.value = '0.01';
    play.click();
    const slowDelay = delay;
    await waitFor(() => currentSceneSnapshot()?.steps > 0, 'take the first frame at the lowest speed');
    const slowFrame = currentSceneSnapshot();
    assert(slowFrame.steps === 1 && slowFrame.values[0] === dt,
      'The lowest speed must update after one full physics step');
    rate.value = '4';
    rate.dispatchEvent(new Event('change'));
    // One step at 0.01× takes 6.25 times the wait of 64 steps at 4×.
    assert(slowDelay > 0 && delay * 6.25 === slowDelay, 'Changing speed during playback must reschedule at the new pace');
  } finally {
    window.setTimeout = timeout;
  }
  await waitFor(() => currentSceneSnapshot()?.steps >= 65 && playLabel.textContent === '暂停', 'play at the faster speed');
  assert((currentSceneSnapshot().steps - 1) % 64 === 0, 'Fast playback must resume full solar-system batches');

  restart.click();
  await waitFor(() => currentSceneSnapshot()?.steps === 0 && !byId('scene-next').disabled, 'reset while playing');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert(playLabel.textContent === '播放' && JSON.stringify(currentSceneSnapshot()) === JSON.stringify(initial) &&
    byId('scene-clock').textContent === '2026-01-01 00:00:00 TDB' && rate.value === '4',
    'Reset must restore the initial snapshot and date, pause playback, and retain the chosen speed');
  rate.value = '1';
}

async function verifyMoonTrail() {
  byId('scene-run-view').click();
  const orbit = byId('scene-moon-orbit');
  assert(!orbit.hidden, 'The solar system must offer an Earth-centered orbit view');
  orbit.click();
  play.click();
  await waitFor(() => currentSceneSnapshot()?.steps >= 30 * 64, 'sample one lunar orbit', 4500);
  play.click();
  await waitFor(() => !byId('scene-next').disabled, 'pause after the lunar orbit');

  const paused = currentSceneSnapshot();
  orbit.click();
  const { width, height } = canvas;
  const gl = canvas.getContext('webgl2');
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const quadrants = [0, 0, 0, 0];
  const centerRadiusSquared = (0.08 * Math.min(width, height)) ** 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 4 * (width * y + x);
      if (Math.abs(pixels[i] - 185) > 12 || Math.abs(pixels[i + 1] - 198) > 12 ||
          Math.abs(pixels[i + 2] - 216) > 12) continue;
      const dx = x - width / 2, dy = y - height / 2;
      if (dx * dx + dy * dy > centerRadiusSquared) quadrants[Number(dx >= 0) + 2 * Number(dy >= 0)]++;
    }
  }
  // Earth's solar motion would carry absolute trail samples out of this view in a day.
  assert(quadrants.every(count => count >= 4), 'The lunar trail must extend around Earth after both have traveled');
  assert(JSON.stringify(currentSceneSnapshot()) === JSON.stringify(paused), 'Viewing the lunar orbit must preserve the snapshot');
}

async function verifyTrisolaris() {
  byId('scene-scenarios-trigger').click();
  byId('scene-trisolaris-example').click();
  await waitFor(() => currentSceneSnapshot()?.masses.length === 4 && !byId('scene-next').disabled, 'open Trisolaris');
  const initial = currentSceneSnapshot();
  const { settings } = JSON.parse(await captureDownload(byId('scene-export')).text());
  assert(byId('scene-title').textContent === '三体星系' && byId('scene-scenarios-panel').hidden &&
    playLabel.textContent === '播放' && bodies.lastElementChild.getAttribute('aria-pressed') === 'true',
    'Trisolaris must open paused with the planet selected');
  assert(settings.dt === 0.004 && settings.end === null && settings.epochJdTdb === undefined &&
    settings.bodies.map(body => body.appearance).join() === 'sun,sun,sun,earth',
    'Trisolaris must export three luminous suns and a planet with continuous playback');
  assert(end.value === '' && byId('scene-steps').textContent === '0 步 · 持续推演',
    'Trisolaris must start with a blank step limit and display continuous playback');
  const masses = [1.1154074, 1.1206382, 0.7639544];
  const radii = [1.10, 1.12, 0.80];
  assert(masses.every((mass, index) => Math.abs(initial.masses[index] - mass) < 2e-15 &&
    settings.bodies[index].radius === radii[index] * PLANET_PRESETS.sun.radius) && initial.masses[3] < 0.000004,
    'Trisolaris must use the configured stellar masses and radii and an Earth-mass planet');
  const coordinates = settings.bodies.flatMap(({ position, velocity }) => [...position, ...velocity]);
  assert(JSON.stringify(initial.values) === JSON.stringify([0, ...coordinates]),
    'The Worker must receive the same Trisolaris initial state that is exported');
  byId('scene-next').click();
  await waitFor(() => currentSceneSnapshot()?.steps === 1 && !byId('scene-next').disabled, 'advance Trisolaris');
  assert(currentSceneSnapshot().values[0] === settings.dt, 'The Trisolaris clock must advance by its fixed step');
  byId('scene-restart').click();
  await waitFor(() => currentSceneSnapshot()?.steps === 0 && !byId('scene-next').disabled, 'reset Trisolaris');
  assert(JSON.stringify(initial) === JSON.stringify(currentSceneSnapshot()), 'Trisolaris reset must restore all four bodies');
  await verifyBoundTrisolaris(settings);
}

async function verifyBoundTrisolaris(settings) {
  const response = await fetch('./orbit_lab_m3.wasm');
  const { instance: { exports: engine } } = await WebAssembly.instantiate(await response.arrayBuffer());
  const delta = (a, b) => a.map((value, axis) => value - b[axis]);
  const sampleInterval = 0.1;
  for (const dt of [settings.dt, settings.dt / 2]) {
    engine.scene_clear_draft();
    for (const { radius, density, position, velocity } of settings.bodies) {
      assert(engine.scene_add_body(radius, density, ...position, ...velocity) === 0, 'The exported body must initialize in WASM');
    }
    assert(engine.scene_start(dt, 0) === 0, 'Trisolaris must support long continuous integration');
    const masses = settings.bodies.map((_, i) => engine.scene_mass(i));
    const closestPairs = new Set();
    const episodes = [
      { star: 1, from: 0, to: 16, angle: 0 },
      { star: 0, from: 40, to: 62, angle: 0 },
      { star: 1, from: 84, to: 118, angle: 0 },
    ];
    let faintest = Infinity, brightest = 0;
    const stride = Math.round(sampleInterval / dt);
    const total = Math.round(2048 / dt);
    for (let step = 0; step <= total; step += stride) {
      if (step) assert(engine.scene_advance(stride) === 0, `Trisolaris must advance through step ${step}`);
      const positions = settings.bodies.map((_, id) => [0, 1, 2].map(axis => engine.scene_value(1 + 6 * id + axis)));
      const [a, b, c, planet] = positions;
      const separations = [Math.hypot(...delta(a, b)), Math.hypot(...delta(b, c)), Math.hypot(...delta(c, a))];
      assert(Math.min(...separations) > 2.5 && Math.max(...separations) < 14,
        `The three suns must remain within their measured orbital range at t=${step * dt}, dt=${dt}`);
      closestPairs.add(separations.indexOf(Math.min(...separations)));
      const time = step * dt;
      if (time > 118) continue;
      const relativePositions = positions.slice(0, 3).map(star => delta(planet, star));
      const distances = relativePositions.map(offset => Math.hypot(...offset));
      const irradiance = distances.reduce((sum, distance) => sum + 1 / distance ** 2, 0);
      faintest = Math.min(faintest, irradiance);
      brightest = Math.max(brightest, irradiance);
      const episode = episodes.find(({ from, to }) => from <= time && time <= to);
      if (!episode) continue;
      const { star } = episode;
      const velocity = id => [0, 1, 2].map(axis => engine.scene_value(4 + 6 * id + axis));
      const [vx, vy, vz] = delta(velocity(3), velocity(star));
      const [x, y, z] = relativePositions[star];
      const distance = distances[star];
      const acceleration = masses[star] / distance ** 2;
      const totalAcceleration = distances.reduce((sum, value, index) => sum + masses[index] / value ** 2, 0);
      assert(acceleration >= 0.72 * totalAcceleration && 0.5 * (vx ** 2 + vy ** 2 + vz ** 2) < (masses[star] + masses[3]) / distance,
        `Sun ${star} must temporarily bind the planet at t=${time}, dt=${dt}`);
      episode.angle += sampleInterval * Math.hypot(y * vz - z * vy, z * vx - x * vz, x * vy - y * vx) / distance ** 2;
    }
    assert(engine.scene_steps() === total && closestPairs.size === 3 && brightest / faintest > 3,
      `Trisolaris must keep exchanging closest pairs and change illumination at dt=${dt}`);
    assert(episodes.every(({ angle }) => angle > 2 * Math.PI), `Each of the three captures must cover a full orbit at dt=${dt}`);
  }
}

function verifyThreeSunLighting() {
  const planetCanvas = document.createElement('canvas');
  planetCanvas.style.cssText = 'position: fixed; width: 256px; height: 256px';
  document.body.append(planetCanvas);
  const view = createOrbitView(planetCanvas, { editable: true });
  view.setDisplay(false, false);
  const origins = [[0, 0, 0], [1, 0, 0], [0, -1.1, 0], [0, 0, 1.2]];
  const appearances = ['earth', 'sun', 'sun', 'sun'];
  function draw(distantSun) {
    const values = origins.flatMap((origin, index) => origin.map(axis => index === distantSun ? 8 * axis : axis));
    const frames = [{ values }];
    view.draw(appearances.map((appearance, index) => ({
      ...PLANET_PRESETS[appearance], frames, offset: index * 3,
    })));
  }
  draw();
  view.focusBody(0);
  const gl = planetCanvas.getContext('webgl2');
  const { width, height } = planetCanvas;
  const all = new Uint8Array(width * height * 4);
  const dim = new Uint8Array(all.length);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, all);
  const regions = [1, 2, 3].map(index => {
    draw(index);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, dim);
    let x = 0, y = 0, count = 0;
    for (let i = 0; i < all.length; i += 4) {
      const change = all[i] + all[i + 1] + all[i + 2] - dim[i] - dim[i + 1] - dim[i + 2];
      if (change <= 24) continue;
      x += (i / 4) % width;
      y += Math.floor(i / (4 * width));
      count++;
    }
    assert(count > width * height * 0.035, `Moving sun ${index} farther away must dim its side of the planet`);
    return [x / count, y / count];
  });
  for (let i = 0; i < regions.length; i++) {
    for (const [x, y] of regions.slice(i + 1)) {
      assert(Math.hypot(regions[i][0] - x, regions[i][1] - y) > width * 0.055,
        'Three separate light directions must illuminate different regions of the same frame');
    }
  }
  planetCanvas.remove();
}

function verifyOverview() {
  const overview = document.createElement('canvas');
  overview.style.cssText = 'position: fixed; width: 384px; height: 192px';
  document.body.append(overview);
  const view = createOrbitView(overview, { editable: true });
  view.setDisplay(false, false);
  const { moon, earth, jupiter } = PLANET_PRESETS;
  const frames = [{ values: [-10, 0, 0, 0, 0, 0, 10, 0, 0] }];
  // Keep the same model and color to isolate the effect of the physical radius.
  const trails = [moon, earth, jupiter].map(({ radius }, index) => ({
    frames, offset: index * 3, appearance: 'earth', color: earth.color, radius,
  }));
  view.draw(trails);
  const gl = overview.getContext('webgl2');
  const rect = overview.getBoundingClientRect();
  const halfSize = Math.ceil(10 * overview.width / rect.width);
  const size = 2 * halfSize;
  const pixels = new Uint8Array(size * size * 4);
  function litPixels(index) {
    const [x, y] = view.bodyScreenPosition(index);
    const left = Math.round((x - rect.left) * overview.width / rect.width) - halfSize;
    const bottom = Math.round((rect.bottom - y) * overview.height / rect.height) - halfSize;
    gl.readPixels(left, bottom, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 350) count++;
    }
    return count;
  }
  const [small, medium, large] = trails.map((_, index) => litPixels(index));
  assert(small > 0 && medium > 1.25 * small && large > 1.5 * medium,
    `Overview markers must distinguish physical radii (${small}, ${medium}, ${large})`);
  trails[0].radius = jupiter.radius;
  view.draw(trails);
  assert(litPixels(0) > 1.5 * medium, 'An edited radius must resize the marker in place');

  trails[0].radius = moon.radius;
  view.draw(trails);
  view.reset();
  function assertGlobeVisible(gesture) {
    const [centerX, centerY] = view.bodyScreenPosition(0);
    const surfaceX = centerX + 24;
    // Beyond the locator hit area we must hit the magnified physical sphere.
    assert(view.bodyAt(surfaceX, centerY) === 0, `${gesture} must reach the off-center body's surface from the overview`);
    const x = Math.floor((surfaceX - rect.left) * overview.width / rect.width);
    const y = Math.floor((rect.bottom - centerY) * overview.height / rect.height);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    assert(Math.abs(pixels[0] - 16) + Math.abs(pixels[1] - 30) + Math.abs(pixels[2] - 48) > 20,
      `${gesture} must keep the nearby surface visible beyond the former clipping plane`);
  }

  const [targetX, targetY] = view.bodyScreenPosition(0);
  const clientX = Math.round(targetX + 5), clientY = Math.round(targetY);
  for (let i = 0; i < 15; i++) {
    overview.dispatchEvent(new WheelEvent('wheel', { clientX, clientY, deltaY: -2000, cancelable: true }));
  }
  assertGlobeVisible('Wheel zoom');
  const [zoomX, zoomY] = view.bodyScreenPosition(0);
  assert(Math.hypot(zoomX - clientX, zoomY - clientY) < 2, 'The zoomed body must stay under the pointer');

  view.reset();
  withCanvasPointers(gesture => {
    const first = { pointerType: 'touch' };
    const second = { pointerType: 'touch', pointerId: 2 };
    for (let i = 0; i < 9; i++) {
      const [clientX, clientY] = view.bodyScreenPosition(0);
      const position = shift => ({ clientX: Math.round(clientX + shift), clientY: Math.round(clientY) });
      gesture('pointerdown', position(-12), first);
      gesture('pointerdown', position(12), second);
      gesture('pointermove', position(-72), first);
      gesture('pointermove', position(72), second);
      gesture('pointerup', position(72), second);
      gesture('pointerup', position(-72), first);
    }
  }, overview);
  assertGlobeVisible('Pinch zoom');
  overview.remove();
}

try {
  await verifyLabEntrance();
  verifyPlacement();
  bodies.firstElementChild.click();
  set('x', -0.5);
  set('y', 0);
  set('vy', -0.5);
  bodies.lastElementChild.click();
  set('x', 0.5);
  set('y', 0);
  set('z', 0.25);
  set('vy', 0.5);
  form.requestSubmit();
  await waitFor(() => currentSceneSnapshot()?.masses.length === 2 && !byId('scene-next').disabled, 'apply the newly placed bodies');
  const baseline = currentSceneSnapshot();
  assert(byId('scene-progress').textContent.includes('持续推演'), 'New scenes must default to continuous mode');
  verifyBodyDrag(baseline);
  tapToPlace(0.69, 0.57);
  assert(bodies.children.length === 3, 'An applied experiment must accept another draft body');
  const third = { name: '来客', radius: 0.2, density: 3, x: 1.5, y: -0.4, z: 0.3, vx: -0.12, vy: 0.2, vz: -0.06 };
  for (const [name, value] of Object.entries(third)) set(name, value);
  bodies.firstElementChild.click();
  set('density', field('density').valueAsNumber * 2);
  bodies.lastElementChild.click();
  assert(field('name').value === third.name && field('vz').valueAsNumber === third.vz,
    'Switching the inspected body must preserve its draft edits');
  byId('scene-dt').value = 1 / 256;
  end.value = 24;
  assert(JSON.stringify(currentSceneSnapshot()) === JSON.stringify(baseline), 'Draft edits must leave the applied world intact');
  form.requestSubmit();
  await waitFor(() => currentSceneSnapshot()?.masses.length === 3 && !byId('scene-next').disabled, 'apply three bodies');
  const initial = currentSceneSnapshot();
  assert(initial.values.length === 19 && initial.steps === 0 && initial.values[0] === 0, 'Invalid three-body initial snapshot');
  assert(JSON.stringify(initial.values.slice(13)) === JSON.stringify([third.x, third.y, third.z, third.vx, third.vy, third.vz]),
    'The third body must receive all three components of its position and velocity');
  assert(Math.abs(initial.masses[0] - 2 * baseline.masses[0]) < 1e-14, 'Changing density must change the applied mass');
  assert(Math.abs(initial.masses[2] - 4 * Math.PI * third.density * third.radius ** 3 / 3) < 1e-14,
    'Radius and density must determine the mass used by the worker');

  const original = await simulate();
  const endpoint = original.at(-1);
  assert(endpoint.values[0] === 24 / 256 && endpoint.values[15] !== third.z, 'Custom scene must evolve out of the XY plane');
  byId('scene-fit').click();
  const gl = canvas.getContext('webgl2');
  assert(gl && canvas.width > 0 && canvas.height > 0, 'Custom scene requires its WebGL view');
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  assert(pixels.some((value, i) => i % 4 === 1 && value > 160 && value > pixels[i - 1] + 28),
    'The third body must be rendered in green');

  const saved = captureDownload(byId('scene-export'));
  const exported = JSON.parse(await saved.text());
  assert(exported.settings.bodies.length === 3 && exported.settings.bodies[2].density === third.density,
    'The saved file must contain the applied scene and density');
  byId('scene-remove').click();
  form.requestSubmit();
  await waitFor(() => currentSceneSnapshot()?.masses.length === 2 && !byId('scene-next').disabled, 'delete the third body');
  importFile(byId('scene-file'), saved);
  await waitFor(() => currentSceneSnapshot()?.masses.length === 3 && !byId('scene-next').disabled, 'restore the third body');
  assert(bodies.children.length === 3 && JSON.stringify(currentSceneSnapshot()) === JSON.stringify(initial),
    'Import must restore the exact initial snapshot and the editable bodies');
  assert(JSON.stringify(await simulate()) === JSON.stringify(original), 'Reloaded scene replay must match the original');

  exported.settings.bodies[2].density = 0;
  importFile(byId('scene-file'), new Blob([JSON.stringify(exported)]));
  await waitFor(() => byId('scene-editor-status').textContent.includes('第 3 颗'), 'reject invalid density');
  assert(JSON.stringify(currentSceneSnapshot()) === JSON.stringify(endpoint), 'Invalid import must preserve the current scene');
  await verifyContinuation(initial);
  await verifySunEarthFile();
  await verifySolarSystem();
  await verifyTrisolaris();
  verifyThreeSunLighting();
  verifyOverview();

  window.parent.postMessage({
    type: 'scene-result',
    result: 'Space lab: verified the solar-system entrance, Trisolaris host exchanges and a bound stellar triple through t=2048, three concurrent light directions, empty custom grid, placing and moving bodies, applying conditions, exact replay, live speed changes and reset. Camera panning and following, planet textures, overview marker sizes and zoom, DE440 state and date, and Earth-centered lunar trail passed.',
  }, location.origin);
} catch (error) {
  window.parent.postMessage({ type: 'scene-result', error: String(error) }, location.origin);
}
