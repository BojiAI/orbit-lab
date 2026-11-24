// Served only by verify-m3.mjs. Runs inside the real page, not Node.
import { currentBranchSnapshot, currentSnapshot, run } from './page.js';

function assert(ok, message) { if (!ok) throw Error(message); }
function finiteRow(row) {
  return Array.isArray(row) && row.length === 13 && row.every(Number.isFinite);
}

async function verifyOrbit(q, filename) {
  const response = await fetch(filename);
  if (!response.ok) throw Error(`Reference: HTTP ${response.status}`);
  const reference = await response.json();
  assert(Array.isArray(reference) && reference.length === 65 && reference.every(finiteRow),
    'Expected 65 native reference rows of 13 finite numbers');

  let maxAbsError = 0;
  const tol = 1e-12;
  async function check(cadence) {
    let snapshots = 0, final;
    await run(cadence, ({ step, values, diagnostics }) => {
      assert(step === Math.min(snapshots * cadence, 1024), `Unexpected snapshot at step ${step}`);
      assert(finiteRow(values), `Invalid snapshot at step ${step}`);
      assert(diagnostics, `Missing conservation diagnostics at step ${step}`);
      if (step === 0) {
        const radii = [-q / (1 + q), 1 / (1 + q)];
        const initial = [0, ...radii.flatMap(r => [r, 0, 0, 0, r, 0])];
        assert(values.every((v, i) => Math.abs(v - initial[i]) <= tol), `Incorrect initial orbit for q=${q}`);
        const massProduct = q / (1 + q)**2;
        const [lx, ly, lz] = diagnostics.angularMomentum;
        assert(Math.abs(diagnostics.energy + massProduct / 2) <= tol &&
          Math.hypot(lx, ly, lz - massProduct) <= tol, `Incorrect initial energy or angular momentum for q=${q}`);
      }
      if (step % 16 === 0) {
        values.forEach((v, i) => {
          const error = Math.abs(v - reference[step / 16][i]);
          assert(error <= tol, `step ${step}, component ${i}: |${v} - ${reference[step / 16][i]}| = ${error} > ${tol}`);
          maxAbsError = Math.max(maxAbsError, error);
        });
      }
      snapshots++;
      if (step === 1024) final = values;
    }, q);
    assert(final && snapshots === Math.ceil(1024 / cadence) + 1, `Incomplete run at cadence ${cadence}`);
    return final;
  }
  const dense = await check(16);
  const sparse = await check(127);
  assert(dense.every((v, i) => Object.is(v, sparse[i])), 'Cadences produced different final states');
  return {
    finalFrame: { step: 1024, values: dense },
    report: `q=${q}: 65 native snapshots × 13 components; max absolute error ${maxAbsError} (limit ${tol}); cadences 16/127 identical at step 1024`,
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, description, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw Error(`Timed out waiting for ${description}`);
    await sleep(10);
  }
}

function assertSame(actual, expected, context) {
  assert(actual?.step === expected.step && finiteRow(actual.values) && finiteRow(expected.values) &&
    actual.values.every((v, i) => Object.is(v, expected.values[i])),
    `${context}: expected identical clock and state at step ${expected.step}, got step ${actual?.step}`);
}

function referenceWorker() {
  const worker = new Worker(new URL('./worker.js', import.meta.url));
  function request(command) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Reference worker timed out')), 3000);
      worker.onerror = e => { clearTimeout(timer); reject(Error(e.message)); };
      worker.onmessage = ({ data }) => {
        clearTimeout(timer);
        if (data.error) reject(Error(data.error)); else resolve(data);
      };
      worker.postMessage(command);
    });
  }
  return { request, close: () => worker.terminate() };
}

