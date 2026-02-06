import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

let row: Row | undefined;
let nextId = 1;

const mockUpdateFromUserSettings = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

function createDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        get: vi.fn(() => row),
        where: vi.fn(() => ({
          get: vi.fn(() => row),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((payload: Row) => ({
        returning: vi.fn(() => ({
          get: vi.fn(() => {
            row = { id: nextId++, ...payload };
            return row;
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((patch: Row) => ({
        where: vi.fn(() => ({
          run: vi.fn(() => {
            row = { ...(row ?? {}), ...patch };
            return { changes: 1 };
          }),
        })),
      })),
    })),
  };
}

const mockGetDb = vi.hoisted(() => vi.fn(() => createDb()));

vi.mock("../database", () => ({
  getDb: mockGetDb,
  userSetting: { id: "id" },
}));

vi.mock("../logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

vi.mock("./context-rules-store", () => ({
  contextRulesStore: {
    updateFromUserSettings: mockUpdateFromUserSettings,
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
}));

import { UserSettingService } from "./user-setting-service";

describe("UserSettingService", () => {
  let service: UserSettingService;

  beforeEach(() => {
    vi.clearAllMocks();
    row = undefined;
    nextId = 1;
    UserSettingService.resetInstance();
    service = UserSettingService.getInstance();
  });

  it("initializes singleton row when absent", async () => {
    const settings = await service.getSettings();
    expect(settings.capturePrimaryScreenOnly).toBe(true);
    expect(mockUpdateFromUserSettings).toHaveBeenCalled();
  });

  it("updates settings and validates context rules max length", async () => {
    await service.getSettings();

    const updated = await service.updateSettings({
      capturePrimaryScreenOnly: false,
      contextRulesEnabled: true,
      contextRulesMarkdown: "hello",
    });
    expect(updated.capturePrimaryScreenOnly).toBe(false);

    await expect(
      service.updateSettings({
        contextRulesMarkdown: "a".repeat(200_001),
      })
    ).rejects.toThrow("contextRulesMarkdown exceeds max length");
  });

  it("updates and returns notification preferences", async () => {
    await service.getSettings();
    const prefs = await service.updateNotificationPreferences({
      enabled: false,
      soundEnabled: false,
    });
    expect(prefs.enabled).toBe(false);
    expect(prefs.soundEnabled).toBe(false);
  });
});
