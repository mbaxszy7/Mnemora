# Screenshot Capture Settings — Design Doc

## Objective

Add two new screenshot-capture related features and expose them in `CaptureSourceSettings.tsx`, with i18n and persistent storage.

- Feature A: **Capture primary screen only** (global option)
- Feature B: **Scheduled capture pause** (time-window based, configurable)

This design prioritizes:

- Minimal disruption to existing capture-source selection flow (screens/apps)
- Correct behavior at app startup (even if the user never opens Settings)
- Reuse of existing start/stop/pause/resume mechanisms
- Centralized logic (avoid scattering gating rules across UI)

## Scope / Constraints

- Settings UI lives in `src/pages/settings/CaptureSourceSettings.tsx`
- Must support i18n (`shared/locales/en.json`, `shared/locales/zh-CN.json`)
- Settings must be persisted in a new DB table (`user_setting`)
- **Time-based behavior decision**: use `pause()` (quick resume) when blocked by schedule
- **Manual start definition**: any user-triggered start from UI, including Tray “Start”, is considered “manual start”
- **Primary screen only** does **not** affect window/app capture mode
- **Primary screen only** is a global configuration:
  - If enabled, it always enforces primary-screen-only for screen capture mode
  - If user never configured it, default behavior at startup should be primary-screen-only

## Current Architecture Summary

### Frontend

- `CaptureSourceSettings.tsx` uses:
  - `useCaptureScreens()` / `useCaptureApps()` to list sources
  - `useCapturePreferences()` to load/update `CapturePreferences` via IPC

### IPC

- `electron/ipc/capture-source-settings-handlers.ts` provides:
  - `CAPTURE_SOURCES_GET_SCREENS`, `CAPTURE_SOURCES_GET_APPS`
  - `CAPTURE_SOURCES_GET_PREFERENCES`, `CAPTURE_SOURCES_SET_PREFERENCES`

### Electron services

- `electron/services/screen-capture/screen-capture-module.ts`
  - orchestrates scheduler, capture task, preferences
  - `tryInitialize()` is called on app startup and from Tray start
  - `executeCaptureTask()` uses `preferencesService.getEffectiveCaptureSources()`
- `CapturePreferencesService` is currently **in-memory** (session-level)

## Feature A — Capture Primary Screen Only

### Behavior

- Applies only when capture mode is **screen capture** (i.e., no selectedApps)
- When enabled:
  - capture task must capture only primary display, regardless of selected screens
- When disabled:
  - behavior remains unchanged (user-selected screens, fallback to all screens)

### Default

- If user has never configured this setting, **default to enabled** (primary-screen-only)

### Implementation Location

- **Enforcement should be done in Electron**, not by mutating UI selections.
- Recommended enforcement point:
  - `ScreenCaptureModule.executeCaptureTask()`
    - when calling `captureService.captureScreens({ selectedScreenIds })`, override `selectedScreenIds` to only the primary display id when enabled.

Rationale:

- Keeps UI selections intact
- Single authoritative enforcement point
- Works regardless of whether Settings page is opened

## Feature B — Scheduled Capture Pause (Allowed Windows)

### User-facing semantics

- User configures “allowed capture windows”, default:
  - 10:00-12:00
  - 14:00-18:00
- If schedule is enabled and **current time is outside allowed windows**:
  - If there is no manual override forcing capture on, capture should be **paused**
- If current time enters allowed windows:
  - If capture was paused due to schedule and no manual override forcing capture off, capture should be allowed to resume/start

### Manual override semantics

Manual override is required to represent “user manually started capture”.

- `force_on`: user explicitly started capture from UI/Tray
- `force_off`: user explicitly stopped capture from UI/Tray
- `none`: follow schedule decisions

### Implementation strategy

Introduce an Electron-side controller that makes a single policy decision:

- `CaptureScheduleController` (new)
  - Ticks periodically (e.g., 30s or 60s)
  - Computes `isAllowedNow` from schedule windows
  - Consults `manualOverride`
  - Calls `screenCaptureModule.pause()` / `screenCaptureModule.tryInitialize()` / `screenCaptureModule.resume()` as needed

