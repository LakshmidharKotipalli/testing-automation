import { describe, expect, it } from "vitest";
import { Semaphore } from "../src/semaphore.js";

describe("Semaphore", () => {
  it("never exceeds its permits, even with racing acquires", async () => {
    const sem = new Semaphore(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        sem.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, (i % 5) * 2));
          active--;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(sem.maxActive).toBe(3);
    expect(sem.inUse).toBe(0);
  });

  it("releases on error", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(sem.run(async () => 1)).resolves.toBe(1);
  });
});
