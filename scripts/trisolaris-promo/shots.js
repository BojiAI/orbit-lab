import {
  Color, DefaultLoadingManager, Group, Mesh, MeshBasicMaterial,
  PerspectiveCamera, Scene, SphereGeometry, Vector3, WebGLRenderer,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { createPlanetVisuals } from '../../web/m3/planet-visuals.ts';

const W = 1920, H = 1080;
const COLOR = { ink: '#eff5fc', gray: '#adbfd0', cyan: '#93e4ff', muted: '#6d849b', gold: '#ffd6a4' };
const labels = ['太阳 A', '太阳 B', '太阳 C', '三体行星'];
const chartColors = [0xffd6a4, 0xffb96b, 0xf79368, 0x8bd9ff];
const manifest = await (await fetch('./manifest.json')).json();
const { dt, radii, samples, fps, duration } = manifest;
const radians = Math.PI / 180;
const day = 2 * Math.PI / 365.25;
const bDay = 10 + day * Math.round((13.06 - 10) / day);
const brightDay = bDay + day * Math.round((73.08 - bDay) / day);
const siteLat = 31.23, siteLon = 121.47;
const height = new Vector3(0, 0, 1);

const frame = document.createElement('canvas');
frame.width = W;
frame.height = H;
const ctx = frame.getContext('2d', { alpha: false });
const renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setSize(W, H, false);
const scene = new Scene();
scene.background = new Color(0x03070e);
const camera = new PerspectiveCamera(34, W / H, 0.02, 190);
camera.up.copy(height);

const visuals = createPlanetVisuals(() => {});
const sky = visuals.starfield;
sky.scale.setScalar(160);
scene.add(sky);
const earth = visuals.body('earth');
const orbitView = new Group();
scene.add(earth.group, orbitView);
const sunBodies = Array.from({ length: 3 }, () => visuals.body('sun').group);
const planetDot = new Mesh(new SphereGeometry(1, 24, 16), new MeshBasicMaterial({ color: 0x9fe4ff }));
planetDot.scale.setScalar(0.08);
const markers = [...sunBodies, planetDot];
orbitView.add(...markers);

const vertexCount = 93;
const trails = chartColors.map((hex, id) => {
  const geometry = new LineGeometry().setPositions(new Float32Array(vertexCount * 3));
  const shades = new Float32Array(vertexCount * 3);
  const tint = new Color(hex);
  for (let i = 0; i < vertexCount; i++) {
    const intensity = 0.049 + 0.76 * (i / (vertexCount - 1)) ** 1.3;
    shades.set([tint.r * intensity, tint.g * intensity, tint.b * intensity], i * 3);
  }
  geometry.setColors(shades);
  const line = new Line2(geometry, new LineMaterial({
    vertexColors: true, transparent: true, depthWrite: false,
    linewidth: id === 3 ? 4.8 : 2.65, opacity: id === 3 ? 0.96 : 0.58,
  }));
  line.frustumCulled = false;
  orbitView.add(line);
  return line;
});

sunBodies.forEach((sun, id) => sun.scale.setScalar(radii[id] * 42));

function clamp(x, min = 0, max = 1) { return Math.min(max, Math.max(min, x)); }
function smooth(x) { const p = clamp(x); return p * p * (3 - 2 * p); }
function mix(x, y, a) { return x + (y - x) * a; }
function unit(lon, lat) {
  const p = lat * radians, a = lon * radians;
  return new Vector3(Math.cos(p) * Math.cos(a), Math.cos(p) * Math.sin(a), Math.sin(p));
}
function position(t, id) {
  const step = Math.max(0, t / dt), low = Math.floor(step), offset = id * 3;
  const a = samples[low], b = samples[low + 1];
  return new Vector3(...[0, 1, 2].map(i => mix(a[offset + i], b[offset + i], step - low)));
}
function sunlight(t) {
  const origin = position(t, 3);
  return sunBodies.map((_, id) => ({ position: position(t, id).sub(origin), scale: new Vector3(radii[id], radii[id], radii[id]) }));
}
function spin(t) { return (310 - siteLon) * radians + 2 * Math.PI * ((t - bDay) / day % 1); }
function siteNormal(t) { return unit(siteLon, siteLat).applyAxisAngle(height, spin(t)); }
function daylightAt(t) {
  const normal = siteNormal(t);
  return sunlight(t).map(sun => Math.max(0, normal.dot(sun.position)) / sun.position.length() ** 3);
}
function totalLight(strengths) { return strengths.reduce((sum, value) => sum + value, 0); }
const daylight = [bDay, brightDay].map(start => Array.from({ length: 360 }, (_, index) => totalLight(daylightAt(start + day * index / 360))));
const peakLight = Math.max(...daylight.flat());
const lowestA = Math.min(...Array.from({ length: 361 }, (_, index) => {
  const t = brightDay + day * index / 360;
  return Math.asin(clamp(siteNormal(t).dot(sunlight(t)[0].position.normalize()), -1, 1)) / radians;
}));
if (!daylight[0].some(value => value === 0) || Math.min(...daylight[1]) < 0.45 || lowestA < 20) {
  throw Error('The two observing days do not show the proposed contrast');
}

function look(eye, target, centerX, centerY, fov) {
  camera.fov = fov;
  camera.setViewOffset(W, H, W / 2 - centerX, H / 2 - centerY, W, H);
  camera.position.copy(eye);
  camera.lookAt(target);
  sky.position.copy(eye);
}

function screen(point) {
  const p = point.clone().project(camera);
  return [(p.x + 1) * W / 2, (1 - p.y) * H / 2];
}

function text(value, x, y, size, { color = COLOR.ink, weight = 500, spacing = 0, align = 'left', latin = false } = {}) {
  ctx.font = `${weight} ${size}px ${latin ? '"Avenir Next", sans-serif' : '"Hiragino Sans GB", "PingFang SC", sans-serif'}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = `${spacing}px`;
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
  ctx.letterSpacing = '0px';
}

function line(x0, y0, x1, y1, color, width = 1.5) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function circle(x, y, radius, color, stroke) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  if (color) { ctx.fillStyle = color; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
}

function logo(x, y, scale = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.strokeStyle = COLOR.cyan;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.ellipse(20, -12, 25, 10, -0.69, 0, 2 * Math.PI);
  ctx.stroke();
  circle(20, -12, 4.2, COLOR.cyan);
  text('Orbit Lab', 62, 0, 31, { weight: 650, spacing: 0.8, latin: true });
  ctx.restore();
}

function leftShade(opacity = 0.65) {
  const tint = ctx.createLinearGradient(0, 0, 930, 0);
  tint.addColorStop(0, `rgba(3,7,14,${opacity})`);
  tint.addColorStop(0.65, `rgba(3,7,14,${opacity * 0.47})`);
  tint.addColorStop(1, 'rgba(3,7,14,0)');
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, W, H);
}

function drawFrame(exposure = 1) {
  renderer.render(scene, camera);
  if (exposure !== 1) ctx.filter = `brightness(${exposure})`;
  ctx.drawImage(renderer.domElement, 0, 0);
  ctx.filter = 'none';
}

function globe(t, eye, centerX, centerY, distance, exposure) {
  orbitView.visible = false;
  earth.group.visible = true;
  earth.group.rotation.z = spin(t);
  earth.setLighting(earth.group.position, sunlight(t));
  look(eye.clone().multiplyScalar(distance), earth.group.position, centerX, centerY, 36);
  drawFrame(exposure);
}

function introduction(s) {
  const t = 43.02 + 0.003 * s;
  globe(t, unit(11 + 2.1 * s, 33), 1318, 548, mix(3.77, 3.53, s / 5.2));
  leftShade();
  logo(124, 130);
  ctx.save();
  ctx.globalAlpha = smooth((s - 0.34) / 0.78);
  line(128, 373, 201, 373, COLOR.cyan, 3);
  text('三颗太阳下', 125, 485, 80, { weight: 700 });
  text('今晚还会天黑吗？', 125, 588, 78, { weight: 700 });
  text('同一颗行星，两种昼夜。', 129, 681, 32, { color: COLOR.gray });
  ctx.restore();
}

function glow(x, y, id) {
  const tint = id === 3 ? '100,202,255' : ['255,166,71', '255,152,54', '255,100,49'][id];
  const r = id === 3 ? 19 : [53, 54, 36][id];
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
  gradient.addColorStop(0, `rgba(${tint},0.39)`);
  gradient.addColorStop(0.28, `rgba(${tint},0.16)`);
  gradient.addColorStop(1, `rgba(${tint},0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  if (id === 3) circle(x, y, 12, null, '#a8e7ffa0');
}

function overview(s) {
  const t = s < 3.8 ? mix(3.5, 17.5, s / 3.8) : s < 8.2 ? mix(17.5, 39.5, (s - 3.8) / 4.4) : mix(39.5, 44.5, (s - 8.2) / 3.5);
  earth.group.visible = false;
  orbitView.visible = true;
  const target = new Vector3();
  markers.forEach((marker, id) => {
    marker.position.copy(position(t, id));
    target.addScaledVector(marker.position, 0.25);
    const { instanceStart, instanceEnd } = trails[id].geometry.attributes;
    for (let k = 0; k < vertexCount; k++) {
      const p = position(Math.max(0, t - (id === 3 ? 11.1 : 9.7)) + Math.min(t, id === 3 ? 11.1 : 9.7) * k / (vertexCount - 1), id);
      if (k > 0) instanceEnd.setXYZ(k - 1, p.x, p.y, p.z);
      if (k < vertexCount - 1) instanceStart.setXYZ(k, p.x, p.y, p.z);
    }
    instanceStart.data.needsUpdate = true;
  });
  const direction = unit(-59 + 17 * (s / 11.7), 67);
  look(direction.multiplyScalar(22.5).add(target), target, 1245, 568, 32);
  drawFrame();
  leftShade(0.7);
  const anchors = markers.map(marker => screen(marker.position));
  anchors.forEach(([x, y], id) => glow(x, y, id));
  anchors.forEach(([x, y], id) => {
    const up = id !== 0 && id !== 3;
    const nearStar = anchors.slice(0, 3).some(([sx, sy]) => Math.hypot(sx - x, sy - y) < 98);
    const deltaY = up ? -31 : 44 + (id === 3 && nearStar ? 33 : 0);
    const toLeft = x > 1590 || (id === 3 && nearStar);
    const sign = toLeft ? -1 : 1;
    line(x + sign * 13, y + (up ? -7 : 7), x + sign * 34, y + deltaY - 9, id === 3 ? '#94d9fbbd' : '#e1b18cb8');
    text(labels[id], x + sign * 43, y + deltaY, 22, { color: id === 3 ? COLOR.cyan : '#ffe4d2', align: toLeft ? 'right' : 'left', weight: 650 });
  });
  logo(124, 130);
  text('三体星系', 129, 336, 25, { color: COLOR.cyan, weight: 700, spacing: 4 });
  text(t < 17.5 ? '恒纪元' : '乱纪元', 124, 449, 89, { weight: 700 });
  const narration = t < 17.5 ? '行星绕太阳 B 运行' : t < 39.5 ? '行星离开太阳 B' : '太阳 A 捕获行星';
  text(narration, 130, 521, 34, { color: COLOR.gray });
  line(130, 572, 531, 572, '#294860', 1.5);
  const milestones = [[3.5, '绕 B'], [17.5, '换轨'], [39.5, '绕 A']];
  milestones.forEach(([m, caption], i) => {
    const x = [132, 273, 508][i];
    circle(x, 572, 5.2, t >= m ? COLOR.cyan : '#294860');
    text(caption, x, 608, 19, { color: t >= m ? COLOR.gray : COLOR.muted, align: i === 0 ? 'left' : 'center' });
  });
  text('延时推演', 130, 959, 22, { color: COLOR.gray, spacing: 1.6 });
  text(`模拟时刻  ${t.toFixed(1).padStart(4, '0')}    ·    天体尺寸放大`, 130, 998, 22, { color: COLOR.muted });
}

function solarClock(lightByTime, y, phase) {
  const x = 130, width = 502, spacing = width / lightByTime.length;
  for (let i = 0; i < lightByTime.length; i++) {
    const measured = Math.sqrt(clamp(lightByTime[i] / peakLight));
    ctx.fillStyle = `rgb(${Math.round(mix(23, 255, measured))},${Math.round(mix(39, 211, measured))},${Math.round(mix(58, 149, measured))})`;
    ctx.fillRect(x + i * spacing, y, Math.ceil(spacing), 11);
  }
  const p = x + phase * width;
  line(p, y - 10, p, y + 25, COLOR.ink, 2);
  circle(p, y + 5.5, 5, COLOR.ink);
  ['0 h', '12 h', '24 h'].forEach((label, i) => text(label, x + i * width / 2, y + 50, 20, { color: COLOR.gray, align: ['left', 'center', 'right'][i], latin: true }));
}

function surface(s, id) {
  const phase = clamp(s / (id === 0 ? 7.6 : 7.7));
  const start = id === 0 ? bDay : brightDay;
  const t = start + day * phase;
  const theta = spin(t);
  const dir = unit(siteLon + 14, siteLat + 7).applyAxisAngle(height, theta);
  globe(t, dir, 1322, 535, 3.79, 1.21);
  leftShade();
  logo(124, 130);
  text(id === 0 ? '恒纪元  /  绕太阳 B' : '乱纪元  /  后续近遇', 129, 320, 25, { color: COLOR.cyan, weight: 650, spacing: 1.9 });
  text(id === 0 ? '这里会入夜' : '这里一整天都亮着', 125, 420, id === 0 ? 72 : 67, { weight: 700 });
  text(`同一观测点 · 北纬 ${Math.round(siteLat)}°`, 129, 493, 29, { color: COLOR.gray, weight: 500 });
  const strengths = daylightAt(t);
  if (id === 1) {
    text(`太阳 A 全天不落，最低高度约 ${Math.round(lowestA)}°。`, 129, 562, 33, { color: COLOR.ink, weight: 600 });
  }
  const [px, py] = screen(siteNormal(t).multiplyScalar(1.030));
  circle(px, py, 18, '#0612209c', COLOR.cyan);
  circle(px, py, 4.9, COLOR.cyan);
  line(px - 12, py + 13, px - 35, py + 37, COLOR.cyan);
  line(px - 35, py + 37, px - 106, py + 37, COLOR.cyan);
  text('观测点', px - 111, py + 44, 18, { color: COLOR.cyan, align: 'right', weight: 650 });
  text('观测点的直射光强度', 130, 658, 24, { color: COLOR.gray });
  strengths.forEach((strength, i) => {
    const x = 132 + i * 166;
    const tint = `#${chartColors[i].toString(16)}`;
    const measured = clamp(strength / peakLight);
    circle(x + 6, 706, 5.7, strength > 0 ? `${tint}${Math.round(mix(90, 255, measured)).toString(16).padStart(2, '0')}` : '#32506a');
    text(labels[i], x + 24, 714, 22, { color: measured > 0.13 ? COLOR.gold : COLOR.gray, weight: 600 });
    line(x, 738, x + 128, 738, '#17344b', 3);
    if (strength > 0) line(x, 738, x + 128 * measured, 738, tint, 3);
  });
  solarClock(daylight[id], 813, phase);
  text(`模拟时刻 ${start.toFixed(2)}  ·  按 24 小时自转示意`, 130, 992, 21, { color: COLOR.muted });
}

function ending(s) {
  globe(43.17 + 0.003 * s, unit(64 + 1.2 * s, 39), 1430, 813, 2.59);
  leftShade(0.92);
  // A second gradient keeps the credit line legible over the limb.
  const footer = ctx.createLinearGradient(0, 910, 0, H);
  footer.addColorStop(0, '#03070e00');
  footer.addColorStop(1, '#03070ef0');
  ctx.fillStyle = footer;
  ctx.fillRect(0, 910, W, 170);
  logo(124, 410, 3.03);
  text('亲手推演三体星系', 128, 547, 62, { weight: 650 });
  text('在太空实验台选择「三体星系」', 130, 625, 29, { color: COLOR.gray });
  line(130, 911, 216, 911, COLOR.cyan, 2);
  text('图像来源  ·  地表与夜灯 NASA Earth Observatory  ·  云图 Matt Eason / NASA GIBS', 130, 969, 22, { color: COLOR.gray });
}

function render(s) {
  if (s < 5.2) introduction(s);
  else if (s < 16.9) overview(s - 5.2);
  else if (s < 24.5) surface(s - 16.9, 0);
  else if (s < 32.2) surface(s - 24.5, 1);
  else ending(s - 32.2);
  const cut = Math.max(1 - smooth(s / 0.46), smooth((s - 36.48) / 0.52));
  if (cut > 0) {
    ctx.fillStyle = `rgba(2,4,8,${cut})`;
    ctx.fillRect(0, 0, W, H);
  }
}

async function send(s) {
  render(s);
  const blob = await new Promise(resolve => frame.toBlob(resolve, 'image/jpeg', 0.96));
  const response = await fetch('./frame', { method: 'POST', body: blob });
  if (!response.ok) throw Error(`Frame at ${s.toFixed(2)} seconds was rejected`);
}

await new Promise((resolve, reject) => {
  DefaultLoadingManager.onLoad = resolve;
  DefaultLoadingManager.onError = url => reject(Error(`Could not load the planet texture at ${url}`));
  earth.loadTextures();
});
for (let i = 0; i < fps * duration; i++) await send(i / fps);
