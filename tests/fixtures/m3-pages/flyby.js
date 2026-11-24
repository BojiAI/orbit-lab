import { clearPlot, draw } from './plot.js';
import { openWorker } from './worker-client.js';
import { downloadExperiment, readExperiment } from './experiment-file.js';
import { ADAPTIVE_FRACTION, CUSTOM_FIXED_DENOMINATOR, END_TIME, PRESETS } from './flyby-presets.js';

const initialForm = document.querySelector('#flyby-initial');
const presetSelect = document.querySelector('#flyby-preset');
const visitorY = document.querySelector('#flyby-y');
const visitorVx = document.querySelector('#flyby-vx');
const activeInitial = document.querySelector('#flyby-active-initial');
const stepDetail = document.querySelector('#flyby-step-detail');
const exportButton = document.querySelector('#flyby-export');
const importButton = document.querySelector('#flyby-import');
const fileInput = document.querySelector('#flyby-file');
const fileStatus = document.querySelector('#flyby-file-status');
const controls = document.querySelector('#flyby-controls');
const mode = document.querySelector('#flyby-mode');
const play = document.querySelector('#flyby-play');
const next = document.querySelector('#flyby-next');
const snapshot = document.querySelector('#snapshot');
const status = document.querySelector('#status');
const view = document.querySelector('#flyby-view');
const projection = document.querySelector('#flyby-xy');
const canvas = document.querySelector('#flyby-3d');
const resetCamera = document.querySelector('#flyby-camera-reset');
const cameraHint = document.querySelector('#flyby-camera-hint');
const viewStatus = document.querySelector('#flyby-view-status');
const gridKey = document.querySelector('#flyby-grid-key');
const defaultViewBox = projection.getAttribute('viewBox');
const plot = {
  stars: [1, 2, 3].map(i => document.querySelector(`#star${i}`)),
  trails: [1, 2, 3].map(i => document.querySelector(`#trail${i}`)),
};
const FRAME_DELAY_MS = 125; // Playback pacing for samples; integration is in WASM.
const sceneNames = {
  baseline: '原场景', closer: '更近', faster: '更快', 'closer-faster': '更近且更快', custom: '自定义',
};
const presetsById = new Map(PRESETS.map(preset => [preset.id, preset]));
let live;
let spatialView;

export function currentFlybySnapshot() {
  const frame = live?.frame;
  return frame ? { ...frame, values: frame.values.slice(), mode: live.mode, preset: live.scene.id } : null;
}

function fitProjection(values) {
  const box = projection.viewBox.baseVal;
  let left = box.x, top = box.y, right = box.x + box.width, bottom = box.y + box.height;
  const margin = 0.22;
  for (const offset of [1, 7, 13]) {
    const x = values[offset], y = -values[offset + 1];
    left = Math.min(left, x - margin);
    right = Math.max(right, x + margin);
    top = Math.min(top, y - margin);
    bottom = Math.max(bottom, y + margin);
  }
  if (left !== box.x || top !== box.y || right !== box.x + box.width || bottom !== box.y + box.height) {
    projection.setAttribute('viewBox', `${left} ${top} ${right - left} ${bottom - top}`);
  }
}

function showView(spatial, message = '') {
  projection.toggleAttribute('hidden', spatial);
  for (const element of [canvas, resetCamera, cameraHint, gridKey]) element.hidden = !spatial;
  viewStatus.textContent = message;
  viewStatus.hidden = !message;
}

function showFallback() {
  view.value = 'xy';
  showView(false, '三维视角不可用，已切回 XY 投影。');
}

function drawSpatial() {
  if (!spatialView || canvas.hidden) return;
  try {
    spatialView.draw(live.frames);
  } catch {
    showFallback();
  }
}

view.onchange = async () => {
  if (view.value === 'xy') {
    showView(false);
    return;
  }
  try {
    if (!spatialView) {
      showView(false, '正在加载三维视角…');
      const { createFlybyView } = await import('./flyby-3d.js');
      if (view.value !== '3d') return;
      spatialView ??= createFlybyView(canvas);
    }
    showView(true);
    drawSpatial();
  } catch {
    if (view.value === '3d') showFallback();
  }
};
resetCamera.onclick = () => spatialView?.reset();
canvas.addEventListener('webglcontextlost', () => {
  if (view.value === '3d') showFallback();
});

function showControls(run) {
  const complete = run.frame && run.frame.step === run.frame.end;
  const ready = run.frame && !complete && !run.error;
  play.disabled = !ready || (!run.playing && run.busy);
  play.textContent = ready && run.playing ? '暂停' : '播放';
  next.disabled = !ready || run.playing || run.busy;
  const text = run.error ? `飞掠运行失败。${run.error}` : complete ? '已到终点。' :
    !run.frame ? '正在读取初值…' : run.playing ? '播放中' : '已暂停';
  if (status.textContent !== text) status.textContent = text;
}

function advance(run) {
  if (run.frame && run.frame.step < run.frame.end) {
    receive(run, { type: 'next' }, run.frame.step + 1);
  }
}

function schedule(run) {
  run.timer = setTimeout(() => advance(run), FRAME_DELAY_MS);
}

