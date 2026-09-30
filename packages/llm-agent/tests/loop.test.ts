import { it, expect } from "vitest";
import { LoopGuard } from "../src/index.js";
it("counts canonical tool/args/page repetitions only within the window", () => {
  const loop = new LoopGuard(3, 4);
  expect(loop.check("click", { b: 2, a: 1 }, "page")).toBe(false);
  expect(loop.check("click", { a: 1, b: 2 }, "page")).toBe(false);
  expect(loop.check("click", { a: 1, b: 2 }, "changed")).toBe(false);
  expect(loop.check("click", { a: 1, b: 2 }, "page")).toBe(true);
});
