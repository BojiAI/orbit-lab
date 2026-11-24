import { downloadExperiment, readExperiment } from './experiment-file.js';
import { AU_KM, createOrbitView, PLANET_PRESETS, SUN_MASS_KG } from './flyby-3d.js';
import { bodyFromPreset, massOf, trisolarisSettings } from './scene-presets.js';
import { openWorker } from './worker-client.js';

const byId = id => document.getElementById(id);
const form = byId('scene-form');
const field = name => form.elements.namedItem(name);
const inspector = byId('scene-body-fields');
const bodyList = byId('scene-body-list');
const library = byId('scene-library');
const canvas = byId('scene-view');
const placementStatus = byId('scene-placement');
const cancelPlacement = byId('scene-cancel-placement');
const draftView = byId('scene-draft-view');
const runView = byId('scene-run-view');
const guides = byId('scene-guides');
const focusButton = byId('scene-focus');
const moonOrbitButton = byId('scene-moon-orbit');
const systemExample = byId('scene-system-example');
const trisolarisExample = byId('scene-trisolaris-example');
const customExperiment = byId('scene-custom-experiment');
const play = byId('scene-play');
const playLabel = byId('scene-play-label');
const single = byId('scene-next');
const restart = byId('scene-restart');
const rateSelect = byId('scene-speed');
const apply = byId('scene-apply');
const pendingApply = byId('scene-apply-pending');
const exportButton = byId('scene-export');
const importButton = byId('scene-import');
const removeButton = byId('scene-remove');
const fileInput = byId('scene-file');
const endInput = byId('scene-end');
const runStatus = byId('scene-run-status');
const editorStatus = byId('scene-editor-status');
const fileStatus = byId('scene-file-status');
const clock = byId('scene-clock');
const stepsLabel = byId('scene-steps');
const legend = byId('scene-legend');
const bodyTab = byId('scene-body-tab');
const simulationTab = byId('scene-simulation-tab');
const panels = Object.fromEntries(['scenarios', 'library', 'inspector', 'view'].map(name => [
  name, { panel: byId(`scene-${name}-panel`), trigger: byId(`scene-${name}-trigger`) },
]));

const BODY_PRESETS = [{ id: 'basic', name: '基础天体', radius: 0.1, mass: 0.06 }, ...Object.values(PLANET_PRESETS)];
const BODY_DRAG_TYPE = 'application/x-orbit-lab-body';
const COLORS = [0xffba70, 0x62cdea, 0x8be5ad, 0xcf9aff, 0xff939c, 0xf6d36c];
const POSITION_FIELDS = ['x', 'y', 'z'];
const VELOCITY_FIELDS = ['vx', 'vy', 'vz'];
const STEPS_PER_FRAME = 8;
const EPHEMERIS_STEPS_PER_DAY = 64;
const SECONDS_PER_DAY = 86_400;
const UNIX_EPOCH_JD = 2_440_587.5;
const SOLAR_GM = 132_712_440_041.279419;
const DAYS_PER_UNIT = Math.sqrt(AU_KM ** 3 / SOLAR_GM) / SECONDS_PER_DAY;
const FRAME_DELAY_MS = 42;
const MAX_TRAIL_SAMPLES = 256;
const number = value => value === 0 ? 0 : value;
const positive = value => Number.isFinite(value) && value > 0;
const colorAt = (body, index) => PLANET_PRESETS[body.appearance]?.color ?? COLORS[index % COLORS.length];
const bodyName = (body, index) => body.name.trim() || `天体 ${index + 1}`;

let live;
let starting = false;
let orbitView;
let view = 'draft';
let draftBodies = [];
let draftEpochJdTdb;
let selectedBody;
let draftRevision = 0;
let appliedRevision = 0;
let placing = null;
let bodyDrag;
let runGuides = false;
let activePanel;

function frameScene() {
  if (!orbitView) return;
  const drawer = activePanel === 'library' || activePanel === 'inspector' ? panels[activePanel].panel : null;
  if (!drawer || view === 'draft') {
    orbitView.setViewportInsets();
    return;
  }
  const scene = canvas.getBoundingClientRect();
  const panel = drawer.getBoundingClientRect();
  if (matchMedia('(max-width: 760px)').matches) {
    const header = document.querySelector('.lab-header').getBoundingClientRect();
    orbitView.setViewportInsets({ top: header.bottom - scene.top + 10, bottom: scene.bottom - panel.top + 10 });
  } else if (activePanel === 'library') {
    orbitView.setViewportInsets({ left: panel.right - scene.left + 16 });
  } else {
    orbitView.setViewportInsets({ right: scene.right - panel.left + 16 });
  }
}

