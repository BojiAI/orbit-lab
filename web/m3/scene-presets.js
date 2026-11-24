const SPHERE_FACTOR = 4 * Math.PI / 3;

export function massOf(radius, density) {
  return (density * radius * radius * radius) * SPHERE_FACTOR;
}

export function bodyFromPreset(preset, position, name = preset.name) {
  const { radius, mass, appearance } = preset;
  return {
    name, radius, density: mass / massOf(radius, 1), position, velocity: [0, 0, 0],
    ...(appearance ? { appearance } : {}),
  };
}

export function trisolarisSettings({ sun, earth }) {
  // Start during the planet's orbit around B, before its first exchange with A.
  const initial = [
    ['太阳 A', { ...sun, mass: 1.1154074, radius: 1.10 * sun.radius },
      [-1.8737937341099, -3.5215356560631, 1.3941592071202], [0.0491621225192, 0.2870956532618, -0.0185718726029]],
    ['太阳 B', { ...sun, mass: 1.1206382, radius: 1.12 * sun.radius },
      [3.0666731188281, -0.709996534012, -0.8600139357642], [0.1830053387973, -0.1664423217997, -0.0643417085664]],
    ['太阳 C', { ...sun, mass: 0.7639544, radius: 0.80 * sun.radius },
      [-1.7626660581933, 6.1830939768998, -0.7739905119005], [-0.3402296962265, -0.1750197343118, 0.1214968259689]],
    ['三体行星', earth,
      [2.9445830463078, -1.8915297201349, 0.8089421901636], [0.467692860283, 0.0345806832916, 0.3149040943283]],
  ];
  const bodies = initial.map(([name, preset, position, velocity]) => ({
    ...bodyFromPreset(preset, position, name), velocity,
  }));
  return { dt: 0.004, end: null, bodies };
}
