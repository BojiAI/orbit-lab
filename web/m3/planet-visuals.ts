import {
  AdditiveBlending, BufferGeometry, Color, DataTexture, DoubleSide, Float32BufferAttribute, Group, LinearFilter, Mesh,
  Points, PointsMaterial, RingGeometry, ShaderMaterial, SphereGeometry, Sprite, SpriteMaterial,
  SRGBColorSpace, Texture, TextureLoader, Vector3, Vector4,
} from 'three';

import { PLANET_PRESETS, type PlanetAppearance } from './planet-presets.js';

const maxSunLights = 3;
type SunSource = Readonly<{ position: Vector3; scale: Vector3 }>;

const globeVertex = `
  varying vec2 surfaceUv;
  varying vec3 viewNormal;
  varying vec3 viewPosition;
  varying vec3 globePosition;
  void main() {
    surfaceUv = uv;
    viewNormal = normalMatrix * normal;
    globePosition = position;
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    viewPosition = -view.xyz;
    gl_Position = projectionMatrix * view;
  }
`;

const solarIllumination = `
  uniform vec4 sunLights[${maxSunLights}];
  uniform int sunCount;
  varying vec3 viewNormal;
  varying vec3 viewPosition;
  varying vec2 surfaceUv;
  vec3 sunDirection(int index) {
    return mat3(viewMatrix) * sunLights[index].xyz;
  }
  vec3 softenHighlights(vec3 color) {
    float peak = max(color.r, max(color.g, color.b));
    if (sunCount < 2 || peak <= 0.8) return color;
    float excess = peak - 0.8;
    float compressed = 0.8 + excess / (1.0 + 5.0 * excess);
    return color * (compressed / peak);
  }
`;

const earthSurface = `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  ${solarIllumination}
  void main() {
    vec3 normal = normalize(viewNormal);
    vec3 eye = normalize(viewPosition);
    float day = 0.0;
    float twilight = 0.0;
    float reflection = 0.0;
    for (int i = 0; i < ${maxSunLights}; ++i) {
      if (i >= sunCount) break;
      vec3 light = sunDirection(i);
      float incidence = dot(normal, light);
      float strength = sunLights[i].w;
      float direct = strength * max(incidence, 0.0);
      day += direct;
      twilight += strength * smoothstep(-0.13, 0.03, incidence);
      reflection += direct * pow(max(dot(reflect(-light, normal), eye), 0.0), 52.0);
    }
    vec3 ground = texture2D(dayMap, surfaceUv).rgb;
    vec3 cities = texture2D(nightMap, surfaceUv).rgb;
    float lights = smoothstep(0.035, 0.41, max(cities.r, max(cities.g, cities.b)));
    float darkness = 1.0 - min(twilight, 1.0);
    float ocean = smoothstep(0.03, 0.14, ground.b - max(ground.g, ground.r));
    vec3 color = ground * (0.018 + 1.3 * pow(day, 0.78));
    color += vec3(0.65, 0.85, 1.0) * reflection * ocean * 0.45;
    color += cities * lights * darkness * 0.43;
    gl_FragColor = vec4(softenHighlights(color), 1.0);
    #include <colorspace_fragment>
  }
`;

const earthClouds = `
  uniform sampler2D cloudMap;
  ${solarIllumination}
  void main() {
    vec3 normal = normalize(viewNormal);
    float day = 0.0;
    float twilight = 0.0;
    for (int i = 0; i < ${maxSunLights}; ++i) {
      if (i >= sunCount) break;
      float incidence = dot(normal, sunDirection(i));
      float strength = sunLights[i].w;
      day += strength * max(incidence, 0.0);
      twilight += strength * smoothstep(-0.06, 0.16, incidence);
    }
    float density = texture2D(cloudMap, surfaceUv).r;
    float cover = smoothstep(0.16, 0.96, density);
    vec3 tint = mix(vec3(0.10, 0.17, 0.26), vec3(0.88, 0.94, 1.0), pow(day, 0.65));
    gl_FragColor = vec4(softenHighlights(tint), cover * min(twilight, 1.0) * 0.92);
    #include <colorspace_fragment>
  }
`;

