import {
  AmbientLight, ArrowHelper, Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight, DynamicDrawUsage,
  GridHelper, Group, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera, Plane,
  Raycaster, RingGeometry, Scene, SphereGeometry, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createPlanetVisuals } from './planet-visuals.js';
import { PLANET_PRESETS, type PlanetAppearance } from './planet-presets.js';

export { AU_KM, PLANET_PRESETS, SUN_MASS_KG } from './planet-presets.js';

type Snapshot = Readonly<{ values: readonly number[] }>;
type Position = readonly [number, number, number];
type Trail = Readonly<{
  frames: readonly Snapshot[];
  offset: number;
  color: number;
  radius: number;
  outline?: boolean;
  selected?: boolean;
  appearance?: PlanetAppearance;
  referenceIndex?: number;
}>;

type PlanetVisuals = ReturnType<typeof createPlanetVisuals>;
type PlanetTrack = Readonly<{
  appearance: PlanetAppearance;
  visual: ReturnType<PlanetVisuals['body']>;
  marker: ReturnType<PlanetVisuals['marker']>;
}>;

function markerDiameter(radius: number) {
  // Compress the radius range to keep small bodies visible in an overview.
  return Math.min(18, 4 + 1.65 * Math.log2(1 + radius / PLANET_PRESETS.moon.radius));
}