// A second, uninterrupted world: compare both the pause point and ten batched steps.
async function checkBatch(q, paused, end) {
  const { request, close } = referenceWorker();
  try {
    const initial = await request({ type: 'init', q });
    assert(initial.step === 0 && initial.values[0] === 0, 'Reference worker did not start at zero');
    const prefix = await request(paused.step);
    assertSame(prefix, paused, 'Pause point vs continuous run');
    assertSame(await request(0), prefix, 'Zero steps in same worker');
    assertSame(await request(10), end, 'Ten batched vs ten single steps');
    return initial;
  } finally { close(); }
}

const byId = id => document.getElementById(id);
const orbitsA = [1, 2].map(i => ({ trail: byId(`trail${i}`), star: byId(`star${i}`) }));

function checkDisplay({ step, values }) {
  assert(finiteRow(values), `Invalid displayed state at step ${step}`);
  orbitsA.forEach(({ star, trail }, i) => {
    const tip = trail.points.getItem(trail.points.length - 1);
    // SVG exposes float coordinates; the underlying worker state is checked at f64 precision.
    for (const [j, coord] of ['x', 'y'].entries()) {
      const target = values[1 + 6 * i + j];
      assert(Math.abs(star[`c${coord}`].animVal.value - target) <= 1e-7 &&
        Math.abs(tip[coord] - target) <= 1e-7, `SVG body ${i + 1} ${coord} disagrees at step ${step}: star=${star[`c${coord}`].animVal.value}, tip=${tip[coord]}, expected=${target}`);
    }
  });
}

function checkDrift(outputId, frame, baseline) {
  assert(frame.diagnostics && baseline.diagnostics, `Missing diagnostics for ${outputId} at ${frame.step}`);
  const current = frame.diagnostics, start = baseline.diagnostics;
  const energy = (current.energy - start.energy).toExponential(3);
  const angular = Math.hypot(...current.angularMomentum.map((l, i) => l - start.angularMomentum[i])).toExponential(3);
  const displayed = byId(outputId).textContent;
  assert(displayed.includes(`基线第 ${baseline.step} 步`) && displayed.includes(`ΔE ${energy}`) &&
    displayed.includes(`|ΔL| ${angular}`), `Incorrect drift for ${outputId} at ${frame.step}: ${displayed}`);
}

function checkPairGate(disabled, context) {
  assert(['pairStep', 'pairBatch'].every(id => byId(id).disabled === disabled), `Incorrect pair controls: ${context}`);
}

// Actual screen coordinates relative to the SVG viewport center (independent of page layout).
function screenPoint(element, x, y) {
  const rect = element.ownerSVGElement.getBoundingClientRect();
  const p = new DOMPoint(x, y).matrixTransform(element.getScreenCTM());
  return [p.x - (rect.left + rect.width / 2), p.y - (rect.top + rect.height / 2)];
}
function verifyCamera() {
  const camera = byId('camera'), world = byId('world'), cross = byId('barycenterB');
  const a = currentSnapshot(), b = currentBranchSnapshot();
  const comparison = byId('comparison').textContent;
  assert(!camera.disabled && camera.value === 'fixed' && a.step === b.step && a.values[0] === b.values[0],
    'Camera test requires a settled fixed view at matched clocks');
  function points() {
    const result = [];
    for (const suffix of ['', 'B']) for (const i of [1, 2]) {
      const star = byId(`star${suffix}${i}`), trail = byId(`trail${suffix}${i}`);
      assert(world.contains(star) && world.contains(trail) && world.contains(cross), 'Missing shared world transform');
      result.push(screenPoint(star, star.cx.baseVal.value, star.cy.baseVal.value));
      for (let j = 0; j < trail.points.length; j++) {
        const p = trail.points.getItem(j);
        result.push(screenPoint(trail, p.x, p.y));
      }
    }
    return result;
  }
  const fixed = points(), offset = screenPoint(cross, 0, 0);
  assert(Math.hypot(...offset) > 1, 'Fixed B barycenter must be visibly off-center after edit');
  for (const mode of ['followB', 'fixed']) {
    camera.value = mode;
    camera.dispatchEvent(new Event('change', { bubbles: true }));
    const expectedCross = mode === 'fixed' ? offset : [0, 0];
    const actualCross = screenPoint(cross, 0, 0);
    // CTM/DOM point conversions round SVG coordinates; allow 0.01 CSS px, not a physics tolerance.
    assert(Math.hypot(actualCross[0] - expectedCross[0], actualCross[1] - expectedCross[1]) < 0.01,
      `B barycenter is misplaced in ${mode}`);
    const actual = points();
    assert(actual.length === fixed.length && actual.every((p, i) => p.every((v, j) =>
      Math.abs(v - fixed[i][j] - (expectedCross[j] - offset[j])) < 0.01)), `Stars/trails shifted inconsistently in ${mode}`);
    assertSame(currentSnapshot(), a, `${mode} moved A`);
    const nowB = currentBranchSnapshot();
    assertSame(nowB, b, `${mode} moved B`);
    assert(nowB.masses.every((m, i) => Object.is(m, b.masses[i])) && byId('comparison').textContent === comparison,
      `${mode} changed masses or same-time distances`);
  }
}