const earthAtmosphere = `
  ${solarIllumination}
  void main() {
    vec3 normal = normalize(viewNormal);
    float facing = max(dot(normal, normalize(viewPosition)), 0.0);
    float tangentHeight = 1.026 * sqrt(max(1.0 - facing * facing, 0.0)) - 1.0;
    float rim = exp(-max(tangentHeight, 0.0) * 128.0) * pow(1.0 - facing, 3.4);
    float scattering = 0.0;
    for (int i = 0; i < ${maxSunLights}; ++i) {
      if (i >= sunCount) break;
      scattering += sunLights[i].w * smoothstep(-0.20, 0.57, dot(normal, sunDirection(i)));
    }
    gl_FragColor = vec4(0.08, 0.34, 0.78, rim * (0.018 + min(scattering, 1.0) * 0.58));
    #include <colorspace_fragment>
  }
`;

const planetSurface = `
  uniform sampler2D surfaceMap;
  ${solarIllumination}
  void main() {
    vec3 normal = normalize(viewNormal);
    float day = 0.0;
    for (int i = 0; i < ${maxSunLights}; ++i) {
      if (i >= sunCount) break;
      day += sunLights[i].w * max(dot(normal, sunDirection(i)), 0.0);
    }
    vec3 color = texture2D(surfaceMap, surfaceUv).rgb * (0.025 + 1.18 * pow(day, 0.78));
    gl_FragColor = vec4(softenHighlights(color), 1.0);
    #include <colorspace_fragment>
  }
`;

const ringInner = 1.27;
const ringOuter = 2.36;
const saturnRings = `
  uniform sampler2D ringMap;
  varying vec3 globePosition;
  ${solarIllumination}
  void main() {
    float radial = (length(globePosition.xy) - ${ringInner}) / ${ringOuter - ringInner};
    vec4 rings = texture2D(ringMap, vec2(clamp(radial, 0.0, 1.0), 0.5));
    vec3 normal = normalize(viewNormal);
    float exposure = 0.0;
    for (int i = 0; i < ${maxSunLights}; ++i) {
      if (i >= sunCount) break;
      exposure += sunLights[i].w * abs(dot(normal, sunDirection(i)));
    }
    gl_FragColor = vec4(softenHighlights(rings.rgb * (0.26 + sqrt(exposure))), rings.a);
    #include <colorspace_fragment>
  }
`;

const solarSurface = `
  varying vec3 viewNormal;
  varying vec3 viewPosition;
  varying vec3 globePosition;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.23));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise(vec3 p) {
    vec3 cell = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(cell), hash(cell + vec3(1, 0, 0)), f.x),
          mix(hash(cell + vec3(0, 1, 0)), hash(cell + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(cell + vec3(0, 0, 1)), hash(cell + vec3(1, 0, 1)), f.x),
          mix(hash(cell + vec3(0, 1, 1)), hash(cell + vec3(1, 1, 1)), f.x), f.y), f.z);
  }

  void main() {
    vec3 point = normalize(globePosition);
    float convection = noise(point * 68.0) * 0.63 + noise(point * 143.0) * 0.37;
    float structure = noise(point * 7.0 + convection * 0.39);
    float granules = smoothstep(0.18, 0.83, convection * 0.72 + structure * 0.28);
    float facing = max(dot(normalize(viewNormal), normalize(viewPosition)), 0.0);
    vec3 tint = mix(vec3(0.95, 0.19, 0.032), vec3(1.0, 0.86, 0.44), granules);
    tint *= 0.40 + 0.73 * pow(facing, 0.46);
    gl_FragColor = vec4(tint, 1.0);
    #include <colorspace_fragment>
  }
`;

