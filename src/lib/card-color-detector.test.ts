import { classifyCardPixel, rgbToHsv } from "./card-color-detector";

function assertEqual(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assertEqual("#f97316 naranja", classifyCardPixel(...Object.values(rgbToHsv(249, 115, 22)) as [number, number, number]), "naranja");

const o = rgbToHsv(249, 115, 22);
assertEqual("orange-500 class", classifyCardPixel(o.h, o.s, o.v), "naranja");
const y = rgbToHsv(250, 204, 21);
assertEqual("yellow-400 class", classifyCardPixel(y.h, y.s, y.v), "amarillo");
assertEqual("boundary 35", classifyCardPixel(35, 0.85, 0.85), "naranja");
assertEqual("boundary 36", classifyCardPixel(36, 0.85, 0.85), "amarillo");
assertEqual("green B", classifyCardPixel(...(() => {
  const g = rgbToHsv(34, 197, 94);
  return [g.h, g.s, g.v] as [number, number, number];
})()), "verde");
assertEqual("blue C", classifyCardPixel(...(() => {
  const b = rgbToHsv(59, 130, 246);
  return [b.h, b.s, b.v] as [number, number, number];
})()), "azul");
assertEqual("black not location", classifyCardPixel(0, 0, 0.08) === "naranja", false);

console.log("card-color-detector tests ok");