function showPanel(name, restoreFocus = false) {
  const previous = activePanel;
  activePanel = name;
  for (const [key, { panel, trigger }] of Object.entries(panels)) {
    panel.hidden = key !== name;
    trigger.setAttribute('aria-expanded', String(key === name));
  }
  if (name) panels[name].panel.querySelector('.close-panel').focus({ preventScroll: true });
  else if (restoreFocus && previous) panels[previous].trigger.focus({ preventScroll: true });
  showControls();
  frameScene();
}

function showParameterTab(simulation) {
  byId('scene-body-editor').hidden = simulation;
  byId('scene-settings').hidden = !simulation;
  bodyTab.setAttribute('aria-pressed', String(!simulation));
  simulationTab.setAttribute('aria-pressed', String(simulation));
  panels.inspector.panel.querySelector('.panel-content').scrollTop = 0;
}

for (const [name, { panel, trigger }] of Object.entries(panels)) {
  trigger.onclick = () => showPanel(activePanel === name ? undefined : name);
  panel.querySelector('.close-panel').onclick = () => showPanel(undefined, true);
}
bodyTab.onclick = () => showParameterTab(false);
simulationTab.onclick = () => showParameterTab(true);
document.addEventListener('pointerdown', event => {
  if (activePanel !== 'scenarios' && activePanel !== 'view') return;
  const { panel, trigger } = panels[activePanel];
  if (!panel.contains(event.target) && !trigger.contains(event.target)) showPanel();
});

function tdbDate(jd, time = 0) {
  const milliseconds = (jd - UNIX_EPOCH_JD + time * DAYS_PER_UNIT) * SECONDS_PER_DAY * 1000;
  return new Date(Math.round(milliseconds));
}

async function solarSystemScene() {
  const response = await fetch(new URL('./solar-system-start.csv', import.meta.url));
  if (!response.ok) throw Error(`无法加载太阳系星历（HTTP ${response.status}）。`);
  const rows = (await response.text()).trim().split(/\r?\n/).slice(1);
  const names = Object.keys(PLANET_PRESETS);
  if (rows.length !== names.length) throw Error('太阳系星历缺少天体初值。');
  const states = rows.map((row, index) => {
    const [jd, id, ...columns] = row.split(',');
    const [gm, x, y, z, vx, vy, vz] = columns.map(Number);
    if (id !== names[index] || columns.length !== 7 || !positive(gm)) throw Error('太阳系星历初值无效。');
    return { jd: Number(jd), id, gm, position: [x, y, z], velocity: [vx, vy, vz] };
  });
  const epochJdTdb = states[0].jd;
  if (states[0].gm !== SOLAR_GM || states.some(state => state.jd !== epochJdTdb)) {
    throw Error('太阳系星历的历元或太阳引力参数无效。');
  }
  const totalGm = states.reduce((sum, state) => sum + state.gm, 0);
  const center = field => [0, 1, 2].map(axis =>
    states.reduce((sum, state) => sum + state[field][axis] * state.gm, 0) / totalGm);
  const origin = center('position');
  const motion = center('velocity');
  const bodies = states.map(({ id, gm, position, velocity }) => ({
    ...bodyFromPreset({ ...PLANET_PRESETS[id], mass: gm / SOLAR_GM }, position.map((value, axis) => value - origin[axis])),
    velocity: velocity.map((value, axis) => (value - motion[axis]) * DAYS_PER_UNIT),
  }));
  return validate({ dt: 1 / (EPHEMERIS_STEPS_PER_DAY * DAYS_PER_UNIT), end: null, epochJdTdb, bodies });
}

function validate(config) {
  const { dt, end, bodies, epochJdTdb } = config;
  if (!positive(dt)) throw Error('请输入大于零的固定步长。');
  if (end !== null && (!Number.isInteger(end) || end < 1 || end > 0xffffffff || !Number.isFinite(dt * end))) {
    throw Error('请输入有效的总步数，或留空以持续推演。');
  }
  if (epochJdTdb !== undefined && (!Number.isFinite(epochJdTdb) || !Number.isFinite(tdbDate(epochJdTdb).getTime()))) {
    throw Error('太阳系历元无效。');
  }
  if (!Array.isArray(bodies) || !bodies.length) throw Error('请添加至少一颗天体。');
  const centers = new Set();
  const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
  const validated = bodies.map((body, index) => {
    const { name, radius, density, position, velocity, appearance } = body ?? {};
    if (typeof name !== 'string' || !name.trim() || !positive(radius) || !positive(density) ||
        !positive(massOf(radius, density)) || !vector(position) || !vector(velocity)) {
      throw Error(`请检查第 ${index + 1} 颗天体的名称、半径、密度和初值。`);
    }
    if (appearance !== undefined && (typeof appearance !== 'string' || !Object.hasOwn(PLANET_PRESETS, appearance))) {
      throw Error(`第 ${index + 1} 颗天体的外观无效。`);
    }
    const center = position.join(',');
    if (centers.has(center)) throw Error(`「${name}」的初始位置与另一颗天体重合。`);
    centers.add(center);
    return {
      name: name.trim(), radius, density, position: position.map(number), velocity: velocity.map(number),
      ...(appearance ? { appearance } : {}),
    };
  });
  return { dt, end, bodies: validated, ...(epochJdTdb === undefined ? {} : { epochJdTdb }) };
}