function radialTexture(falloff: (radius: number) => number) {
  const size = 64;
  const data = new Uint8Array(4 * size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = 4 * (y * size + x);
      const radius = Math.hypot(2 * (x + 0.5) / size - 1, 2 * (y + 0.5) / size - 1);
      data.fill(255, offset, offset + 3);
      data[offset + 3] = Math.round(255 * falloff(radius));
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createStarfield() {
  const positions: number[] = [];
  const colors: number[] = [];
  let randomState = 1834921;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  for (let i = 0; i < 4700; i++) {
    const z = random() * 2 - 1;
    const azimuth = random() * Math.PI * 2;
    const radial = Math.sqrt(1 - z * z);
    positions.push(radial * Math.cos(azimuth), radial * Math.sin(azimuth), z);
    const light = 0.018 + Math.pow(random(), 5) * 0.55;
    const temperature = random();
    colors.push(light * (0.74 + 0.26 * temperature), light * 0.88, light * (1 - 0.35 * temperature));
  }
  const geometry = new BufferGeometry()
    .setAttribute('position', new Float32BufferAttribute(positions, 3))
    .setAttribute('color', new Float32BufferAttribute(colors, 3));
  const stars = new Points(geometry, new PointsMaterial({ vertexColors: true, size: 1, sizeAttenuation: false, depthWrite: false }));
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  return stars;
}

export function createPlanetVisuals(redraw: () => void) {
  const globe = new SphereGeometry(1, 64, 40);
  const ring = new RingGeometry(ringInner, ringOuter, 128);
  const starfield = createStarfield();
  const markerMap = radialTexture(radius => Math.min(1, Math.max(0, (1 - radius) * 2.3)));
  const coronaMap = radialTexture(radius => Math.exp(-5.8 * radius) * Math.max(0, 1 - radius));
  const markerGeometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
  const loader = new TextureLoader();
  const previewLight = new Vector3(2, -2, 5).normalize();
  const lightOffset = new Vector3();
  const lightDistances = new Float64Array(maxSunLights);

  type MapUniform = { value: Texture; load: () => void };
  const maps = new Map<string, MapUniform>();
  function textureMap(file: string, fallback: readonly number[], color = true): MapUniform {
    const cached = maps.get(file);
    if (cached) return cached;
    const [r, g, b, alpha = 255] = fallback;
    const placeholder = new DataTexture(new Uint8Array([r, g, b, alpha]), 1, 1);
    placeholder.needsUpdate = true;
    placeholder.colorSpace = color ? SRGBColorSpace : '';
    let requested = false;
    const uniform: MapUniform = {
      value: placeholder,
      load() {
        if (requested) return;
        requested = true;
        loader.load(new URL(`./textures/${file}`, import.meta.url).href, texture => {
          texture.colorSpace = placeholder.colorSpace;
          texture.anisotropy = 4;
          uniform.value = texture;
          placeholder.dispose();
          redraw();
        });
      },
    };
    maps.set(file, uniform);
    return uniform;
  }

  return {
    starfield,
    marker(color: number, size: number) {
      return new Points(markerGeometry, new PointsMaterial({
        color, size, sizeAttenuation: false, map: markerMap, transparent: true, depthWrite: false, alphaTest: 0.05,
      }));
    },
    body(appearance: PlanetAppearance) {
      const group = new Group();
      const lights = Array.from({ length: maxSunLights }, () => new Vector4());
      const primaryLight = lights[0].set(previewLight.x, previewLight.y, previewLight.z, 1);
      const lighting = { sunLights: { value: lights }, sunCount: { value: 1 } };
      const materials: (ShaderMaterial | SpriteMaterial)[] = [];
      const detail: Mesh[] = [];
      const textures: MapUniform[] = [];
      function surface(fragmentShader: string, uniforms = {}, radius = 1) {
        const material = new ShaderMaterial({ vertexShader: globeVertex, fragmentShader, uniforms: { ...lighting, ...uniforms } });
        const mesh = new Mesh(globe, material);
        mesh.scale.setScalar(radius);
        mesh.rotation.x = Math.PI / 2;
        materials.push(material);
        group.add(mesh);
        return mesh;
      }
      if (appearance === 'earth') {
        const dayMap = textureMap('earth-day.jpg', [35, 76, 125]);
        const nightMap = textureMap('earth-night.jpg', [0, 0, 0]);
        const cloudMap = textureMap('earth-clouds.jpg', [0, 0, 0], false);
        textures.push(dayMap, nightMap, cloudMap);
        surface(earthSurface, { dayMap, nightMap });
        const clouds = surface(earthClouds, { cloudMap }, 1.003);
        const atmosphere = surface(earthAtmosphere, {}, 1.026);
        clouds.material.transparent = atmosphere.material.transparent = true;
        clouds.material.depthWrite = atmosphere.material.depthWrite = false;
        atmosphere.material.blending = AdditiveBlending;
        clouds.renderOrder = 2;
        atmosphere.renderOrder = 3;
        detail.push(clouds, atmosphere);
      } else if (appearance === 'sun') {
        surface(solarSurface);
        const material = new SpriteMaterial({
          color: new Color(0xff913f), map: coronaMap, transparent: true, depthWrite: false,
          blending: AdditiveBlending, opacity: 0.85,
        });
        const corona = new Sprite(material);
        corona.scale.setScalar(6.4);
        materials.push(material);
        group.add(corona);
      } else {
        const color = PLANET_PRESETS[appearance].color;
        const surfaceMap = textureMap(`${appearance}.jpg`, [color >> 16, (color >> 8) & 255, color & 255]);
        textures.push(surfaceMap);
        surface(planetSurface, { surfaceMap });
        if (appearance === 'saturn') {
          const ringMap = textureMap('saturn-rings.png', [0, 0, 0, 0]);
          const material = new ShaderMaterial({
            vertexShader: globeVertex, fragmentShader: saturnRings,
            uniforms: { ringMap, ...lighting },
            side: DoubleSide, transparent: true, depthWrite: false,
          });
          textures.push(ringMap);
          materials.push(material);
          group.add(new Mesh(ring, material));
          group.rotation.x = 26.73 * Math.PI / 180;
        } else if (appearance === 'uranus') {
          group.rotation.x = 97.77 * Math.PI / 180;
        }
      }
      return {
        group, primaryLight, outerRadius: appearance === 'saturn' ? ringOuter : 1,
        setLighting(position: Vector3, suns: readonly SunSource[]) {
          let count = 0;
          for (const sun of suns) {
            lightOffset.subVectors(sun.position, position);
            const distance = lightOffset.lengthSq();
            if (distance <= 0 || !Number.isFinite(distance)) continue;
            // Equal luminosities make the closest suns the strongest contributors.
            let slot = Math.min(count, maxSunLights - 1);
            if (slot < count && distance >= lightDistances[slot]) continue;
            while (slot > 0 && distance < lightDistances[slot - 1]) {
              lightDistances[slot] = lightDistances[slot - 1];
              lights[slot].copy(lights[slot - 1]);
              slot--;
            }
            lightDistances[slot] = distance;
            lightOffset.multiplyScalar(1 / Math.sqrt(distance));
            // Keep the established single-sun exposure and use relative irradiance in multi-sun scenes.
            const strength = suns.length === 1 ? 1 : 1 / Math.max(distance, sun.scale.x ** 2, Number.EPSILON);
            lights[slot].set(lightOffset.x, lightOffset.y, lightOffset.z, strength);
            count = Math.min(count + 1, maxSunLights);
          }
          if (!count) primaryLight.set(previewLight.x, previewLight.y, previewLight.z, 1);
          lighting.sunCount.value = Math.max(1, count);
        },
        loadTextures() {
          for (const texture of textures) texture.load();
        },
        setDetailed(enabled: boolean) {
          for (const layer of detail) layer.visible = enabled;
        },
        dispose() {
          for (const material of materials) material.dispose();
        },
      };
    },
  };
}
