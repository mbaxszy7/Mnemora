import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("merges class names and resolves tailwind conflicts", () => {
    expect(cn("p-2", "text-sm", "p-4")).toContain("p-4");
    expect(cn("p-2", "text-sm", "p-4")).not.toContain("p-2");
  });
});