async function receive(run, command, checkpoint) {
  if (run !== live || run.busy || run.error) return;
  run.busy = true;
  showControls(run);
  try {
    const frame = await run.worker.request(command, checkpoint);
    if (run !== live) return;
    if (!Number.isSafeInteger(frame.steps) || frame.steps < 0 ||
        !Number.isSafeInteger(frame.end) || frame.end < checkpoint) {
      throw Error('快照的步数或终点有误。');
    }
    run.frame = frame;
    run.frames.push(frame);
    draw(plot, frame);
    fitProjection(frame.values);
    drawSpatial();
    snapshot.textContent = `${run.label} · 模拟时刻 ${frame.values[0].toFixed(3)} · 已计算 ${frame.steps} 步`;
    if (frame.step === frame.end) {
      run.playing = false;
      run.worker.close();
    }
  } catch (error) {
    if (run !== live) return;
    run.error = error.message;
    run.playing = false;
    run.worker.close();
  } finally {
    run.busy = false;
    if (run === live) {
      showControls(run);
      if (run.playing) schedule(run);
    }
  }
}

function start(playing, scene = live?.scene ?? PRESETS[0]) {
  if (live) {
    clearTimeout(live.timer);
    live.worker?.close();
  }
  clearPlot(plot);
  projection.setAttribute('viewBox', defaultViewBox);
  snapshot.textContent = '';
  const run = { mode: mode.value, label: mode.selectedOptions[0].textContent, scene, playing, frames: [] };
  live = run;
  activeInitial.textContent = `当前实验 · ${sceneNames[scene.id]} · y = ${scene.y} · vx = ${scene.vx}`;
  stepDetail.textContent = run.mode === 'fixed'
    ? `每步 Δt = 1/${scene.fixedDenominator} · 播放至模拟时刻 ${END_TIME}`
    : `近遇时缩短步长 · 播放至模拟时刻 ${END_TIME}`;
  drawSpatial();
  try {
    run.worker = openWorker(new URL('./flyby-worker.js', import.meta.url), 19);
  } catch (error) {
    run.error = error.message;
    showControls(run);
    return;
  }
  const parameters = scene.id === 'custom' ? { y: scene.y, vx: scene.vx } : { preset: scene.index };
  receive(run, { type: 'init', mode: run.mode, ...parameters }, 0);
}

presetSelect.replaceChildren(...PRESETS.map(preset => new Option(sceneNames[preset.id], preset.id)),
  new Option(sceneNames.custom, 'custom'));

function populateInitialFields(scene) {
  presetSelect.value = scene.id;
  visitorY.value = scene.y;
  visitorVx.value = scene.vx;
  visitorVx.setCustomValidity('');
}

function loadPreset() {
  const preset = presetsById.get(presetSelect.value);
  if (preset) populateInitialFields(preset);
}

function customInitial(y, vx) {
  if (!Number.isFinite(y) || !Number.isFinite(vx) || vx <= 0) {
    throw Error('来客横向位置需为有限数，入射速度需大于 0。');
  }
  return { id: 'custom', y: y === 0 ? 0 : y, vx, fixedDenominator: CUSTOM_FIXED_DENOMINATOR };
}

function settingsOf(scene, selectedMode) {
  return {
    preset: scene.id, y: scene.y, vx: scene.vx, mode: selectedMode, endTime: END_TIME,
    fixedDt: 1 / scene.fixedDenominator, adaptiveFraction: ADAPTIVE_FRACTION,
  };
}

exportButton.onclick = () => {
  downloadExperiment('flyby', settingsOf(live.scene, live.mode), 'orbit-lab-flyby.json');
  fileStatus.textContent = '已导出当前实验设置。';
};

importButton.onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileInput.value = '';
  importButton.disabled = true;
  try {
    const settings = await readExperiment(file, 'flyby');
    const scene = settings.preset === 'custom' ? customInitial(settings.y, settings.vx) : presetsById.get(settings.preset);
    if (!scene || (settings.mode !== 'fixed' && settings.mode !== 'adaptive') ||
        Object.entries(settingsOf(scene, settings.mode)).some(([field, value]) => settings[field] !== value)) {
      throw Error('实验文件的初值或步长设置无效。');
    }
    populateInitialFields(scene);
    mode.value = settings.mode;
    start(false, scene);
    spatialView?.reset();
    fileStatus.textContent = '已导入实验。点击播放即可复跑。';
  } catch (error) {
    fileStatus.textContent = error.message;
  } finally {
    importButton.disabled = false;
  }
};

presetSelect.onchange = loadPreset;
for (const field of [visitorY, visitorVx]) {
  field.oninput = () => {
    presetSelect.value = 'custom';
    visitorVx.setCustomValidity(visitorVx.valueAsNumber <= 0 ? '入射速度需大于 0。' : '');
  };
}

initialForm.onsubmit = event => {
  event.preventDefault();
  const preset = presetsById.get(presetSelect.value);
  try {
    const scene = preset ?? customInitial(visitorY.valueAsNumber, visitorVx.valueAsNumber);
    start(false, scene);
    spatialView?.reset();
    fileStatus.textContent = '';
  } catch (error) {
    fileStatus.textContent = error.message;
  }
};

controls.onsubmit = event => {
  event.preventDefault();
  start(true);
};
mode.onchange = () => start(false);
play.onclick = () => {
  if (play.disabled) return;
  const run = live;
  run.playing = !run.playing;
  if (run.playing) schedule(run);
  else clearTimeout(run.timer);
  showControls(run);
};
next.onclick = () => {
  if (!next.disabled) advance(live);
};

loadPreset();
start(false);
