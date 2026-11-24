import { clearPlot, draw } from './plot.js';
import { openWorker } from './worker-client.js';

const END = 1024;
const MS_PER_STEP = 8000 / END; // Display pacing only; the worker owns the fixed physical dt.

function validate(cadence, q) {
  if (!Number.isFinite(q) || q < 0.01 || q > 100) throw Error('Mass ratio q must be in [0.01, 100]');
  if (!Number.isInteger(cadence) || cadence < 1 || cadence > END) throw Error('Invalid cadence');
}

function openBinaryWorker() {
  return openWorker(new URL('./worker.js', import.meta.url), 13, data => {
    const diagnostics = data.diagnostics;
    if (!Number.isFinite(diagnostics?.energy) || !Array.isArray(diagnostics.angularMomentum) ||
        diagnostics.angularMomentum.length !== 3 || !diagnostics.angularMomentum.every(Number.isFinite)) {
      data.diagnostics = null;
    }
  });
}

export async function run(cadence, observe, q = 1) {
  validate(cadence, q);
  const worker = openBinaryWorker();
  try {
    let step = 0;
    observe(await worker.request({ type: 'init', q }, step));
    while (step < END) {
      const count = Math.min(cadence, END - step);
      step += count;
      observe(await worker.request(count, step));
    }
  } finally { worker.close(); }
}

const controls = document.querySelector('#controls');
const output = document.querySelector('#snapshot');
const status = document.querySelector('#status');
const pause = document.querySelector('#pause');
const single = document.querySelector('#single');
const fork = document.querySelector('#fork');
const singleB = document.querySelector('#singleB');
const advanceB = document.querySelector('#advanceB');
const massB = document.querySelector('#massB');
const applyMassB = document.querySelector('#applyMassB');
const align = document.querySelector('#align');
const comparison = document.querySelector('#comparison');
const statusB = document.querySelector('#statusB');
const outputB = document.querySelector('#snapshotB');
const barycenterB = document.querySelector('#barycenterB');
const camera = document.querySelector('#camera');
const world = document.querySelector('#world');
const pairStep = document.querySelector('#pairStep');
const pairBatch = document.querySelector('#pairBatch');
const view = document.querySelector('#binary-view');
const projection = document.querySelector('#binary-xy');
const canvas = document.querySelector('#binary-3d');
const resetView = document.querySelector('#binary-fit');
const viewHint = document.querySelector('#binary-view-hint');
const viewStatus = document.querySelector('#binary-view-status');
let spatialView;

function showView(spatial, message = '') {
  projection.toggleAttribute('hidden', spatial);
  for (const element of [canvas, resetView, viewHint]) element.hidden = !spatial;
  viewStatus.textContent = message;
  viewStatus.hidden = !message;
}

function restoreProjection() {
  view.value = 'xy';
  showView(false, '三维视图不可用，已切回 XY 投影。');
}

function drawSpatial(s, reset = false) {
  if (!spatialView || canvas.hidden) return;
  const a = s?.framesA ?? [];
  const b = s?.framesB ?? [];
  const focus = camera.value === 'followB' && s?.centerB ? s.centerB : [0, 0, 0];
  try {
    spatialView.draw([
      { frames: a, offset: 1, color: 0xffba70, radius: 0.035 },
      { frames: a, offset: 7, color: 0x62cdea, radius: 0.035 },
      { frames: b, offset: 1, color: 0xcf9aff, radius: 0.06, outline: true },
      { frames: b, offset: 7, color: 0xcf9aff, radius: 0.06, outline: true },
    ], focus);
    if (reset) spatialView.reset();
  } catch {
    restoreProjection();
  }
}