function readDraft() {
  const hasEnd = endInput.value !== '' || endInput.validity.badInput;
  return {
    dt: field('dt').valueAsNumber,
    end: hasEnd ? endInput.valueAsNumber : null,
    bodies: draftBodies,
    epochJdTdb: draftEpochJdTdb,
  };
}

function dot(body, index) {
  const marker = document.createElement('span');
  marker.className = 'body-dot';
  marker.style.setProperty('--body-color', '#' + colorAt(body, index).toString(16).padStart(6, '0'));
  marker.setAttribute('aria-hidden', 'true');
  return marker;
}

function showBodyList() {
  bodyList.replaceChildren(...draftBodies.map((body, index) => {
    const button = document.createElement('button');
    const name = document.createElement('span');
    name.textContent = bodyName(body, index);
    button.type = 'button';
    button.className = 'body-option';
    button.append(dot(body, index), name);
    button.onclick = () => {
      selectBody(body);
      const picker = byId('scene-body-picker');
      if (picker.open) {
        picker.open = false;
        picker.querySelector('summary').focus({ preventScroll: true });
      }
      if (view === 'run' && !live.draftBodies.includes(body)) setView('draft');
    };
    return button;
  }));
}

function showSelectedInfo() {
  const index = draftBodies.indexOf(selectedBody);
  const name = bodyName(selectedBody, index);
  bodyList.children[index].lastElementChild.textContent = name;
  byId('scene-body-title').textContent = name;
  removeButton.disabled = false;
  removeButton.setAttribute('aria-label', `删除${name}`);
  const { radius, density } = selectedBody;
  const mass = massOf(radius, density);
  const validMass = positive(radius) && positive(density) && positive(mass);
  byId('scene-mass').textContent = validMass ? mass.toPrecision(6) : '—';
  const physical = byId('scene-physical-units');
  physical.hidden = !selectedBody.appearance || !validMass;
  if (!physical.hidden) {
    const radiusKm = (radius * AU_KM).toLocaleString('zh-CN', { maximumSignificantDigits: 6 });
    const massKg = (mass * SUN_MASS_KG).toExponential(5);
    physical.textContent = `半径 ${radiusKm} km · 质量 ${massKg} kg`;
  }
}

function selectBody(body) {
  selectedBody = body;
  field('name').value = body?.name ?? '';
  const setNumber = (name, value) => { field(name).value = Number.isFinite(value) ? value : ''; };
  setNumber('radius', body?.radius);
  setNumber('density', body?.density);
  POSITION_FIELDS.forEach((name, axis) => setNumber(name, body?.position[axis]));
  VELOCITY_FIELDS.forEach((name, axis) => setNumber(name, body?.velocity[axis]));
  [...bodyList.children].forEach((button, index) => {
    button.setAttribute('aria-pressed', String(draftBodies[index] === body));
  });
  if (body) {
    showSelectedInfo();
  } else {
    removeButton.disabled = true;
    byId('scene-body-title').textContent = '';
    byId('scene-mass').textContent = '';
    byId('scene-physical-units').hidden = true;
    showParameterTab(true);
  }
  showControls();
  drawView();
}

function populate(config, index = 0) {
  field('dt').value = config.dt;
  endInput.value = config.end ?? '';
  draftEpochJdTdb = config.epochJdTdb;
  draftBodies = structuredClone(config.bodies);
  if (draftBodies.length) showParameterTab(false);
  showBodyList();
  selectBody(draftBodies[index]);
}

function markDraft() {
  draftRevision++;
  editorStatus.textContent = draftBodies.length ? '初值已修改，应用后生效。' : '添加天体后应用初值。';
  showControls();
}