async function verifyFork() {
  const fork = document.querySelector('#fork'), b = document.querySelector('#singleB');
  const a = document.querySelector('#single');
  const start = currentSnapshot();
  assert(start.step > 0 && !fork.disabled && b.disabled, 'Fork must start from a settled pause');
  fork.click();
  await waitFor(() => !b.disabled, 'fork B');
  const split = currentBranchSnapshot();
  assertSame(split, start, 'Fork inherits the committed A snapshot');
  checkDrift('snapshotB', split, split);
  function checkBPlot(frame) {
    for (const i of [1, 2]) {
      const star = document.querySelector(`#starB${i}`), trail = document.querySelector(`#trailB${i}`);
      const tip = trail.points.getItem(trail.points.length - 1);
      assert(getComputedStyle(star).visibility === 'visible' && star.getBoundingClientRect().width >= 1, 'B marker hidden');
      for (const [axis, coord] of ['x', 'y'].entries()) {
        const v = frame.values[1 + 6 * (i - 1) + axis];
        assert(Math.abs(tip[coord] - v) <= 1e-7 && Math.abs(star[`c${coord}`].animVal.value - v) <= 1e-7,
          `B marker or trail misplaced at step ${frame.step}`);
      }
    }
  }
  checkBPlot(start);
  const path = [];
  for (let i = 1; i <= 10; i++) {
    b.click();
    await waitFor(() => !b.disabled && currentBranchSnapshot()?.step === start.step + i, 'independent B step');
    path.push(currentBranchSnapshot());
    checkBPlot(path[i - 1]);
    assertSame(currentSnapshot(), start, 'B did not advance A');
  }
  checkDrift('snapshotB', path[path.length - 1], split);
  for (const expected of path) {
    a.click();
    await waitFor(() => !a.disabled && currentSnapshot()?.step === expected.step, 'A catching B');
    assertSame(currentSnapshot(), expected, 'A and B at the same step');
    assertSame(currentBranchSnapshot(), path[path.length - 1], 'A did not advance B');
  }
  return `Fork at ${start.step}: ten B-only steps left A unchanged, then A matched B at every corresponding step.`;
}