export function createOrbitView(canvas: HTMLCanvasElement, { editable = false } = {}) {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new Scene();
  const background = new Color(0x101e30);
  scene.background = background;

  const defaultNear = 0.1;
  const defaultMinDistance = 2;
  const radiusClearance = 1.35;
  const camera = new PerspectiveCamera(43, 1, defaultNear, 40);
  camera.up.set(0, 0, 1);
  camera.position.set(3.8, -5.6, 5.8);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(-1.05, -1.08, -0.32);
  controls.enablePan = editable;
  controls.minDistance = defaultMinDistance;
  controls.maxDistance = 18;
  const viewDirection = camera.position.clone().sub(controls.target).normalize();
  controls.update();

  const gridSize = 8;
  const grid = new GridHelper(gridSize, 16, 0x4b6078, 0x293c52);
  grid.rotation.x = Math.PI / 2;
  const zAxis = new Line(
    new BufferGeometry().setFromPoints([new Vector3(0, 0, -1.25), new Vector3(0, 0, 1.25)]),
    new LineBasicMaterial({ color: 0x626f85 }),
  );
  const light = new DirectionalLight(0xffffff, 1.7);
  light.position.set(2, -2, 5);
  const guides = new Group();
  guides.add(grid, zAxis);
  scene.add(guides, light, new AmbientLight(0xffffff, 1.2));

  const sphere = new SphereGeometry(1, 20, 12);
  const planetVisuals = editable ? createPlanetVisuals(render) : undefined;
  const sky = planetVisuals?.starfield;
  const placementMarker = planetVisuals?.marker(0x87d9ff, 10);
  if (sky && placementMarker) {
    sky.visible = placementMarker.visible = false;
    scene.add(sky, placementMarker);
  }
  const selection = editable ? new Mesh(
    new RingGeometry(1.19, 1.23, 48),
    new MeshBasicMaterial({ color: 0xe4f5ff, depthTest: false }),
  ) : undefined;
  const placement = editable ? new Mesh(sphere, new MeshBasicMaterial({
    color: 0x87d9ff, transparent: true, opacity: 0.48, depthWrite: false,
  })) : undefined;
  if (selection && placement) {
    selection.renderOrder = 2;
    selection.visible = placement.visible = false;
    scene.add(selection, placement);
    const origin = new Vector3();
    guides.add(
      new ArrowHelper(new Vector3(1, 0, 0), origin, 1.5, 0xff9c8c, 0.11, 0.065),
      new ArrowHelper(new Vector3(0, 1, 0), origin, 1.5, 0x8eddb5, 0.11, 0.065),
      new ArrowHelper(new Vector3(0, 0, 1), origin, 1.5, 0x8bbfff, 0.11, 0.065),
    );
  }
  function makeTrack() {
    const star = new Mesh(sphere, new MeshLambertMaterial());
    const geometry = new BufferGeometry();
    const trail = new Line(geometry, new LineBasicMaterial());
    trail.frustumCulled = false;
    star.visible = trail.visible = false;
    scene.add(star, trail);
    return {
      star, trail, geometry, planet: undefined as PlanetTrack | undefined, hasTrail: false,
      referenceIndex: undefined as number | undefined, orbitRadius: 0,
    };
  }
  const tracks: ReturnType<typeof makeTrack>[] = [];
  const suns: typeof tracks[number]['star'][] = [];

  function setAppearance(track: typeof tracks[number], appearance: Trail['appearance']) {
    if (track.planet?.appearance === appearance) return;
    if (track.planet) {
      scene.remove(track.planet.visual.group, track.planet.marker);
      track.planet.visual.dispose();
      track.planet.marker.material.dispose();
      track.planet = undefined;
    }
    if (planetVisuals && appearance) {
      const visual = planetVisuals.body(appearance);
      const marker = planetVisuals.marker(PLANET_PRESETS[appearance].color, markerDiameter(track.star.scale.x));
      track.planet = { appearance, visual, marker };
      scene.add(visual.group, marker);
    }
    track.star.material.visible = !track.planet;
  }

  const bounds = new Box3();
  const point = new Vector3();
  const extent = new Vector3();
  const center = new Vector3();
  const cameraOffset = new Vector3();
  const previousFollowPosition = new Vector3();
  const renderedTarget = editable ? new Vector3() : undefined;
  let focus: Position | undefined;
  let followedIndex: number | undefined;
  let followingOrbits = false;
  let selectedRadius = 0;
  let smallestRadius = Infinity;
  let pinchMinDistance: number | undefined;
  let fitTrajectories = true;
  let width = 0, height = 0;
  let insets = { top: 0, right: 0, bottom: 0, left: 0 };

  function pixelRadius(position: Vector3, radius: number) {
    return radius * height * camera.zoom / (2 * Math.tan(camera.fov * Math.PI / 360) * camera.position.distanceTo(position));
  }

  function overviewMinDistance() {
    return editable ? Math.min(defaultMinDistance, radiusClearance * smallestRadius) : defaultMinDistance;
  }

  function frameCamera() {
    const { top, right, bottom, left } = insets;
    const openWidth = Math.max(1, width - left - right);
    const openHeight = Math.max(1, height - top - bottom);
    camera.zoom = Math.min(1, Math.min(openWidth, openHeight) / Math.min(width, height));
    camera.setViewOffset(width, height, (right - left) / 2, (bottom - top) / 2, width, height);
  }

  function render() {
    const nextWidth = canvas.clientWidth, nextHeight = canvas.clientHeight;
    if (canvas.hidden || !nextWidth || !nextHeight) return;
    let resizeScale = 1;
    if (width !== nextWidth || height !== nextHeight) {
      const previousAspect = Math.min(1, camera.aspect);
      width = nextWidth;
      height = nextHeight;
      frameCamera();
      resizeScale = previousAspect / Math.min(1, camera.aspect);
      renderer.setSize(width, height, false);
    }
    const followed = followedIndex === undefined ? undefined : tracks[followedIndex]?.star;
    controls.minDistance = followed?.visible ? radiusClearance * followed.scale.x : pinchMinDistance ?? overviewMinDistance();
    controls.zoomToCursor = editable && !followed?.visible;
    let far = camera.far;
    if (followed?.visible) {
      cameraOffset.subVectors(camera.position, controls.target);
      const distance = Math.max(controls.minDistance, cameraOffset.length() * resizeScale);
      cameraOffset.setLength(distance);
      // Move with the body while preserving any change to the camera target from panning.
      controls.target.add(point.subVectors(followed.position, previousFollowPosition));
      previousFollowPosition.copy(followed.position);
      camera.position.copy(controls.target).add(cameraOffset);
      far = Math.max(far, distance * 3);
    } else if (fitTrajectories) {
      const halfFov = Math.atan(Math.tan(camera.fov * Math.PI / 360) * Math.min(1, camera.aspect));
      bounds.getCenter(center);
      if (focus) controls.target.set(...focus);
      else controls.target.copy(center);
      const radius = bounds.isEmpty() ? gridSize / Math.SQRT2 : Math.max(0.01, 0.5 * bounds.getSize(extent).length() * 1.1);
      const distance = Math.max(controls.minDistance, (radius + controls.target.distanceTo(center)) / Math.sin(halfFov));
      camera.position.copy(controls.target).addScaledVector(viewDirection, distance);
      camera.lookAt(controls.target);
      controls.maxDistance = Math.max(18, distance * 2);
      far = Math.max(40, distance * 3);
    }
    // An AU-scale near plane would clip planetary surfaces when the camera moves in.
    const near = editable || followed?.visible ? Math.min(defaultNear, 0.05 * controls.getDistance()) : defaultNear;
    if (near !== camera.near || far !== camera.far) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    if (sky) {
      sky.position.copy(camera.position);
      sky.scale.setScalar(camera.far * 0.9);
    }
    const closeUpPixels = 23;
    if (selection && selectedRadius > 0) {
      const pixels = pixelRadius(selection.position, selectedRadius);
      selection.visible = pixels < 5 || (guides.visible && pixels <= closeUpPixels);
      selection.scale.setScalar(selectedRadius * Math.max(1, 7 / pixels));
      selection.quaternion.copy(camera.quaternion);
    }
    if (placement && placementMarker) {
      placementMarker.visible = placement.visible && pixelRadius(placement.position, placement.scale.x) < 4;
      placementMarker.position.copy(placement.position);
    }
    if (editable) {
      const close = followed?.visible && pixelRadius(followed.position, followed.scale.x) > closeUpPixels;
      for (const { planet, star, trail, hasTrail, referenceIndex } of tracks) {
        trail.visible = hasTrail && (followingOrbits ? referenceIndex === followedIndex : !close);
        if (!planet) continue;
        const pixels = pixelRadius(star.position, star.scale.x);
        // Wait until the projected globe fills its locator before replacing it.
        const showGlobe = pixels >= Math.max(3, planet.marker.material.size / 2);
        planet.visual.group.visible = star.visible && showGlobe;
        planet.marker.visible = star.visible && !showGlobe;
        if (planet.visual.group.visible) planet.visual.loadTextures();
        planet.visual.setDetailed(pixels > 13);
      }
    }
    renderer.render(scene, camera);
    renderedTarget?.copy(controls.target);
  }
  controls.addEventListener('start', () => { fitTrajectories = false; });
  controls.addEventListener('change', render);
  if (renderedTarget) {
    let panFramePending = false;
    canvas.addEventListener('pointermove', event => {
      if (panFramePending || (!event.buttons && event.pointerType !== 'touch')) return;
      // At planetary close-ups, a visible pan can be below OrbitControls' change threshold.
      panFramePending = true;
      requestAnimationFrame(() => {
        panFramePending = false;
        if (!renderedTarget.equals(controls.target)) render();
      });
    });
  }
  new ResizeObserver(render).observe(canvas);

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const horizontalPlane = new Plane(new Vector3(0, 0, 1), 0);
  function aim(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    raycaster.setFromCamera(pointer.set(2 * x - 1, 1 - 2 * y), camera);
    return rect;
  }

  function nearestBodyCenter(rect: DOMRect) {
    // Keep unresolved bodies usable as a target on touch screens.
    let closest = 14;
    let index: number | null = null;
    tracks.forEach(({ star }, i) => {
      if (!star.visible) return;
      point.copy(star.position).project(camera);
      if (point.z < -1 || point.z > 1) return;
      const distance = Math.hypot((point.x - pointer.x) * rect.width / 2, (point.y - pointer.y) * rect.height / 2);
      if (distance < closest) {
        closest = distance;
        index = i;
      }
    });
    return index;
  }

  function anchorZoom(clientX: number, clientY: number) {
    const rect = aim(clientX, clientY);
    const index = rect ? nearestBodyCenter(rect) : null;
    if (index === null) return;
    const { star } = tracks[index];
    const direction = raycaster.ray.direction;
    cameraOffset.subVectors(star.position, camera.position);
    const distance = cameraOffset.dot(direction);
    // Bring the center onto the sightline and set the dolly distance to its depth.
    // The orbit target stays on the camera axis, keeping the current viewing direction.
    camera.position.add(cameraOffset.addScaledVector(direction, -distance));
    camera.getWorldDirection(cameraOffset);
    controls.target.copy(camera.position).addScaledVector(cameraOffset, distance);
    return radiusClearance * star.scale.x;
  }

  if (editable) {
    canvas.addEventListener('wheel', event => {
      if (controls.zoomToCursor && event.deltaY < 0 && !event.buttons) {
        controls.minDistance = anchorZoom(event.clientX, event.clientY) ?? overviewMinDistance();
      }
    }, { capture: true, passive: true });

    const touches = new Map<number, Vector2>();
    canvas.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch') return;
      touches.set(event.pointerId, new Vector2(event.clientX, event.clientY));
      if (!controls.zoomToCursor || touches.size !== 2) return;
      const [first, second] = touches.values();
      pinchMinDistance = anchorZoom((first.x + second.x) / 2, (first.y + second.y) / 2);
      controls.minDistance = pinchMinDistance ?? overviewMinDistance();
    }, true);
    canvas.addEventListener('pointermove', event => {
      touches.get(event.pointerId)?.set(event.clientX, event.clientY);
    });
    const endTouch = (event: PointerEvent) => {
      if (!touches.delete(event.pointerId) || touches.size >= 2 || pinchMinDistance === undefined) return;
      pinchMinDistance = undefined;
      if (controls.zoomToCursor) controls.minDistance = overviewMinDistance();
    };
    canvas.addEventListener('pointerup', endTouch);
    canvas.addEventListener('pointercancel', endTouch);
    canvas.addEventListener('lostpointercapture', endTouch);
  }

  return {
    draw(trails: readonly Trail[], target?: Position) {
      focus = target;
      if (target && !fitTrajectories) {
        cameraOffset.copy(camera.position).sub(controls.target);
        controls.target.set(...target);
        camera.position.copy(controls.target).add(cameraOffset);
        camera.lookAt(controls.target);
      }
      while (tracks.length < trails.length) tracks.push(makeTrack());
      for (const track of tracks.splice(trails.length)) {
        setAppearance(track, undefined);
        const { star, trail, geometry } = track;
        scene.remove(star, trail);
        star.material.dispose();
        trail.material.dispose();
        geometry.dispose();
      }
      bounds.makeEmpty();
      suns.length = 0;
      selectedRadius = 0;
      smallestRadius = Infinity;
      if (selection) selection.visible = false;
      tracks.forEach((track, index) => {
        const { star, trail, geometry } = track;
        const { frames, offset, color, radius, outline, selected, appearance, referenceIndex } = trails[index];
        if (star.scale.x !== radius) {
          star.scale.setScalar(radius);
          if (track.planet) track.planet.marker.material.size = markerDiameter(radius);
        }
        setAppearance(track, appearance);
        const last = frames[frames.length - 1];
        star.visible = !!last;
        trail.visible = track.hasTrail = frames.length > 1;
        track.referenceIndex = referenceIndex;
        track.orbitRadius = 0;
        if (!last) return;

        smallestRadius = Math.min(smallestRadius, radius);
        star.material.color.setHex(color);
        star.material.wireframe = outline ?? false;
        trail.material.color.setHex(color);
        star.position.set(last.values[offset], last.values[offset + 1], last.values[offset + 2]);
        if (track.planet) {
          if (track.planet.appearance === 'sun') suns.push(star);
          track.planet.visual.group.position.copy(star.position);
          track.planet.visual.group.scale.setScalar(radius);
          track.planet.marker.position.copy(star.position);
        }
        if (selection && selected) {
          selectedRadius = radius;
          selection.position.copy(star.position);
        }
        let positions = geometry.getAttribute('position');
        if (!positions || positions.count < frames.length) {
          geometry.dispose();
          const capacity = Math.max(32, frames.length, 2 * (positions?.count ?? 0));
          positions = new BufferAttribute(new Float32Array(3 * capacity), 3).setUsage(DynamicDrawUsage);
          geometry.setAttribute('position', positions);
        }
        const reference = referenceIndex === undefined ? undefined : trails[referenceIndex]?.offset;
        // Translate the relative orbit to the reference body's latest position.
        trail.position.set(0, 0, 0);
        if (reference !== undefined) trail.position.fromArray(last.values, reference);
        let farthestSquared = 0;
        frames.forEach(({ values }, i) => {
          point.set(values[offset], values[offset + 1], values[offset + 2]);
          if (reference !== undefined) {
            point.x -= values[reference];
            point.y -= values[reference + 1];
            point.z -= values[reference + 2];
            farthestSquared = Math.max(farthestSquared, point.lengthSq());
          }
          positions.setXYZ(i, point.x, point.y, point.z);
          if (reference !== undefined) point.add(trail.position);
          bounds.expandByPoint(point);
        });
        if (reference !== undefined) track.orbitRadius = Math.sqrt(farthestSquared) + radius;
        point.copy(star.position).addScalar(radius);
        bounds.expandByPoint(point);
        point.copy(star.position).addScalar(-radius);
        bounds.expandByPoint(point);
        positions.needsUpdate = true;
        geometry.setDrawRange(0, frames.length);
      });
      for (const { planet, star } of tracks) {
        if (planet && planet.appearance !== 'sun' && star.visible) {
          planet.visual.setLighting(star.position, suns);
        }
      }
      render();
    },
    setDisplay(space: boolean, showGuides: boolean) {
      background.setHex(space ? 0x03060e : 0x101e30);
      guides.visible = showGuides;
      if (sky) sky.visible = space;
    },
    setViewportInsets({ top = 0, right = 0, bottom = 0, left = 0 } = {}) {
      if (top === insets.top && right === insets.right && bottom === insets.bottom && left === insets.left) return;
      insets = { top, right, bottom, left };
      if (width && height) frameCamera();
      render();
    },
    focusBody(index: number, { orbits = false } = {}) {
      const track = tracks[index];
      if (!track?.star.visible) return;
      const { star, planet } = track;
      const radius = star.scale.x;
      followedIndex = index;
      previousFollowPosition.copy(star.position);
      followingOrbits = orbits;
      fitTrajectories = false;
      controls.minDistance = radiusClearance * radius;
      controls.maxDistance = Math.max(18, controls.maxDistance, 10 * radius);
      let fitRadius = radius * (planet?.visual.outerRadius ?? 1);
      if (orbits) {
        for (const satellite of tracks) {
          if (satellite.referenceIndex === index && satellite.star.visible) {
            fitRadius = Math.max(fitRadius, satellite.orbitRadius);
          }
        }
      }
      const distance = 3.8 * fitRadius / Math.min(1, camera.aspect);
      cameraOffset.copy(viewDirection);
      if (!orbits && planet && planet.appearance !== 'sun') {
        const sunlight = planet.visual.primaryLight;
        cameraOffset.crossVectors(sunlight, camera.up).normalize().multiplyScalar(0.66);
        cameraOffset.addScaledVector(sunlight, 0.52).addScaledVector(camera.up, 0.41).normalize();
      }
      controls.target.copy(star.position);
      camera.position.copy(controls.target).addScaledVector(cameraOffset, distance);
      camera.lookAt(controls.target);
      controls.update();
      render();
    },
    bodyAt(clientX: number, clientY: number) {
      const rect = aim(clientX, clientY);
      if (!rect) return null;
      const visible = tracks.filter(({ star }) => star.visible);
      const [hit] = raycaster.intersectObjects(visible.map(({ star }) => star), false);
      if (hit) return tracks.findIndex(({ star }) => star === hit.object);
      return nearestBodyCenter(rect);
    },
    bodyScreenPosition(index: number): readonly [number, number] | null {
      const star = tracks[index]?.star;
      if (!star?.visible) return null;
      const rect = canvas.getBoundingClientRect();
      point.copy(star.position).project(camera);
      return [rect.left + (point.x + 1) * rect.width / 2, rect.top + (1 - point.y) * rect.height / 2];
    },
    positionOnPlane(clientX: number, clientY: number, height = 0): Position | null {
      if (!Number.isFinite(height) || !aim(clientX, clientY) || Math.abs(raycaster.ray.direction.z) < 1e-8) return null;
      horizontalPlane.constant = -height;
      const hit = raycaster.ray.intersectPlane(horizontalPlane, point);
      if (!hit) return null;
      const position: Position = [hit.x, hit.y, height];
      point.project(camera);
      return Math.abs(point.z) <= 1 ? position : null;
    },
    previewPlacement(position: Position | null, radius = 1) {
      if (!placement) return;
      placement.visible = position !== null;
      if (position) {
        placement.position.set(...position);
        placement.scale.setScalar(radius);
      }
      render();
    },
    holdCamera() {
      followedIndex = undefined;
      followingOrbits = false;
      fitTrajectories = false;
    },
    setRotationEnabled(enabled: boolean) {
      controls.enableRotate = enabled;
    },
    reset() {
      followedIndex = undefined;
      followingOrbits = false;
      pinchMinDistance = undefined;
      fitTrajectories = true;
      render();
    },
  };
}

export function createFlybyView(canvas: HTMLCanvasElement) {
  const view = createOrbitView(canvas);
  const colors = [0xffba70, 0x62cdea, 0x8be5ad];
  return {
    draw(frames: readonly Snapshot[]) {
      view.draw(colors.map((color, body) => ({ frames, color, offset: 1 + 6 * body, radius: body === 0 ? 0.09 : 0.07 })));
    },
    reset: view.reset,
  };
}