form.oninput = event => {
  if (event.target === fileInput) return;
  markDraft();
  if (!selectedBody || !inspector.contains(event.target)) return;
  Object.assign(selectedBody, {
    name: field('name').value,
    radius: field('radius').valueAsNumber,
    density: field('density').valueAsNumber,
    position: POSITION_FIELDS.map(name => field(name).valueAsNumber),
    velocity: VELOCITY_FIELDS.map(name => field(name).valueAsNumber),
  });
  showSelectedInfo();
  setView('draft');
};

removeButton.onclick = () => {
  const index = draftBodies.indexOf(selectedBody);
  if (index < 0) return;
  draftBodies.splice(index, 1);
  showBodyList();
  selectBody(draftBodies[Math.min(index, draftBodies.length - 1)]);
  markDraft();
  setView('draft');
  orbitView?.reset();
};

function reachedEnd(run) {
  return !!run && run.frame.steps === run.config.end;
}

function showControls() {
  const ended = reachedEnd(live);
  const ready = live && !live.error;
  apply.disabled = !draftBodies.length || starting;
  pendingApply.disabled = apply.disabled;
  pendingApply.hidden = !draftBodies.length || activePanel === 'inspector' || draftRevision === appliedRevision;
  panels.library.trigger.disabled = starting;
  panels.inspector.trigger.disabled = starting;
  bodyTab.disabled = !selectedBody;
  systemExample.disabled = starting;
  trisolarisExample.disabled = starting;
  customExperiment.disabled = starting;
  exportButton.disabled = !live;
  restart.disabled = !live || starting;
  play.disabled = !ready || starting || (!live.playing && live.busy);
  const action = live?.playing ? '暂停' : ended ? '继续推演' : '播放';
  if (playLabel.textContent !== action) playLabel.textContent = action;
  play.toggleAttribute('data-playing', !!live?.playing);
  single.disabled = !ready || starting || ended || live.playing || live.busy;
  const waiting = starting ? '正在载入场景…' : draftBodies.length ? '等待应用初值' : '从天体库添加天体';
  if (!live) {
    clock.textContent = waiting;
    stepsLabel.textContent = '';
  }
  const text = live?.error || (ended ? '已到设定步数。' : live?.playing ? '播放中' : live ? '已暂停' : waiting);
  if (runStatus.textContent !== text) runStatus.textContent = text;
  runStatus.toggleAttribute('data-error', !!live?.error);
  draftView.setAttribute('aria-pressed', String(view === 'draft'));
  runView.setAttribute('aria-pressed', String(view === 'run'));
  runView.disabled = !live;
  guides.hidden = view === 'draft';
  guides.setAttribute('aria-pressed', String(runGuides));
  byId('scene-axes').hidden = view === 'run' && !runGuides;
  focusButton.disabled = !orbitView || selectedIndex() < 0;
  moonOrbitButton.hidden = !orbitView || view !== 'run' || !live.trailReferences.some(index => index !== undefined);
}

function selectedIndex() {
  return (view === 'draft' ? draftBodies : live.draftBodies).indexOf(selectedBody);
}

function satelliteTrailReferences(bodies) {
  const earths = bodies.flatMap((body, index) => body.appearance === 'earth' ? [index] : []);
  return bodies.map(moon => {
    if (moon.appearance !== 'moon') return undefined;
    let reference;
    let nearest = Infinity;
    const [x, y, z] = moon.position;
    for (const index of earths) {
      const [earthX, earthY, earthZ] = bodies[index].position;
      const distance = Math.hypot(x - earthX, y - earthY, z - earthZ);
      if (distance < nearest) {
        nearest = distance;
        reference = index;
      }
    }
    return reference;
  });
}

function drawView(resetView = false) {
  if (!orbitView) return;
  try {
    const trails = view === 'draft' ? draftBodies.map((body, index) => {
      const position = bodyDrag?.body === body ? bodyDrag.position ?? body.position : body.position;
      return {
        frames: position.every(Number.isFinite) ? [{ values: position }] : [],
        offset: 0, color: colorAt(body, index), radius: positive(body.radius) ? body.radius : BODY_PRESETS[0].radius,
        selected: body === selectedBody, appearance: body.appearance,
      };
    }) : live.config.bodies.map((body, index) => ({
      frames: live.frames, offset: 1 + 6 * index, color: colorAt(body, index), radius: body.radius,
      selected: live.draftBodies[index] === selectedBody, appearance: body.appearance,
      referenceIndex: live.trailReferences[index],
    }));
    orbitView.setDisplay(true, view === 'draft' || runGuides);
    orbitView.draw(trails);
    if (resetView) orbitView.reset();
  } catch {
    disableView('无法绘制当前轨迹。');
  }
}