view.onchange = async () => {
  if (view.value === 'xy') return showView(false);
  try {
    if (!spatialView) {
      showView(false, '正在加载三维视角…');
      const { createOrbitView } = await import('./flyby-3d.js');
      if (view.value !== '3d') return;
      spatialView ??= createOrbitView(canvas);
    }
    showView(true);
    drawSpatial(live);
  } catch {
    if (view.value === '3d') restoreProjection();
  }
};
resetView.onclick = () => drawSpatial(live, true);
canvas.addEventListener('webglcontextlost', () => {
  if (view.value === '3d') restoreProjection();
});

function updateCamera(s) {
  camera.disabled = !s?.centerB;
  if (camera.disabled) camera.value = 'fixed';
  const [x, y] = camera.value === 'followB' ? s.centerB : [0, 0];
  world.setAttribute('transform', `translate(${-x} ${-y})`);
}
camera.onchange = () => {
  updateCamera(live);
  drawSpatial(live, true);
};
function plot(suffix) {
  const select = id => [1, 2].map(i => document.querySelector(`#${id}${suffix}${i}`));
  return { stars: select('star'), trails: select('trail') };
}
const plotA = plot(''), plotB = plot('B');
let live;

function copy(frame) {
  if (!frame) return null;
  const { step, values, diagnostics } = frame;
  const snapshot = { step, values: values.slice(), diagnostics: null };
  if (diagnostics) {
    snapshot.diagnostics = { energy: diagnostics.energy, angularMomentum: diagnostics.angularMomentum.slice() };
  }
  if (frame.masses) snapshot.masses = frame.masses.slice();
  return snapshot;
}
export function currentSnapshot() { return copy(live?.frame); }
export function currentBranchSnapshot() { return copy(live?.branch); }

function describe(output, massLabel, { step, values, diagnostics }, baseline) {
  let drift = '不可用';
  if (diagnostics && baseline.diagnostics) {
    const deltaEnergy = diagnostics.energy - baseline.diagnostics.energy;
    const deltaAngularMomentum = Math.hypot(...diagnostics.angularMomentum.map((component, i) =>
      component - baseline.diagnostics.angularMomentum[i]));
    if (Number.isFinite(deltaEnergy) && Number.isFinite(deltaAngularMomentum)) {
      drift = `能量差 ΔE ${deltaEnergy.toExponential(3)}　角动量差 |ΔL| ${deltaAngularMomentum.toExponential(3)}`;
    }
  }
  output.textContent = `${massLabel}　采样步 ${step}/${END}　模拟时刻 ${values[0].toFixed(4)}\n` +
    `守恒量漂移（基线第 ${baseline.step} 步）　${drift}`;
}

function compareFrames(a, b) {
  if (!a || !b) return '先创建 B，再比较同一时刻的位置。';
  if (a.step !== b.step || a.values[0] !== b.values[0]) {
    return `A 第 ${a.step} 步，B 第 ${b.step} 步：时刻不同，不比较位置。`;
  }
  const distance = k => Math.hypot(...[k,k+1,k+2].map(i => a.values[i] - b.values[i])).toPrecision(6);
  return `第 ${a.step} 步 · A/B 三维位置差（初始间距为 1）：主星 ${distance(1)}，伴星 ${distance(7)}`;
}