// Start with warm, coincident A/B worlds. Compare trajectories only at equal times.
async function verifyMassEdit(initialA) {
  const input = document.querySelector('#massB'), apply = document.querySelector('#applyMassB');
  const start = currentSnapshot(), branch = currentBranchSnapshot();
  assertSame(branch, start, 'Mass intervention requires matched starting states');
  checkDrift('snapshot', start, initialA);
  const displayA = byId('snapshot').textContent;
  const setInput = mass => {
    input.value = String(mass);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  function checkCenter(expected) {
    const marker = document.querySelector('#barycenterB');
    const { e, f } = marker.transform.baseVal.getItem(0).matrix;
    assert(getComputedStyle(marker).visibility === 'visible' && Math.hypot(e - expected[0], f - expected[1]) < 1e-7,
      'B barycenter marker disagrees with independent reference');
  }
  checkCenter([0, 0]); // Equal masses, initially in the center-of-mass frame.
  const tipCount = document.querySelector('#trailB1').points.length;
  const newMass = 2 * branch.masses[1];
  setInput(newMass);
  apply.click();
  await waitFor(() => currentBranchSnapshot()?.masses[1] === newMass, 'B mass edit acknowledgement');
  const edited = currentBranchSnapshot();
  assert(edited.masses[0] === branch.masses[0], 'B primary mass changed');
  assertSame(edited, start, 'Edit jumped time, position or velocity');
  checkDrift('snapshotB', edited, edited);
  assert(byId('snapshot').textContent === displayA, 'Editing B changed A diagnostics');
  // Only the companion's kinetic/potential contributions and r × p change at the edit.
  const deltaMass = newMass - branch.masses[1];
  const speedSquared = branch.values.slice(10, 13).reduce((sum, v) => sum + v * v, 0);
  const distance = Math.hypot(...[1, 2, 3].map(i => branch.values[i + 6] - branch.values[i]));
  const expectedEnergyJump = deltaMass * (0.5 * speedSquared - branch.masses[0] / distance);
  const expectedLzJump = deltaMass * (branch.values[7] * branch.values[11] - branch.values[8] * branch.values[10]);
  const angularJump = edited.diagnostics.angularMomentum.map((l, i) => l - branch.diagnostics.angularMomentum[i]);
  assert(Math.abs(edited.diagnostics.energy - branch.diagnostics.energy - expectedEnergyJump) <= 1e-12 &&
    Math.hypot(angularJump[0], angularJump[1], angularJump[2] - expectedLzJump) <= 1e-12,
    'B diagnostics did not reflect the mass intervention');
  // Equal/opposite states with masses changed from (0.5,0.5) to (0.5,1).
  const center = [7, 8].map(i => edited.values[i] / 3);
  const drift = [10, 11].map(i => edited.values[i] / 3);
  checkCenter(center);
  assertSame(currentSnapshot(), start, 'Edit changed A');
  assert(document.querySelector('#trailB1').points.length === tipCount, 'Edit added a spurious sample');
  document.querySelector('#advanceB').click();
  const end = start.step + 64;
  await waitFor(() => currentBranchSnapshot()?.step === end, 'B mass experiment batch');
  assertSame(currentSnapshot(), start, 'B batch changed A');
  const evolved = currentBranchSnapshot();
  checkDrift('snapshotB', evolved, edited);
  apply.click(); // Submitting the current mass leaves the physical baseline intact.
  await waitFor(() => !apply.disabled, 'same-mass acknowledgement');
  assertSame(currentBranchSnapshot(), evolved, 'Same-mass edit advanced B');
  checkDrift('snapshotB', currentBranchSnapshot(), edited);
  // Only internal forces act after the edit, so the new barycenter drifts uniformly.
  const elapsed = evolved.values[0] - edited.values[0];
  checkCenter(center.map((v, i) => v + elapsed * drift[i]));
  const align = document.querySelector('#align'), comparison = document.querySelector('#comparison');
  assert(!align.disabled && comparison.textContent.includes('不比较位置'), 'Unmatched clocks must hide separation');
  checkPairGate(true, 'B ahead of A');
  align.click();
  await waitFor(() => currentSnapshot()?.step === end && align.disabled, 'A catches B');
  const control = currentSnapshot();
  checkDrift('snapshot', control, initialA);
  assertSame(currentBranchSnapshot(), evolved, 'Advancing A changed edited B');
  assert(control.values[0] === evolved.values[0], 'Different times at comparison');
  const separation = Math.hypot(...[1,2,3].map(i => evolved.values[i] - control.values[i]));
  assert(separation > 1e-6, 'No measurable trajectory change after B mass edit');
  const secondary = Math.hypot(...[7,8,9].map(i => evolved.values[i] - control.values[i]));
  assert(comparison.textContent.includes(`主星 ${separation.toPrecision(6)}，伴星 ${secondary.toPrecision(6)}`), 'Incorrect same-time position differences');
  verifyCamera();
  const aRef = referenceWorker(), bRef = referenceWorker();
  try {
    await aRef.request({ type: 'init', q: 1 });
    assertSame(await aRef.request(end), control, 'A diverged from untouched control');
    await bRef.request({ type: 'init', q: 1 });
    await bRef.request(start.step);
    await bRef.request({ type: 'fork' });
    await bRef.request({ type: 'setMassB', index: 1, mass: newMass });
    assertSame(await bRef.request({ type: 'stepB', count: 64 }), evolved, 'Independent edited B baseline');
    let target = end;
    for (const [id, count] of [['pairStep', 1], ['pairBatch', 64]]) {
      target += count;
      checkPairGate(false, `before paired +${count}`);
      const trails = ['trail1', 'trail2', 'trailB1', 'trailB2'].map(byId);
      const lengths = trails.map(trail => trail.points.length);
      byId(id).click();
      checkPairGate(true, `while paired +${count} is in flight`);
      await waitFor(() => currentSnapshot()?.step === target && currentBranchSnapshot()?.step === target && !byId(id).disabled,
        `paired +${count} to ${target}`);
      const samples = trails[0].points.length - lengths[0];
      assert((count === 1 ? samples === 1 : samples > 1) && trails.every((trail, i) => trail.points.length - lengths[i] === samples),
        `Paired +${count} did not append matching trajectory samples`);
      const a = currentSnapshot(), b = currentBranchSnapshot();
      checkDrift('snapshot', a, initialA);
      checkDrift('snapshotB', b, edited);
      assertSame(a, await aRef.request(count), `Paired +${count} A vs untouched control`);
      assertSame(b, await bRef.request({ type: 'stepB', count }), `Paired +${count} B vs independent edited reference`);
      assert(b.masses[1] === newMass && a.values[0] === b.values[0], 'Paired advance lost B mass or clock agreement');
      const distance = k => Math.hypot(...[k,k+1,k+2].map(i => a.values[i] - b.values[i])).toPrecision(6);
      assert(comparison.textContent.includes(`主星 ${distance(1)}，伴星 ${distance(7)}`), 'Stale paired-step distances');
    }
  } finally { aRef.close(); bRef.close(); }
  return `Step ${start.step}: B companion ${branch.masses[1]} -> ${newMass}, no instantaneous state jump. The diagnostic baseline restarted for B and stayed at step 0 for A. After 64 steps primary |B-A|=${separation}; both camera modes preserve the comparison; paired +1/+64 match independent controls.`;
}

async function verifyControls() {
  const pause = document.querySelector('#pause'), single = document.querySelector('#single');
  const q = document.querySelector('#q').valueAsNumber;
  await waitFor(() => currentSnapshot()?.step > 0 && !pause.disabled && orbitsA.every(({ star, trail }) =>
    trail.points.length >= 2 && trail.getTotalLength() > 0 && star.getBoundingClientRect().width >= 1 &&
    getComputedStyle(star).visibility === 'visible'), 'visible live trajectory');
  pause.click();
  await waitFor(() => !single.disabled, 'pause acknowledgement');
  const paused = structuredClone(currentSnapshot());
  checkPairGate(true, 'paused without B');
  assert(byId('camera').disabled && byId('camera').value === 'fixed', 'Without B only the fixed camera is available');
  checkDisplay(paused);
  // The default automatic interval is 125 ms. Check several times after it could have fired.
  for (let i = 0; i < 3; i++) {
    await sleep(150);
    assertSame(currentSnapshot(), paused, 'Paused across automatic tick');
    checkDisplay(paused);
  }
  let previous = paused;
  for (let i = 0; i < 10; i++) {
    single.click();
    await waitFor(() => !single.disabled && currentSnapshot()?.step > previous.step, 'single-step acknowledgement');
    const next = structuredClone(currentSnapshot());
    assert(next.step === previous.step + 1 && Object.is(next.values[0], previous.values[0] + 2 * Math.PI / 1024),
      `Single click did not advance exactly one fixed step from ${previous.step}`);
    checkDisplay(next);
    previous = next;
  }
  const initialA = await checkBatch(q, paused, previous);
  checkDrift('snapshot', previous, initialA);
  const forkResult = await verifyFork();
  const massResult = await verifyMassEdit(initialA);
  await verifySpatialComparison();
  const caughtUp = currentSnapshot(), frozenB = currentBranchSnapshot();
  pause.click();
  await waitFor(() => single.disabled && currentSnapshot()?.step > caughtUp.step, 'automatic advance after resume');
  checkDisplay(currentSnapshot());
  assertSame(currentBranchSnapshot(), frozenB, 'B remains paused during A playback');
  const resumeTarget = caughtUp.step + 80; // Require multiple 64-step batches for B to catch up.
  await waitFor(() => currentSnapshot()?.step >= resumeTarget, 'A leads by more than one B batch');
  pause.click();
  await waitFor(() => !single.disabled, 'pause before B catches A');
  const ahead = currentSnapshot();
  checkPairGate(true, 'A ahead of B');
  document.querySelector('#align').click();
  await waitFor(() => currentBranchSnapshot()?.step === ahead.step && !single.disabled, 'B catches A across batches');
  assertSame(currentSnapshot(), ahead, 'B catch-up must not move A');
  assert(currentBranchSnapshot().values[0] === ahead.values[0], 'B catch-up clock mismatch');
  // Leave follow mode selected while advancing: the camera must track the moving B,
  // and rebuilding must discard the old camera target along with the old branch.
  const camera = byId('camera');
  camera.value = 'followB';
  camera.dispatchEvent(new Event('change', { bubbles: true }));
  for (let step = ahead.step; step < 1024;) {
    checkPairGate(false, `before end-limit batch from ${step}`);
    step = Math.min(step + 64, 1024);
    byId('pairBatch').click();
    await waitFor(() => currentSnapshot()?.step === step && currentBranchSnapshot()?.step === step &&
      (step === 1024 || !byId('pairBatch').disabled), `paired batch capped at ${step}`);
    assert(Math.hypot(...screenPoint(byId('barycenterB'), 0, 0)) < 0.01, `Follow camera missed B at step ${step}`);
  }
  checkPairGate(true, 'both worlds at endpoint');
  assert(currentSnapshot().values[0] === currentBranchSnapshot().values[0], 'End-limit clocks differ');
  document.querySelector('#controls').requestSubmit();
  await waitFor(() => currentSnapshot()?.step === 0 && currentBranchSnapshot() === null, 'rebuild clears branch');
  const rebuilt = currentSnapshot();
  checkDrift('snapshot', rebuilt, rebuilt);
  assert(byId('snapshotB').textContent === '', 'Rebuild left B diagnostics visible');
  assert(getComputedStyle(document.querySelector('#barycenterB')).visibility === 'hidden', 'Rebuild left B barycenter visible');
  assert(camera.disabled && camera.value === 'fixed' && Math.hypot(...screenPoint(byId('world'), 0, 0)) < 0.01,
    'Rebuild left camera following the old branch');
  checkPairGate(true, 'rebuilt without B');
  return `${forkResult}\n${massResult}\nBinary WebGL rendered the B branch without advancing either world. Live SVG: paused at step ${paused.step}; state held across three auto intervals; ten single steps match batch at ${previous.step} exactly; zero-step worker read and resume verified.`;
}

async function verifySpatialComparison() {
  const a = currentSnapshot(), b = currentBranchSnapshot();
  const view = byId('binary-view'), canvas = byId('binary-3d');
  view.value = '3d';
  view.dispatchEvent(new Event('change'));
  await waitFor(() => !canvas.hidden, 'binary three-dimensional view');
  assert(getComputedStyle(byId('binary-xy')).display === 'none', 'Both binary projections are visible');
  byId('binary-fit').click();
  const gl = canvas.getContext('webgl2');
  assert(gl && canvas.height > 0 && canvas.width > 0, 'Binary WebGL view is unavailable');
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  assert(pixels.some((value, i) => i % 4 === 2 && value > 166 && value > pixels[i - 1] + 28 && pixels[i - 2] > 120),
    'The B branch must be rendered in purple');
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true }));
  assertSame(currentSnapshot(), a, '3D camera must preserve A');
  assertSame(currentBranchSnapshot(), b, '3D camera must preserve B');
  view.value = 'xy';
  view.dispatchEvent(new Event('change'));
  assert(canvas.hidden && getComputedStyle(byId('binary-xy')).display !== 'none', 'Binary XY projection must be restored');
  checkDisplay(a);
}