function setView(next, { resetCamera = true } = {}) {
  if (next === 'draft' && live) pause(live);
  if (next === 'run') {
    finishBodyDrag();
    armPlacement(null);
  }
  const changed = view !== next;
  view = next;
  showControls();
  drawView(resetCamera && changed && next === 'draft');
  frameScene();
}

function placementMessage(message) {
  placementStatus.textContent = message;
  placementStatus.hidden = !message;
}

function armPlacement(preset, message = '') {
  const wasPlacing = placing !== null;
  placing = preset;
  canvas.toggleAttribute('data-placing', !!preset);
  cancelPlacement.hidden = !preset;
  for (const button of library.children) {
    button.setAttribute('aria-pressed', String(button.dataset.preset === preset?.id));
  }
  if (!preset) {
    if (wasPlacing) orbitView?.previewPlacement(null);
    placementMessage(message);
    return;
  }
  finishBodyDrag();
  setView('draft');
  orbitView?.holdCamera();
  placementMessage(`点击场景放置${preset.name}`);
}

cancelPlacement.onclick = () => {
  armPlacement(null);
  panels.library.trigger.focus({ preventScroll: true });
};

function occupied(position, except) {
  return draftBodies.some(body => body !== except && body.position.every((value, axis) => value === position[axis]));
}

function placeBody(preset, position) {
  const names = new Set(draftBodies.map(body => body.name));
  const base = preset.appearance ? preset.name : '天体';
  let index = preset.appearance ? 2 : draftBodies.length + 1;
  let name = preset.appearance ? base : `${base} ${index++}`;
  while (names.has(name)) name = `${base} ${index++}`;
  const body = bodyFromPreset(preset, position, name);
  draftBodies.push(body);
  armPlacement(null);
  markDraft();
  showBodyList();
  selectBody(body);
  setView('draft');
  showParameterTab(false);
  showPanel('inspector');
}

function placeAt(clientX, clientY) {
  const hit = orbitView?.positionOnPlane(clientX, clientY);
  if (!hit) return '请在可见网格上放置';
  const position = hit.map(value => Number(value.toPrecision(6)));
  if (occupied(position)) return '该位置已有天体';
  placeBody(placing, position);
  return '';
}

function previewPlacement(clientX, clientY) {
  if (!placing || !orbitView) return;
  const position = orbitView.positionOnPlane(clientX, clientY);
  orbitView.previewPlacement(position, placing.radius);
  placementMessage(position ? `x ${position[0].toFixed(2)}  y ${position[1].toFixed(2)}  z 0` : '请在可见网格上放置');
}

