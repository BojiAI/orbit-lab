export const AU_KM = 149_597_870.7;
export const SUN_MASS_KG = 1.9884e30;

function planet<Id extends string>(id: Id, name: string, radiusKm: number, massKg: number, color: number) {
  return { id, appearance: id, name, radius: radiusKm / AU_KM, mass: massKg / SUN_MASS_KG, color };
}

export const PLANET_PRESETS = {
  sun: planet('sun', '太阳', 695_700, SUN_MASS_KG, 0xffbe75),
  mercury: planet('mercury', '水星', 2439.4, 0.330103e24, 0xc2b9af),
  venus: planet('venus', '金星', 6051.8, 4.86731e24, 0xe8c086),
  earth: planet('earth', '地球', 6371, 5.9722e24, 0x79c8ff),
  mars: planet('mars', '火星', 3389.5, 0.641691e24, 0xe78f6f),
  jupiter: planet('jupiter', '木星', 69_911, 1898.125e24, 0xdca993),
  saturn: planet('saturn', '土星', 58_232, 568.317e24, 0xf0ce98),
  uranus: planet('uranus', '天王星', 25_362, 86.8099e24, 0x8cd8d7),
  neptune: planet('neptune', '海王星', 24_622, 102.4092e24, 0x849cf8),
  moon: planet('moon', '月球', 1737.4, 0.07346e24, 0xb9c6d8),
} as const;

export type PlanetAppearance = keyof typeof PLANET_PRESETS;
