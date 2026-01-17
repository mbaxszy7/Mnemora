import { describe, it, expect } from "vitest";

import { __test__ } from "./thread-repository";

describe("thread-repository computeDurationMs", () => {
  it("accumulates only gaps <= threshold", () => {
    const gap = 10 * 60 * 1000;
    const t0 = 1000;
    const t1 = t0 + 5 * 60 * 1000;
    const t2 = t1 + 20 * 60 * 1000;
    const t3 = t2 + 2 * 60 * 1000;

    // duration = (t1-t0) + (t3-t2). The 20min gap is excluded.
    const duration = __test__.computeDurationMs([t0, t1, t2, t3], gap);
    expect(duration).toBe(t1 - t0 + (t3 - t2));
  });
});
