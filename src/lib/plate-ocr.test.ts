import { parsePlateText } from "./plate-ocr";

function assertEqual(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assertEqual("FL spaced dash", parsePlateText("FL - KR158B"), { plate: "KR158B", state: "FL" });
assertEqual("FL en dash", parsePlateText("FL–KR158B"), { plate: "KR158B", state: "FL" });
assertEqual("FL space", parsePlateText("FL KR158B"), { plate: "KR158B", state: "FL" });
assertEqual("FL hyphen", parsePlateText("FL-KR158B"), { plate: "KR158B", state: "FL" });
assertEqual("plate only", parsePlateText("KR158B"), { plate: "KR158B", state: null });
assertEqual("FLORIDA name", parsePlateText("FLORIDA KR158B"), { plate: "KR158B", state: "FL" });
assertEqual("no false toyota", parsePlateText("TOYOTA COROLLA"), { plate: "", state: null });
assertEqual("no false bmw", parsePlateText("BMW SERIES 2"), { plate: "", state: null });
assertEqual("reject XX code", parsePlateText("XX - KR158B"), { plate: "KR158B", state: null });

console.log("plate-ocr tests ok");