async function verifyLiveCadences(q, expected) {
  byId('q').valueAsNumber = q;
  const counts = [];
  for (const cadence of [16, 127]) {
    byId('cadence').valueAsNumber = cadence;
    byId('controls').requestSubmit();
    // A full automatic playback is paced at eight seconds in the page.
    await waitFor(() => currentSnapshot()?.step === expected.step, `live playback at cadence ${cadence}`, 12000);
    const frame = currentSnapshot();
    assertSame(frame, expected, `Live cadence ${cadence} vs independent replay`);
    checkDisplay(frame);
    const samples = Math.ceil(expected.step / cadence) + 1;
    const actual = orbitsA.map(({ trail }) => trail.points.length);
    assert(actual.every(count => count === samples), `Live cadence ${cadence}: expected ${samples} SVG samples per trail, got ${actual.join('/')}`);
    counts.push(actual[0]);
  }
  return `Live q=${q}: cadences 16/127 drew ${counts.join('/')} SVG samples per trail; both matched all 13 replay components at step ${expected.step}.`;
}

function verifyExperimentPage(page, title, resultType) {
  const link = document.querySelector(`a[href="./${page}"]`);
  assert(link, `The binary bench must link to ${page}`);
  const frame = document.createElement('iframe');
  frame.title = title;
  frame.width = 760;
  frame.height = 600;
  frame.src = link.href;
  let onMessage;
  return new Promise((resolve, reject) => {
    onMessage = event => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin ||
          event.data?.type !== resultType) return;
      if (event.data.error) reject(Error(event.data.error));
      else resolve(event.data.result);
    };
    window.addEventListener('message', onMessage);
    document.body.append(frame);
  }).finally(() => {
    window.removeEventListener('message', onMessage);
    frame.remove();
  });
}

try {
  const controls = await verifyControls();
  const equal = await verifyOrbit(1, './m3-reference.json');
  const unequal = await verifyOrbit(0.25, './m3-unequal.json');
  const liveCadences = await verifyLiveCadences(0.25, unequal.finalFrame);
  const experiments = await Promise.all([
    verifyExperimentPage('flyby.html', '三体飞掠验收', 'flyby-result'),
    verifyExperimentPage('scene.html', '自定义场景验收', 'scene-result'),
  ]);
  const result = [controls, equal.report, unequal.report, liveCadences, ...experiments].join('\n');
  await fetch('./result', { method: 'POST', body: JSON.stringify({ result }) });
} catch (error) {
  await fetch('./result', { method: 'POST', body: JSON.stringify({ error: String(error) }) });
}
