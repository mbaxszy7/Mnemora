import { eq } from "drizzle-orm";

import { getDb, userSetting } from "../database";
import type { UserSettingRecord } from "../database";
import { getLogger } from "./logger";
import {
  CONTEXT_RULES_MAX_CHARS,
  type CaptureAllowedWindow,
  type CaptureManualOverride,
  type UserSettings,
} from "@shared/user-settings-types";
import type {
  NotificationPreferences,
  NotificationPreferencesRequest,
} from "@shared/notification-types";
import {
  DEFAULT_CAPTURE_ALLOWED_WINDOWS,
  DEFAULT_CAPTURE_ALLOWED_WINDOWS_JSON,
  parseAllowedWindowsJson,
} from "@shared/user-settings-utils";

import { contextRulesStore } from "./context-rules-store";

const logger = getLogger("user-setting-service");

function recordToSettings(record: UserSettingRecord): UserSettings {
  const windows = parseAllowedWindowsJson(record.captureAllowedWindowsJson);
  const settings: UserSettings = {
    capturePrimaryScreenOnly: record.capturePrimaryScreenOnly,
    captureScheduleEnabled: record.captureScheduleEnabled,
    captureAllowedWindows:
      windows.length > 0 ? windows : (DEFAULT_CAPTURE_ALLOWED_WINDOWS as CaptureAllowedWindow[]),
    captureManualOverride: record.captureManualOverride,
    captureManualOverrideUpdatedAt: record.captureManualOverrideUpdatedAt ?? null,

    contextRulesEnabled: record.contextRulesEnabled,
    contextRulesMarkdown: record.contextRulesMarkdown,
    contextRulesUpdatedAt: record.contextRulesUpdatedAt ?? null,
  };

  contextRulesStore.updateFromUserSettings(settings);
  return settings;
}

function recordToNotificationPreferences(record: UserSettingRecord): NotificationPreferences {
  return {
    enabled: record.notificationEnabled,
    activitySummary: record.notificationActivitySummary,
    llmErrors: record.notificationLlmErrors,
    capturePaused: record.notificationCapturePaused,
    soundEnabled: record.notificationSoundEnabled,
    doNotDisturb: record.notificationDoNotDisturb,
    doNotDisturbFrom: record.notificationDoNotDisturbFrom,
    doNotDisturbTo: record.notificationDoNotDisturbTo,
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

        contextRulesEnabled: false,
        contextRulesMarkdown: "",
        contextRulesUpdatedAt: null,

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
    contextRulesEnabled?: boolean;
    contextRulesMarkdown?: string;
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

    const hasAnyContextRulesChange =
      patch.contextRulesEnabled != null || patch.contextRulesMarkdown != null;

    if (patch.contextRulesEnabled != null) {
      next.contextRulesEnabled = patch.contextRulesEnabled;
    }

    if (patch.contextRulesMarkdown != null) {
      if (patch.contextRulesMarkdown.length > CONTEXT_RULES_MAX_CHARS) {
        throw new Error(
          `contextRulesMarkdown exceeds max length (${patch.contextRulesMarkdown.length} > ${CONTEXT_RULES_MAX_CHARS})`
        );
      }
      next.contextRulesMarkdown = patch.contextRulesMarkdown;
    }

    if (hasAnyContextRulesChange) {
      next.contextRulesUpdatedAt = now;
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

  async getNotificationPreferences(): Promise<NotificationPreferences> {
    const record = this.ensureSingletonRecord();
    return recordToNotificationPreferences(record);
  }

  async updateNotificationPreferences(
    patch: NotificationPreferencesRequest["preferences"]
  ): Promise<NotificationPreferences> {
    const db = getDb();
    const existing = this.ensureSingletonRecord();
    const now = Date.now();

    const next: Partial<UserSettingRecord> = {
      updatedAt: now,
    };

    if (patch.enabled != null) next.notificationEnabled = patch.enabled;
    if (patch.activitySummary != null) next.notificationActivitySummary = patch.activitySummary;
    if (patch.llmErrors != null) next.notificationLlmErrors = patch.llmErrors;
    if (patch.capturePaused != null) next.notificationCapturePaused = patch.capturePaused;
    if (patch.soundEnabled != null) next.notificationSoundEnabled = patch.soundEnabled;
    if (patch.doNotDisturb != null) next.notificationDoNotDisturb = patch.doNotDisturb;
    if (patch.doNotDisturbFrom != null) next.notificationDoNotDisturbFrom = patch.doNotDisturbFrom;
    if (patch.doNotDisturbTo != null) next.notificationDoNotDisturbTo = patch.doNotDisturbTo;

    db.update(userSetting).set(next).where(eq(userSetting.id, existing.id)).run();

    const updated = db.select().from(userSetting).where(eq(userSetting.id, existing.id)).get();
    if (!updated) {
      throw new Error("Failed to load updated user_setting");
    }

    return recordToNotificationPreferences(updated);
  }
}

export const userSettingService = UserSettingService.getInstance();
