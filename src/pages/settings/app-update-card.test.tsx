/* @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppUpdateStatus } from "@shared/app-update-types";
import { AppUpdateCard } from "./AppUpdateCard";

const tMap: Record<string, string> = {
  "settings.updates.title": "App Updates",
  "settings.updates.description": "Check and install the latest stable app version.",
  "settings.updates.currentVersion": "Current version:",
  "settings.updates.availableVersion": "Available version:",
  "settings.updates.channel": "Channel:",
  "settings.updates.channels.stable": "Stable",
  "settings.updates.channels.nightly": "Nightly",
  "settings.updates.statusLabel": "Status:",
  "settings.updates.lastCheckedAt": "Last checked:",
  "settings.updates.never": "Never",
  "settings.updates.actions.checkNow": "Check now",
  "settings.updates.actions.checking": "Checking...",
  "settings.updates.actions.restartToUpdate": "Restart to update",
  "settings.updates.actions.installing": "Installing...",
  "settings.updates.actions.downloadLatest": "Download latest",
  "settings.updates.actions.opening": "Opening...",
  "settings.updates.status.idle": "Idle",
  "settings.updates.status.downloaded": "Ready to install",
  "settings.updates.status.available": "Update available",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => tMap[key] ?? key,
  }),
}));

function createStatus(overrides: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  return {
    channel: "stable",
    phase: "idle",
    currentVersion: "0.0.1",
    availableVersion: null,
    releaseUrl: null,
    platformAction: "none",
    message: null,
    lastCheckedAt: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("AppUpdateCard", () => {
  it("renders default status and check button", () => {
    render(
      <AppUpdateCard
        status={createStatus()}
        isChecking={false}
        isInstalling={false}
        isOpeningDownload={false}
        onCheckNow={() => {}}
        onRestartAndInstall={() => {}}
        onOpenDownload={() => {}}
      />
    );

    expect(screen.getByText("App Updates")).toBeTruthy();
    expect(screen.getByText("0.0.1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check now" })).toBeTruthy();
  });

  it("shows restart action when downloaded", () => {
    render(
      <AppUpdateCard
        status={createStatus({
          phase: "downloaded",
          platformAction: "restart-and-install",
          availableVersion: "0.0.2",
        })}
        isChecking={false}
        isInstalling={false}
        isOpeningDownload={false}
        onCheckNow={() => {}}
        onRestartAndInstall={() => {}}
        onOpenDownload={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: "Restart to update" })).toBeTruthy();
  });

  it("shows download action on mac style status", () => {
    render(
      <AppUpdateCard
        status={createStatus({
          phase: "available",
          platformAction: "open-download-page",
          availableVersion: "0.0.2",
        })}
        isChecking={false}
        isInstalling={false}
        isOpeningDownload={false}
        onCheckNow={() => {}}
        onRestartAndInstall={() => {}}
        onOpenDownload={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: "Download latest" })).toBeTruthy();
  });
});
