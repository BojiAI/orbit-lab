import {
  AmbientLight, DefaultLoadingManager, DirectionalLight, Mesh, MeshLambertMaterial, PerspectiveCamera,
  Scene, SphereGeometry, Vector3, WebGLRenderer,
} from 'three';
import { PLANET_PRESETS } from './planet-presets.js';
import { createPlanetVisuals } from './planet-visuals.js';

// Render the same meshes and materials used for the scene's close-ups.
async function renderPortraits() {
  const side = 320;
  const atlas = document.createElement('canvas');
  atlas.width = side * 4;
  atlas.height = side * 3;
  const context = atlas.getContext('2d');
  if (!context) throw Error('The portrait canvas needs a 2D context.');

  const renderer = new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(side, side);
  const scene = new Scene();
  const camera = new PerspectiveCamera(43, 1, 0.1, 20);
  camera.up.set(0, 0, 1);
  const viewpoint = new Vector3(2, -3, 1.65).normalize();
  const light = viewpoint.clone().applyAxisAngle(camera.up, -0.85);
  light.z += 0.34;
  light.normalize();
  const lamp = new DirectionalLight(0xffffff, 1.8);
  lamp.position.copy(light);
  scene.add(lamp, new AmbientLight(0xffffff, 0.6));

  const visuals = createPlanetVisuals(() => {});
  const planetModels = Object.values(PLANET_PRESETS).map(({ appearance }) => visuals.body(appearance));
  const loaded = new Promise<void>((resolve, reject) => {
    DefaultLoadingManager.onLoad = resolve;
    DefaultLoadingManager.onError = url => reject(Error(`Could not load ${url}`));
    for (const model of planetModels) model.loadTextures();
  });
  await loaded;

  const basic = new Mesh(new SphereGeometry(1, 64, 40), new MeshLambertMaterial({ color: 0x6783a7 }));
  const models = [{ group: basic, outerRadius: 1 }, ...planetModels];
  for (const [index, { group, outerRadius }] of models.entries()) {
    const model = planetModels[index - 1];
    model?.primaryLight.set(light.x, light.y, light.z, 1);
    model?.setDetailed(true);
    const distance = (index === 1 ? 3.8 : 3.18) * outerRadius;
    camera.position.copy(viewpoint).multiplyScalar(distance);
    camera.lookAt(0, 0, 0);
    scene.add(group);
    renderer.render(scene, camera);
    context.drawImage(renderer.domElement, (index % 4) * side, Math.floor(index / 4) * side);
    scene.remove(group);
  }
  renderer.dispose();
  return new Promise<Blob>((resolve, reject) => {
    atlas.toBlob(blob => {
      if (blob?.type === 'image/webp') resolve(blob);
      else reject(Error('The browser could not encode the portraits as WebP.'));
    }, 'image/webp', 0.94);
  });
}

try {
  const response = await fetch('./portrait-result', { method: 'POST', body: await renderPortraits() });
  if (!response.ok) throw Error('Could not save the portrait atlas.');
} catch (error) {
  await fetch('./portrait-error', { method: 'POST', body: String(error) });
}
