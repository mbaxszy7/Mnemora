import { describe, it, expect } from "vitest";
import { isValidSourceKey } from "./types";

describe("isValidSourceKey", () => {
  it("returns true for screen: prefixed keys", () => {
    expect(isValidSourceKey("screen:0")).toBe(true);
    expect(isValidSourceKey("screen:main")).toBe(true);
  });

  it("returns true for window: prefixed keys", () => {
    expect(isValidSourceKey("window:vscode")).toBe(true);
    expect(isValidSourceKey("window:123")).toBe(true);
  });

  it("returns false for invalid keys", () => {
    expect(isValidSourceKey("")).toBe(false);
    expect(isValidSourceKey("app:chrome")).toBe(false);
    expect(isValidSourceKey("display:0")).toBe(false);
    expect(isValidSourceKey("Screen:0")).toBe(false);
  });
});
