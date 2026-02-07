import { describe, expect, it } from "vitest";
import {
  resolveHomeProgressOnDone,
  resolveProgressOnTourClose,
  resolveSettingsProgressOnDone,
} from "./progress";

describe("onboarding progress transitions", () => {
  it("marks skip when tour closes", () => {
    expect(resolveProgressOnTourClose()).toBe("skipped");
  });

  it("moves to pending_settings when home tour is done", () => {
    expect(resolveHomeProgressOnDone()).toBe("pending_settings");
  });

  it("marks completed when settings tour is done", () => {
    expect(resolveSettingsProgressOnDone()).toBe("completed");
  });
});
