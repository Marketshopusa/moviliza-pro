import { classifyCardPixel, rgbToHsv } from "./card-color-detector";

function assertEqual(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const o = rgbToHsv(249, 115, 22);
assertEqual("orange-500 not scan location", classifyCardPixel(o.h, o.s, o.v), null);
const y = rgbToHsv(250, 204, 21);
assertEqual("yellow-400 class", classifyCardPixel(y.h, y.s, y.v), "amarillo");
assertEqual("boundary 35 not A", classifyCardPixel(35, 0.85, 0.85), null);
assertEqual("boundary 36", classifyCardPixel(36, 0.85, 0.85), "amarillo");
assertEqual("green B", classifyCardPixel(...(() => {
  const g = rgbToHsv(34, 197, 94);
  return [g.h, g.s, g.v] as [number, number, number];
})()), "verde");
assertEqual("blue C", classifyCardPixel(...(() => {
  const b = rgbToHsv(59, 130, 246);
  return [b.h, b.s, b.v] as [number, number, number];
})()), "azul");
assertEqual("black not yellow", classifyCardPixel(0, 0, 0.08) === "amarillo", false);
assertEqual("black is negro", classifyCardPixel(0, 0, 0.08), "negro");

console.log("card-color-detector tests ok");