for (const [index, preset] of BODY_PRESETS.entries()) {
  const button = document.createElement('button');
  const portrait = document.createElement('span');
  portrait.className = 'catalog-portrait';
  portrait.setAttribute('aria-hidden', 'true');
  portrait.style.setProperty('--portrait-x', `${(index % 4) * 100 / 3}%`);
  portrait.style.setProperty('--portrait-y', `${Math.floor(index / 4) * 50}%`);
  button.type = 'button';
  button.className = 'preset';
  button.dataset.preset = preset.id;
  button.draggable = true;
  button.setAttribute('aria-pressed', 'false');
  button.append(portrait, preset.name);
  button.onclick = () => {
    if (orbitView) {
      armPlacement(placing === preset ? null : preset);
      showPanel();
      canvas.focus({ preventScroll: true });
    } else {
      let x = 0;
      while (occupied([x, 0, 0])) x += 0.5;
      placeBody(preset, [x, 0, 0]);
    }
  };
  button.ondragstart = event => {
    if (!orbitView || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(BODY_DRAG_TYPE, preset.id);
    event.dataTransfer.effectAllowed = 'copy';
    armPlacement(preset);
  };
  button.ondragend = () => {
    if (placing) armPlacement(null);
  };
  library.append(button);
}

canvas.ondragover = event => {
  if (!placing || !event.dataTransfer?.types.includes(BODY_DRAG_TYPE)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  previewPlacement(event.clientX, event.clientY);
};
canvas.ondrop = event => {
  if (!placing || event.dataTransfer?.getData(BODY_DRAG_TYPE) !== placing.id) return;
  event.preventDefault();
  const error = placeAt(event.clientX, event.clientY);
  if (error) armPlacement(null, error);
};
canvas.ondragleave = canvas.onpointerleave = () => {
  if (placing) orbitView?.previewPlacement(null);
};

let pointerStart;
let moved = false;
const movedFrom = event => pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 7;

function draftBodyAt(index) {
  const body = view === 'draft' ? draftBodies[index] : live.draftBodies[index];
  return draftBodies.includes(body) ? body : undefined;
}

function moveBody(event) {
  const drag = bodyDrag;
  if (!drag || !orbitView || starting || !draftBodies.includes(drag.body)) return;
  if (!drag.position) {
    orbitView.holdCamera();
    setView('draft', { resetCamera: false });
    if (activePanel) showPanel();
  }
  const position = orbitView.positionOnPlane(event.clientX + drag.offsetX, event.clientY + drag.offsetY, drag.height);
  if (!position || occupied(position, drag.body)) return;
  drag.position = position;
  if (selectedBody !== drag.body) selectBody(drag.body);
  else drawView();
}

function finishBodyDrag(commit = false) {
  const drag = bodyDrag;
  if (!drag) return;
  bodyDrag = undefined;
  canvas.removeAttribute('data-moving-body');
  orbitView?.setRotationEnabled(true);
  if (!drag.position) return;
  if (commit && draftBodies.includes(drag.body)) {
    drag.body.position = drag.position;
    markDraft();
    selectBody(drag.body);
    showParameterTab(false);
    showPanel('inspector');
  } else {
    drawView();
  }
}

canvas.addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0) {
    moved = true;
    finishBodyDrag();
    return;
  }
  pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
  moved = false;
  if (event.shiftKey || event.ctrlKey || event.metaKey || placing || starting || !orbitView) return;
  const index = orbitView.bodyAt(event.clientX, event.clientY);
  if (index == null) return;
  const body = draftBodyAt(index);
  if (!body || !Number.isFinite(body.position[2])) return;
  const center = orbitView.bodyScreenPosition(index);
  if (!center) return;
  bodyDrag = {
    body, height: body.position[2], offsetX: center[0] - event.clientX, offsetY: center[1] - event.clientY,
  };
  canvas.setAttribute('data-moving-body', '');
  orbitView.setRotationEnabled(false);
}, { capture: true });
canvas.addEventListener('pointermove', event => {
  if (event.pointerId === pointerStart?.id) {
    if (movedFrom(event)) moved = true;
    if (moved) moveBody(event);
  }
  if (event.pointerType !== 'touch' && !event.buttons) previewPlacement(event.clientX, event.clientY);
});
canvas.addEventListener('pointerup', event => {
  if (event.pointerId !== pointerStart?.id || !bodyDrag) return;
  if (moved || movedFrom(event)) {
    moved = true;
    moveBody(event);
  }
  finishBodyDrag(true);
});
canvas.addEventListener('pointercancel', () => {
  moved = true;
  finishBodyDrag();
});
canvas.addEventListener('lostpointercapture', () => {
  if (!bodyDrag) return;
  moved = true;
  finishBodyDrag();
});
canvas.addEventListener('click', event => {
  const wasDrag = moved || movedFrom(event);
  pointerStart = undefined;
  moved = false;
  if (wasDrag) return;
  if (placing) {
    placementMessage(placeAt(event.clientX, event.clientY));
    return;
  }
  const index = orbitView?.bodyAt(event.clientX, event.clientY);
  if (index == null) {
    if (activePanel) showPanel();
    return;
  }
  const body = draftBodyAt(index);
  if (!body) return;
  selectBody(body);
  showParameterTab(false);
  showPanel('inspector');
});
canvas.onkeydown = event => {
  if (!placing || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  placementMessage(placeAt(rect.left + rect.width / 2, rect.top + rect.height / 2));
};
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (bodyDrag) {
    moved = true;
    finishBodyDrag();
  } else if (placing) armPlacement(null);
  else if (activePanel) showPanel(undefined, true);
});

function showLegend(run) {
  legend.replaceChildren(...run.config.bodies.map((body, index) => {
    const li = document.createElement('li');
    li.append(dot(body, index), `${body.name} · 质量 ${run.masses[index].toPrecision(5)}`);
    return li;
  }));
}

function drawRun(run) {
  const { values, steps } = run.frame;
  const stepsText = run.config.end === null ? `${steps} 步 · 持续推演` : `${steps} / ${run.config.end} 步`;
  const date = tdbDate(run.config.epochJdTdb, values[0]);
  const time = Number.isFinite(date.getTime())
    ? `${date.toISOString().slice(0, -5).replace('T', ' ')} TDB`
    : `模拟时刻 ${Number(values[0].toPrecision(8))}`;
  clock.textContent = time;
  stepsLabel.textContent = stepsText;
  if (view === 'run') drawView();
}