function showControls(s) {
  const ended = s.frame?.step === END;
  const ready = s.frame && !ended && !s.error;
  pause.textContent = !ready || s.playing ? '暂停' : '继续播放';
  pause.disabled = !ready || (!s.playing && s.busy);
  single.disabled = !ready || s.playing || s.busy;
  const settled = s.frame && !s.playing && !s.busy && !s.error;
  align.disabled = !settled || !s.branch || s.frame.step === s.branch.step;
  pairStep.disabled = pairBatch.disabled = !settled || ended || !s.branch ||
    s.frame.step !== s.branch.step || s.frame.values[0] !== s.branch.values[0];
  comparison.textContent = s.error ? '推进失败，仅保留各分支最后确认的快照，不比较位置。' :
    s.busy === 'pair' ? 'A、B 正在分别推进，完成后再比较。' : compareFrames(s.frame, s.branch);
  fork.disabled = !settled || ended;
  fork.textContent = s.branch ? '用当前 A 替换 B' : '从 A 创建 B';
  massB.disabled = applyMassB.disabled = !settled || !s.branch;
  singleB.disabled = advanceB.disabled = !settled || !s.branch || s.branch.step === END;
  const branchText = s.error ? '已停止，请重建圆轨道。' : s.busy === 'pair' ? 'A、B 正在分别推进…' : s.busy === 'fork' ? '正在复制 A…' :
    s.busy === 'setMassB' ? '正在修改 B 的伴星质量…' : s.busy === 'stepB' ? 'B 正在推进…' : !s.branch ? '尚未创建 B。' :
    s.branch.step === END ? 'B 已到终点。' : s.playing ? 'B 已暂停；暂停 A 后可单步推进 B。' : 'B 已暂停。';
  if (statusB.textContent !== branchText) statusB.textContent = branchText;
  const text = s.error || (ended ? '已到终点。重建圆轨道可重新开始。' : !s.frame ? '正在读取初值…' :
    s.playing ? '播放中' : s.busy ? '正在等待物理步完成…' : '已暂停');
  if (status.textContent !== text) status.textContent = text;
}

function schedule(s) {
  const count = Math.min(s.cadence, END - s.frame.step);
  // Account for request/render time even at cadence 1. Do not queue catch-up batches.
  s.due = Math.max(performance.now(), s.due + count * MS_PER_STEP);
  s.timer = setTimeout(() => receive(s, count, s.frame.step + count), s.due - performance.now());
}

// Consume only confirmed snapshots; a failed batch may have committed unreported steps.
async function sample(s, message, expectedStep) {
  const frame = await s.worker.request(message, expectedStep);
  if (s !== live) return; // A rebuild retired this worker while its response was pending.
  if (message.type === 'fork' || message.type === 'stepB' || message.type === 'setMassB') {
    const masses = frame.masses;
    if (!Array.isArray(masses) || masses.length !== 2 || !masses.every(m => Number.isFinite(m) && m > 0)) {
      throw Error('Invalid masses in B snapshot');
    }
    const isFork = message.type === 'fork';
    if (isFork) {
      clearPlot(plotB);
      s.framesB.length = 0;
      // At the smallest initial q, m₂ = q / (1 + q) is just below the edit range.
      massB.value = Math.max(Number(massB.min), masses[1]);
    }
    if (isFork || masses.some((mass, i) => mass !== s.branch.masses[i])) {
      s.baselineB = frame;
    }
    s.branch = frame;
    if (message.type !== 'setMassB') {
      s.framesB.push(frame); // Same-step edit adds no trail point.
      draw(plotB, frame);
    }
    const center = [1, 2, 3].map(k => (masses[0] * frame.values[k] + masses[1] * frame.values[k + 6]) / (masses[0] + masses[1]));
    s.centerB = center;
    updateCamera(s);
    drawSpatial(s);
    barycenterB.setAttribute('transform', `translate(${center[0]} ${center[1]})`);
    barycenterB.setAttribute('visibility', 'visible');
    describe(outputB, `m₁ = ${masses[0]}　m₂ = ${masses[1]}　质心 (${center.map(x => x.toFixed(5)).join(', ')})`, frame, s.baselineB);
    return;
  }
  s.frame = frame;
  s.baselineA ??= frame;
  s.framesA.push(frame);
  draw(plotA, frame);
  drawSpatial(s);
  describe(output, `q = ${s.q}`, frame, s.baselineA);
  if (frame.step === END) {
    s.playing = false;
    if (!s.branch) s.worker.close(); // An existing B still accepts paused mass edits.
  } else if (s.playing) {
    if (frame.step === 0) s.due = performance.now();
    schedule(s);
  }
}

