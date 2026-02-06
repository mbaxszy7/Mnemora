import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMediaAccessStatus = vi.hoisted(() => vi.fn(() => "granted"));
const mockAccessibility = vi.hoisted(() => vi.fn(() => true));
const mockOpenExternal = vi.hoisted(() => vi.fn(async () => undefined));
const mockGetSources = vi.hoisted(() => vi.fn(async () => []));
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("electron", () => ({
  systemPreferences: {
    getMediaAccessStatus: mockMediaAccessStatus,
    isTrustedAccessibilityClient: mockAccessibility,
  },
  shell: {
    openExternal: mockOpenExternal,
  },
  desktopCapturer: {
    getSources: mockGetSources,
  },
}));

vi.mock("./logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

import { permissionService } from "./permission-service";

describe("permissionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns consistent aggregate permission structure", () => {
    const result = permissionService.checkAllPermissions();
    expect(result).toHaveProperty("screenRecording");
    expect(result).toHaveProperty("accessibility");
  });

  it("non-mac request functions resolve success", async () => {
    await expect(permissionService.requestScreenRecordingPermission()).resolves.toBe(true);
    await expect(permissionService.requestAccessibilityPermission()).resolves.toBe(true);
  });

  it("open preferences is no-op on non-mac", async () => {
    await permissionService.openAccessibilityPreferences();
    await permissionService.openScreenRecordingPreferences();
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });
});