function pause(run) {
  run.playing = false;
  clearTimeout(run.timer);
}

function stop(run) {
  pause(run);
  run.worker.close();
}

async function start(settings, {
  restoreDraft = false, bodies = draftBodies.slice(), show = 'draft', focusIndex, title, applyDraft = false,
} = {}) {
  if (starting) return;
  finishBodyDrag();
  const revision = draftRevision;
  starting = true;
  showControls();
  let worker;
  try {
    const config = await settings;
    worker = openWorker(new URL('./scene-worker.js', import.meta.url), 1 + 6 * config.bodies.length);
    const frame = await worker.request({ type: 'init', ...config }, 0);
    if (frame.steps !== 0 || frame.values[0] !== 0 || !Array.isArray(frame.masses) ||
        frame.masses.length !== config.bodies.length || !frame.masses.every(positive)) {
      throw Error('场景初始快照无效。');
    }
    if (live) stop(live);
    armPlacement(null);
    if (restoreDraft) {
      populate(config, focusIndex ?? 0);
      bodies = draftBodies.slice();
      appliedRevision = draftRevision;
    }
    if (applyDraft) appliedRevision = revision;
    live = {
      config, draftBodies: bodies, trailReferences: satelliteTrailReferences(config.bodies),
      worker, frame, masses: frame.masses, frames: [frame], playing: false,
    };
    view = show;
    drawRun(live);
    drawView(true);
    frameScene();
    if (focusIndex !== undefined) orbitView?.focusBody(focusIndex);
    showLegend(live);
    if (title) byId('scene-title').textContent = title;
    if (restoreDraft || (applyDraft && draftRevision === revision)) editorStatus.textContent = '已应用初值。';
    return true;
  } catch (error) {
    worker?.close();
    editorStatus.textContent = error.message;
    return false;
  } finally {
    starting = false;
    showControls();
  }
}

function stepsPerBatch(run) {
  return run.config.epochJdTdb === undefined ? STEPS_PER_FRAME : EPHEMERIS_STEPS_PER_DAY;
}

function schedule(run) {
  const rate = Number(rateSelect.value);
  const normalBatch = stepsPerBatch(run);
  const batch = Math.max(1, Math.round(normalBatch * Math.min(rate, 1)));
  const delay = FRAME_DELAY_MS * batch / (normalBatch * rate);
  clearTimeout(run.timer);
  run.timer = setTimeout(() => {
    if (!run.playing) return;
    const continuing = reachedEnd(run);
    const count = continuing || run.config.end === null ? batch : Math.min(batch, run.config.end - run.frame.steps);
    advance(run, count, continuing);
  }, delay);
}

async function advance(run, count, continueFromEnd = false) {
  if (run !== live || run.busy || run.error) return;
  run.busy = true;
  showControls();
  try {
    const previous = run.frame.steps;
    const type = continueFromEnd ? 'continue' : 'advance';
    const frame = await run.worker.request({ type, count }, run.frame.step + 1);
    if (live !== run) return;
    if (!Number.isSafeInteger(frame.steps) || frame.steps < previous || frame.steps > previous + count ||
        (!frame.fault && frame.steps !== previous + count)) {
      throw Error('Worker 返回的计算步数无效。');
    }
    if (continueFromEnd) {
      if (endInput.valueAsNumber === run.config.end) endInput.value = '';
      run.config = { ...run.config, end: null };
    }
    run.frame = frame;
    if (frame.steps > previous) {
      const earlier = run.frames.at(-2);
      const sampleSteps = stepsPerBatch(run);
      // Keep the newest point attached to the body while sampling the long trail at the normal cadence.
      if (run.playing && count < sampleSteps && earlier && previous - earlier.steps < sampleSteps) {
        run.frames[run.frames.length - 1] = frame;
      } else {
        run.frames.push(frame);
        if (run.frames.length > MAX_TRAIL_SAMPLES) run.frames.shift();
      }
    }
    drawRun(run);
    if (frame.fault) {
      run.error = frame.fault;
      stop(run);
    } else if (reachedEnd(run)) {
      pause(run);
    }
  } catch (error) {
    if (live !== run) return;
    run.error = error.message;
    stop(run);
  } finally {
    if (live === run) {
      run.busy = false;
      showControls();
      if (run.playing) schedule(run);
    }
  }
}

function disableView(message) {
  orbitView = undefined;
  finishBodyDrag();
  armPlacement(null);
  const status = byId('scene-view-status');
  status.hidden = false;
  status.textContent = message;
  byId('scene-library-hint').textContent = '点选后添加，再填写坐标';
  focusButton.disabled = true;
  moonOrbitButton.hidden = true;
}

