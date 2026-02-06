import { describe, it, expect } from "vitest";
import {
  timeStringToMinutes,
  isTimeWithinAllowedWindows,
  parseAllowedWindowsJson,
  shouldCaptureNow,
  DEFAULT_CAPTURE_ALLOWED_WINDOWS,
  DEFAULT_CAPTURE_ALLOWED_WINDOWS_JSON,
} from "./user-settings-utils";

describe("timeStringToMinutes", () => {
  it("parses valid HH:MM strings", () => {
    expect(timeStringToMinutes("00:00")).toBe(0);
    expect(timeStringToMinutes("01:30")).toBe(90);
    expect(timeStringToMinutes("12:00")).toBe(720);
    expect(timeStringToMinutes("23:59")).toBe(1439);
  });

  it("returns null for invalid strings", () => {
    expect(timeStringToMinutes("")).toBeNull();
    expect(timeStringToMinutes("25:00")).toBeNull();
    expect(timeStringToMinutes("12:60")).toBeNull();
    expect(timeStringToMinutes("abc")).toBeNull();
    expect(timeStringToMinutes("1:30")).toBeNull();
    expect(timeStringToMinutes("12:5")).toBeNull();
  });
});

describe("isTimeWithinAllowedWindows", () => {
  it("returns true when time is within a window", () => {
    const windows = [{ start: "09:00", end: "17:00" }];
    const noon = new Date("2024-01-01T12:00:00");
    expect(isTimeWithinAllowedWindows(noon, windows)).toBe(true);
  });

  it("returns false when time is outside all windows", () => {
    const windows = [{ start: "09:00", end: "17:00" }];
    const evening = new Date("2024-01-01T20:00:00");
    expect(isTimeWithinAllowedWindows(evening, windows)).toBe(false);
  });

  it("returns true when time equals window start", () => {
    const windows = [{ start: "09:00", end: "17:00" }];
    const start = new Date("2024-01-01T09:00:00");
    expect(isTimeWithinAllowedWindows(start, windows)).toBe(true);
  });

  it("returns true when time equals window end", () => {
    const windows = [{ start: "09:00", end: "17:00" }];
    const end = new Date("2024-01-01T17:00:00");
    expect(isTimeWithinAllowedWindows(end, windows)).toBe(true);
  });

  it("supports multiple windows", () => {
    const windows = [
      { start: "09:00", end: "12:00" },
      { start: "14:00", end: "18:00" },
    ];
    const afternoon = new Date("2024-01-01T15:00:00");
    expect(isTimeWithinAllowedWindows(afternoon, windows)).toBe(true);

    const lunchBreak = new Date("2024-01-01T13:00:00");
    expect(isTimeWithinAllowedWindows(lunchBreak, windows)).toBe(false);
  });

  it("skips windows with invalid time strings", () => {
    const windows = [{ start: "invalid", end: "17:00" }];
    const noon = new Date("2024-01-01T12:00:00");
    expect(isTimeWithinAllowedWindows(noon, windows)).toBe(false);
  });

  it("skips windows where end <= start", () => {
    const windows = [{ start: "17:00", end: "09:00" }];
    const noon = new Date("2024-01-01T12:00:00");
    expect(isTimeWithinAllowedWindows(noon, windows)).toBe(false);
  });

  it("returns false for empty windows array", () => {
    const noon = new Date("2024-01-01T12:00:00");
    expect(isTimeWithinAllowedWindows(noon, [])).toBe(false);
  });
});

describe("parseAllowedWindowsJson", () => {
  it("parses valid JSON array of windows", () => {
    const json = '[{"start":"09:00","end":"17:00"}]';
    const result = parseAllowedWindowsJson(json);
    expect(result).toEqual([{ start: "09:00", end: "17:00" }]);
  });

  it("filters out invalid entries", () => {
    const json =
      '[{"start":"09:00","end":"17:00"},{"start":"invalid","end":"12:00"},{"start":"25:00","end":"26:00"}]';
    const result = parseAllowedWindowsJson(json);
    expect(result).toEqual([{ start: "09:00", end: "17:00" }]);
  });

  it("filters out entries where end <= start", () => {
    const json = '[{"start":"17:00","end":"09:00"}]';
    expect(parseAllowedWindowsJson(json)).toEqual([]);
  });

  it("returns empty for invalid JSON", () => {
    expect(parseAllowedWindowsJson("not json")).toEqual([]);
  });

  it("returns empty for non-array JSON", () => {
    expect(parseAllowedWindowsJson('{"start":"09:00"}')).toEqual([]);
  });

  it("filters entries missing start or end", () => {
    const json = '[{"start":"09:00"},{"end":"17:00"}]';
    expect(parseAllowedWindowsJson(json)).toEqual([]);
  });
});

describe("shouldCaptureNow", () => {
  const noon = new Date("2024-01-01T12:00:00");
  const evening = new Date("2024-01-01T20:00:00");
  const windows = [{ start: "09:00", end: "17:00" }];

  it("returns true when force_on regardless of schedule", () => {
    expect(
      shouldCaptureNow(
        {
          captureScheduleEnabled: true,
          captureAllowedWindows: windows,
          captureManualOverride: "force_on",
        },
        evening
      )
    ).toBe(true);
  });

  it("returns false when force_off regardless of schedule", () => {
    expect(
      shouldCaptureNow(
        {
          captureScheduleEnabled: true,
          captureAllowedWindows: windows,
          captureManualOverride: "force_off",
        },
        noon
      )
    ).toBe(false);
  });

  it("uses schedule when override is none and schedule enabled", () => {
    expect(
      shouldCaptureNow(
        {
          captureScheduleEnabled: true,
          captureAllowedWindows: windows,
          captureManualOverride: "none",
        },
        noon
      )
    ).toBe(true);

    expect(
      shouldCaptureNow(
        {
          captureScheduleEnabled: true,
          captureAllowedWindows: windows,
          captureManualOverride: "none",
        },
        evening
      )
    ).toBe(false);
  });

  it("returns true when schedule disabled and override is none", () => {
    expect(
      shouldCaptureNow(
        {
          captureScheduleEnabled: false,
          captureAllowedWindows: windows,
          captureManualOverride: "none",
        },
        evening
      )
    ).toBe(true);
  });
});

describe("DEFAULT_CAPTURE_ALLOWED_WINDOWS", () => {
  it("has expected default windows", () => {
    expect(DEFAULT_CAPTURE_ALLOWED_WINDOWS).toEqual([
      { start: "10:00", end: "12:00" },
      { start: "14:00", end: "18:00" },
    ]);
  });

  it("DEFAULT_CAPTURE_ALLOWED_WINDOWS_JSON round-trips correctly", () => {
    const parsed = JSON.parse(DEFAULT_CAPTURE_ALLOWED_WINDOWS_JSON);
    expect(parsed).toEqual(DEFAULT_CAPTURE_ALLOWED_WINDOWS);
  });
});
