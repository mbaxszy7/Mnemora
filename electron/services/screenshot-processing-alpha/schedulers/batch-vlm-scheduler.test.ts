import { describe, it, expect } from "vitest";

import { __test__ } from "./batch-vlm-scheduler";

describe("batch-vlm-scheduler parseScreenshotIds", () => {
  it("returns parsed ids", () => {
    const result = __test__.parseScreenshotIds("[1,2,3]", 12);
    expect(result).toEqual([1, 2, 3]);
  });

  it("filters non-numeric values", () => {
    const result = __test__.parseScreenshotIds('[1,"bad",2]', 12);
    expect(result).toEqual([1, 2]);
  });

  it("returns empty array on invalid json", () => {
    const result = __test__.parseScreenshotIds("not-json", 12);
    expect(result).toEqual([]);
  });
});