async function withWorkerLock(s, operation, work) {
  if (s !== live || s.busy || s.error) return;
  s.busy = operation;
  showControls(s);
  try {
    await work();
  } catch (error) {
    if (s !== live) return;
    s.error = String(error);
    s.worker.close();
  } finally {
    s.busy = false;
    if (s === live) showControls(s);
  }
}

function receive(s, message, expectedStep) {
  return withWorkerLock(s, message.type || 'step', () => sample(s, message, expectedStep));
}

function advancePair(limit) {
  if (pairStep.disabled) return;
  const s = live;
  const end = Math.min(END, s.frame.step + limit);
  return withWorkerLock(s, 'pair', async () => {
    while (s === live && s.frame.step < end) {
      const count = Math.min(8, end - s.frame.step);
      const next = s.frame.step + count;
      await sample(s, count, next);
      if (s !== live) return;
      await sample(s, { type: 'stepB', count }, next);
      if (s !== live) return;
      if (s.frame.values[0] !== s.branch.values[0]) throw Error('两分支的模拟时刻不一致');
    }
  });
}
pairStep.onclick = () => advancePair(1);
pairBatch.onclick = () => advancePair(64);

pause.onclick = () => {
  if (pause.disabled) return;
  const s = live;
  s.playing = !s.playing;
  if (s.playing) {
    s.due = performance.now();
    schedule(s);
  } else {
    clearTimeout(s.timer); // A request already in flight will still be drawn before enabling single.
  }
  showControls(s);
};
single.onclick = () => {
  if (!single.disabled) receive(live, 1, live.frame.step + 1);
};
fork.onclick = () => {
  if (!fork.disabled) receive(live, { type: 'fork' }, live.frame.step);
};
singleB.onclick = () => {
  if (!singleB.disabled) receive(live, { type: 'stepB', count: 1 }, live.branch.step + 1);
};

advanceB.onclick = () => {
  if (advanceB.disabled) return;
  const count = Math.min(64, END - live.branch.step);
  receive(live, { type: 'stepB', count }, live.branch.step + count);
};
align.onclick = async () => {
  if (align.disabled) return;
  const s = live;
  // Each request advances only the lagging world. B's protocol caps a batch at 64.
  while (s === live && !s.error && s.frame.step !== s.branch.step) {
    const gap = s.branch.step - s.frame.step;
    const count = Math.min(64, Math.abs(gap));
    if (gap > 0) await receive(s, count, s.frame.step + count);
    else await receive(s, { type: 'stepB', count }, s.branch.step + count);
  }
};
applyMassB.onclick = () => {
  if (applyMassB.disabled || !massB.reportValidity()) return;
  receive(live, { type: 'setMassB', index: 1, mass: massB.valueAsNumber }, live.branch.step);
};

controls.onsubmit = event => {
  event.preventDefault();
  const q = document.querySelector('#q').valueAsNumber;
  const cadence = document.querySelector('#cadence').valueAsNumber;
  try {
    validate(cadence, q);
    if (live) {
      clearTimeout(live.timer);
      live.worker.close();
    }
    live = null;
    updateCamera(null);
    comparison.textContent = compareFrames(null, null);
    clearPlot(plotA);
    clearPlot(plotB);
    drawSpatial(null, true);
    barycenterB.setAttribute('visibility', 'hidden');
    massB.value = '';
    output.textContent = outputB.textContent = '';
    statusB.textContent = '尚未创建 B。';
    fork.textContent = '从 A 创建 B';
    live = { worker: openBinaryWorker(), q, cadence, frame: null, framesA: [], framesB: [], playing: true };
    receive(live, { type: 'init', q }, 0);
  } catch (error) {
    status.textContent = String(error);
    if (!live) {
      for (const control of [pause, single, fork, singleB, advanceB, massB, applyMassB, align, pairStep, pairBatch]) control.disabled = true;
    }
  }
};
controls.requestSubmit();
