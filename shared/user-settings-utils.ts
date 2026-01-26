import type { CaptureAllowedWindow, UserSettings } from "./user-settings-types";

export const DEFAULT_CAPTURE_ALLOWED_WINDOWS: CaptureAllowedWindow[] = [
  { start: "10:00", end: "12:00" },
  { start: "14:00", end: "18:00" },
];

export const DEFAULT_CAPTURE_ALLOWED_WINDOWS_JSON = JSON.stringify(DEFAULT_CAPTURE_ALLOWED_WINDOWS);

export function timeStringToMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

export function isTimeWithinAllowedWindows(now: Date, windows: CaptureAllowedWindow[]): boolean {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (const w of windows) {
    const startMinutes = timeStringToMinutes(w.start);
    const endMinutes = timeStringToMinutes(w.end);
    if (startMinutes == null || endMinutes == null) continue;
    if (endMinutes <= startMinutes) continue;
    if (nowMinutes >= startMinutes && nowMinutes <= endMinutes) return true;
  }
  return false;
}

export function parseAllowedWindowsJson(json: string): CaptureAllowedWindow[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const obj = item as Record<string, unknown>;
        const start = typeof obj.start === "string" ? obj.start : null;
        const end = typeof obj.end === "string" ? obj.end : null;
        if (!start || !end) return null;

        const startMinutes = timeStringToMinutes(start);
        const endMinutes = timeStringToMinutes(end);
        if (startMinutes == null || endMinutes == null) return null;
        if (endMinutes <= startMinutes) return null;

        return { start, end };
      })
      .filter((x): x is CaptureAllowedWindow => x != null);
  } catch {
    return [];
  }
}

export function shouldCaptureNow(
  settings: Pick<
    UserSettings,
    "captureScheduleEnabled" | "captureAllowedWindows" | "captureManualOverride"
  >,
  now: Date
): boolean {
  const isAllowedBySchedule = settings.captureScheduleEnabled
    ? isTimeWithinAllowedWindows(now, settings.captureAllowedWindows)
    : true;

  if (settings.captureManualOverride === "force_on") return true;
  if (settings.captureManualOverride === "force_off") return false;
  return isAllowedBySchedule;
}
