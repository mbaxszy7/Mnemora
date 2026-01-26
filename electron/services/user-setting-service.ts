import { eq } from "drizzle-orm";

import { getDb, userSetting } from "../database";
import type { UserSettingRecord } from "../database";
import { getLogger } from "./logger";
import type {
  CaptureAllowedWindow,
  CaptureManualOverride,
  UserSettings,
} from "@shared/user-settings-types";
import {
  DEFAULT_CAPTURE_ALLOWED_WINDOWS,
  DEFAULT_CAPTURE_ALLOWED_WINDOWS_JSON,
  parseAllowedWindowsJson,
} from "@shared/user-settings-utils";

const logger = getLogger("user-setting-service");

function recordToSettings(record: UserSettingRecord): UserSettings {
  const windows = parseAllowedWindowsJson(record.captureAllowedWindowsJson);
  return {
    capturePrimaryScreenOnly: record.capturePrimaryScreenOnly,
    captureScheduleEnabled: record.captureScheduleEnabled,
    captureAllowedWindows:
      windows.length > 0 ? windows : (DEFAULT_CAPTURE_ALLOWED_WINDOWS as CaptureAllowedWindow[]),
    captureManualOverride: record.captureManualOverride,
    captureManualOverrideUpdatedAt: record.captureManualOverrideUpdatedAt ?? null,
  };
}

export class UserSettingService {
  private static instance: UserSettingService | null = null;

  private constructor() {}

  static getInstance(): UserSettingService {
    if (!UserSettingService.instance) {
      UserSettingService.instance = new UserSettingService();
    }
    return UserSettingService.instance;
  }

  static resetInstance(): void {
    UserSettingService.instance = null;
  }

  private ensureSingletonRecord(): UserSettingRecord {
    const db = getDb();
    const existing = db.select().from(userSetting).get();
    if (existing) return existing;

    const now = Date.now();
    const inserted = db
      .insert(userSetting)
      .values({
        capturePrimaryScreenOnly: true,
        captureScheduleEnabled: true,
        captureAllowedWindowsJson: DEFAULT_CAPTURE_ALLOWED_WINDOWS_JSON,
        captureManualOverride: "none",
        captureManualOverrideUpdatedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    if (!inserted) {
      throw new Error("Failed to initialize user_setting");
    }

    logger.info("Initialized user_setting singleton row");
    return inserted;
  }

  async getSettings(): Promise<UserSettings> {
    const record = this.ensureSingletonRecord();
    return recordToSettings(record);
  }

  async updateSettings(patch: {
    capturePrimaryScreenOnly?: boolean;
    captureScheduleEnabled?: boolean;
    captureAllowedWindows?: CaptureAllowedWindow[];
  }): Promise<UserSettings> {
    const db = getDb();
    const existing = this.ensureSingletonRecord();
    const now = Date.now();

    const next: Partial<UserSettingRecord> = {
      updatedAt: now,
    };

    if (patch.capturePrimaryScreenOnly != null) {
      next.capturePrimaryScreenOnly = patch.capturePrimaryScreenOnly;
    }

    if (patch.captureScheduleEnabled != null) {
      next.captureScheduleEnabled = patch.captureScheduleEnabled;
    }

    if (patch.captureAllowedWindows != null) {
      next.captureAllowedWindowsJson = JSON.stringify(patch.captureAllowedWindows);
    }

    db.update(userSetting).set(next).where(eq(userSetting.id, existing.id)).run();

    const updated = db.select().from(userSetting).where(eq(userSetting.id, existing.id)).get();
    if (!updated) {
      throw new Error("Failed to load updated user_setting");
    }

    return recordToSettings(updated);
  }

  async setCaptureManualOverride(mode: CaptureManualOverride): Promise<UserSettings> {
    const db = getDb();
    const existing = this.ensureSingletonRecord();
    const now = Date.now();

    db.update(userSetting)
      .set({
        captureManualOverride: mode,
        captureManualOverrideUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(userSetting.id, existing.id))
      .run();

    const updated = db.select().from(userSetting).where(eq(userSetting.id, existing.id)).get();
    if (!updated) {
      throw new Error("Failed to load updated user_setting");
    }

    return recordToSettings(updated);
  }
}

export const userSettingService = UserSettingService.getInstance();