**Confirmed decision**: schedule-blocking uses `pause()` (not `stop()`).

### Startup gating

Because capture can start automatically on app startup (`tryInitialize()`), the schedule must gate startup too:

- If schedule is enabled, time is blocked, and `manualOverride !== force_on`:
  - `tryInitialize()` should not start scheduler (returns false)

### Reason tracking

Controller should avoid repeated pause/resume calls:

- Keep an internal `lastDecision` / `lastApplied` state
- Apply actions only when decision changes

## Persistence — DB Table `user_setting`

### Table shape (proposed)

Singleton row.

- `id` integer PK
- `capture_primary_screen_only` boolean not null default 1
  - default enabled to match “never configured → primary-only” requirement
- `capture_schedule_enabled` boolean not null default 1
- `capture_allowed_windows_json` text not null default `[{"start":"10:00","end":"12:00"},{"start":"14:00","end":"18:00"}]`
- `capture_manual_override` text not null default `"none"` (enum-like string)
- `capture_manual_override_updated_at` integer (ms)
- `created_at` / `updated_at` integer

### Electron service

- `UserSettingService` (new)
  - `getSettings()`
  - `updateSettings(partial)`
  - `setCaptureManualOverride(mode)`

## IPC Design

Add a dedicated IPC surface for user settings (do not overload `CapturePreferences`).

### New channels

- `USER_SETTINGS_GET`: fetch user settings
- `USER_SETTINGS_UPDATE`: partial update
- `USER_SETTINGS_SET_CAPTURE_OVERRIDE`: set manual override (`none|force_on|force_off`)

### Preload API

Expose to renderer:

- `window.userSettingsApi.get()`
- `window.userSettingsApi.update(partial)`
- `window.userSettingsApi.setCaptureOverride(mode)`

## Frontend UI (CaptureSourceSettings.tsx)

Add new sections while keeping existing selectors.

### UI controls

- Primary screen only
  - Switch
  - Description clarifying it affects screen capture only
- Schedule
  - Switch enable/disable schedule
  - Time window editor
    - list of windows: each has start/end time input `HH:mm`
    - add/remove window
    - validation: invalid format, overlapping windows (optional), end time must be later than start time

### Data layer

- New hook: `useUserSettings()` (react-query)
  - query: `USER_SETTINGS_GET`
  - mutation: `USER_SETTINGS_UPDATE`

## i18n Keys (to add)

Suggested keys under `captureSourceSettings`:

- `behavior.title`
- `behavior.primaryOnly.label`
- `behavior.primaryOnly.description`
- `schedule.title`
- `schedule.enabled.label`
- `schedule.enabled.description`
- `schedule.allowedWindows.label`
- `schedule.allowedWindows.description`
- `schedule.allowedWindows.add`
- `schedule.allowedWindows.remove`
- `schedule.allowedWindows.start`
- `schedule.allowedWindows.end`
- `schedule.validation.invalidRange`

## Cross-midnight time windows (Not supported)

Definition: a window like `22:00-02:00` spans across midnight.

### Example scenarios

- User wants to block capture during sleep time:
  - allowed windows could be `08:00-22:00`, meaning outside that (22:00-08:00) is blocked
  - equivalently, a blocked window could be `22:00-08:00` (cross-midnight)
- Night-shift / late work schedule:
  - allowed windows could be `22:00-02:00`

### Decision

- **Do not support cross-midnight**
  - UI validation requires `end > start`
  - If user needs `22:00-02:00`, configure two windows:
    - `22:00-23:59`
    - `00:00-02:00`

## Compatibility / Rollback

- Existing capture preferences (screens/apps) continue to work unchanged.
- New settings are additive.
- If schedule controller fails, capture should fall back to current behavior (no unexpected crashes).
- If `user_setting` row is missing/corrupt, service should fall back to defaults.