try {
  orbitView = createOrbitView(canvas, { editable: true });
} catch {
  disableView('此浏览器无法打开三维视图，仍可编辑和推进场景。');
}
canvas.addEventListener('webglcontextlost', () => disableView('三维视图已断开，可重新加载页面。'));
const panelResize = new ResizeObserver(frameScene);
for (const element of [canvas, panels.library.panel, panels.inspector.panel]) panelResize.observe(element);
byId('scene-fit').onclick = () => {
  if (activePanel === 'view') showPanel();
  orbitView?.reset();
};
focusButton.onclick = () => {
  if (activePanel === 'inspector') showPanel(undefined, true);
  orbitView?.focusBody(selectedIndex());
};
moonOrbitButton.onclick = () => {
  const selected = selectedIndex();
  const references = live.trailReferences;
  const center = references[selected] ??
    (references.includes(selected) ? selected : references.find(index => index !== undefined));
  if (center !== undefined) {
    if (activePanel === 'view') showPanel(undefined, true);
    orbitView?.focusBody(center, { orbits: true });
  }
};
guides.onclick = () => {
  runGuides = !runGuides;
  showControls();
  drawView();
};
async function loadPreset(settings, title, focusIndex) {
  runGuides = false;
  fileStatus.textContent = '';
  const loaded = await start(settings, { restoreDraft: true, show: 'run', focusIndex, title });
  if (loaded && activePanel === 'scenarios') showPanel(undefined, true);
  if (!loaded) fileStatus.textContent = editorStatus.textContent;
  return loaded;
}

function openCustomExperiment() {
  if (starting) return;
  finishBodyDrag();
  if (live) stop(live);
  live = undefined;
  view = 'draft';
  runGuides = false;
  armPlacement(null);
  populate({ dt: 1 / 128, end: null, bodies: [] });
  appliedRevision = draftRevision;
  legend.replaceChildren();
  byId('scene-title').textContent = '自定义实验';
  editorStatus.textContent = '添加天体后应用初值。';
  fileStatus.textContent = '';
  showPanel(undefined, true);
  drawView(true);
}

systemExample.onclick = () => loadPreset(solarSystemScene(), '太阳系');
trisolarisExample.onclick = () => loadPreset(validate(trisolarisSettings(PLANET_PRESETS)), '三体星系', 3);
customExperiment.onclick = openCustomExperiment;
draftView.onclick = () => setView('draft');
runView.onclick = () => setView('run');

form.onsubmit = async event => {
  event.preventDefault();
  try {
    if (!await start(validate(readDraft()), { show: 'run', applyDraft: true })) showPanel('inspector');
  } catch (error) {
    editorStatus.textContent = error.message;
    showPanel('inspector');
  }
};

play.onclick = () => {
  if (play.disabled) return;
  setView('run');
  if (live.playing) {
    pause(live);
  } else {
    live.playing = true;
    schedule(live);
  }
  showControls();
};
single.onclick = () => {
  if (single.disabled) return;
  setView('run');
  advance(live, 1);
};
rateSelect.onchange = () => {
  if (live?.playing && !live.busy) schedule(live);
};
restart.onclick = async () => {
  if (restart.disabled) return;
  pause(live);
  if (!await start(live.config, { bodies: live.draftBodies, show: 'run' })) showPanel('inspector');
};

exportButton.onclick = () => {
  if (!live) return;
  downloadExperiment('scene', live.config, 'orbit-lab-scene.json');
  fileStatus.textContent = '已导出当前实验。';
};
importButton.onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileInput.value = '';
  importButton.disabled = true;
  try {
    const config = validate(await readExperiment(file, 'scene'));
    if (starting) throw Error('请等正在载入的场景完成后再导入。');
    if (await start(config, { restoreDraft: true, title: '导入的实验' })) {
      if (activePanel === 'scenarios') showPanel(undefined, true);
    } else {
      fileStatus.textContent = editorStatus.textContent;
    }
  } catch (error) {
    editorStatus.textContent = error.message;
    fileStatus.textContent = error.message;
  } finally {
    importButton.disabled = false;
  }
};

export function currentSceneSnapshot() {
  return live ? { ...live.frame, values: live.frame.values.slice(), masses: live.masses.slice() } : null;
}

if (!await loadPreset(solarSystemScene(), '太阳系', 3)) {
  const error = fileStatus.textContent;
  openCustomExperiment();
  fileStatus.textContent = error;
}
