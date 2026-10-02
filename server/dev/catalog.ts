// Base catalog shared by the demo seed and the empty project.

export const UNITS = [
  { code: "barra", label: "barras", singular: "barra", plural: "barras" },
  { code: "bolsa", label: "bolsas", singular: "bolsa", plural: "bolsas" },
  { code: "unidad", label: "u", singular: "unidad", plural: "unidades" },
  { code: "kg", label: "kg", singular: "kilogramo", plural: "kilogramos" },
  { code: "m", label: "m", singular: "metro", plural: "metros" },
  { code: "m2", label: "m²", singular: "metro cuadrado", plural: "metros cuadrados" },
  { code: "m3", label: "m³", singular: "metro cúbico", plural: "metros cúbicos" },
  { code: "malla", label: "mallas", singular: "malla", plural: "mallas" },
  { code: "l", label: "l", singular: "litro", plural: "litros" },
];

export const SUPPLIERS = [
  { key: "hierros", name: "Hierros Córdoba", category: "Hierros", contactName: "Raúl Ferreyra", phone: "351 555-0142", aliases: ["la de hierros", "hierros"] },
  { key: "sanitarios", name: "Sanitarios del Centro", category: "Sanitarios", contactName: "Gabriela Paz", phone: "351 555-0187", aliases: ["sanitarios"] },
  { key: "ladrillera", name: "Ladrillera El Algarrobo", category: "Ladrillos", contactName: "Oscar Luna", phone: "3543 55-0911", aliases: ["la ladrillera", "el algarrobo"] },
  { key: "corralon", name: "Corralón San Martín", category: "Áridos y cementos", contactName: "Diego Sosa", phone: "351 555-0320", aliases: ["el corralón", "corralon"] },
  { key: "hormigonera", name: "Hormigonera Sierras", category: "Hormigón", contactName: "Laura Vélez", phone: "351 555-0476", aliases: ["la hormigonera"] },
];

export const MATERIALS = [
  { key: "a12", name: "Acero Ø12", short: "Ø12", unit: "barra", category: "Hierros", spec: "ADN 420 · barra de 12 m", supplier: "hierros", aliases: ["hierro del 12", "barras del 12", "barra del 12", "acero 12 mm", "hierro 12"] },
  { key: "a10", name: "Acero Ø10", short: "Ø10", unit: "barra", category: "Hierros", spec: "ADN 420 · barra de 12 m", supplier: "hierros", aliases: ["hierro del 10", "barras del 10", "barra del 10", "acero 10 mm", "hierro 10"] },
  { key: "a8", name: "Acero Ø8", short: "Ø8", unit: "barra", category: "Hierros", spec: "ADN 420 · barra de 12 m", supplier: "hierros", aliases: ["hierro del 8", "barras del 8", "barra del 8", "acero 8 mm"] },
  { key: "malla", name: "Malla sima Ø4,2", short: "mallas sima", unit: "malla", category: "Hierros", spec: "15 x 15 cm · 2,4 x 6 m", supplier: "hierros", aliases: ["malla sima", "mallas"] },
  { key: "cemento", name: "Cemento portland 50 kg", short: "cemento", unit: "bolsa", category: "Áridos y cementos", spec: null, supplier: "corralon", aliases: ["cemento", "bolsas de cemento"] },
  { key: "cal", name: "Cal hidráulica", short: "cal", unit: "bolsa", category: "Áridos y cementos", spec: "Bolsa de 25 kg", supplier: "corralon", aliases: ["cal"] },
  { key: "arena", name: "Arena gruesa", short: "arena", unit: "m3", category: "Áridos y cementos", spec: null, supplier: "corralon", aliases: ["arena"] },
  { key: "ladrillo", name: "Ladrillo cerámico 18x18x33", short: "ladrillos", unit: "unidad", category: "Ladrillos", spec: "Hueco portante", supplier: "ladrillera", aliases: ["ladrillos huecos", "ladrillo hueco", "ladrillos", "ladrillo del 18"] },
  { key: "hormigon", name: "Hormigón H21", short: "hormigón", unit: "m3", category: "Hormigón", spec: "Elaborado, asentamiento 10 cm", supplier: "hormigonera", aliases: ["hormigon", "hormigón elaborado"] },
  { key: "cano", name: "Caño PVC 110 mm", short: "caños PVC", unit: "unidad", category: "Sanitarios", spec: "Tira de 4 m", supplier: "sanitarios", aliases: ["caños de 110", "caño de 110", "caños pvc"] },
  { key: "codo", name: "Codo PVC 110 mm 90°", short: "codos PVC", unit: "unidad", category: "Sanitarios", spec: null, supplier: "sanitarios", aliases: ["codos de 110", "codo de 110", "codos pvc"] },
];

/** Steel bars: 12 m each; nominal weight per bar (kg) for Ø12/Ø10/Ø8. */
export const CONVERSIONS = [
  { material: "a12", from: "barra", to: "m", num: 12, den: 1 },
  { material: "a12", from: "barra", to: "kg", num: 10656, den: 1000 },
  { material: "a10", from: "barra", to: "m", num: 12, den: 1 },
  { material: "a10", from: "barra", to: "kg", num: 7404, den: 1000 },
  { material: "a8", from: "barra", to: "m", num: 12, den: 1 },
  { material: "a8", from: "barra", to: "kg", num: 4740, den: 1000 },
];
