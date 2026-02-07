import type { DriveStep } from "driver.js";
import type { TFunction } from "i18next";
import { ONBOARDING_SELECTORS } from "./selectors";

export type ElementExists = (selector: string) => boolean;

const defaultElementExists: ElementExists = (selector) => {
  if (typeof document === "undefined") return false;
  return document.querySelector(selector) != null;
};

function toStep(
  selector: string,
  title: string,
  description: string,
  elementExists: ElementExists
): DriveStep | null {
  if (!elementExists(selector)) return null;
  return {
    element: selector,
    popover: {
      title,
      description,
    },
  };
}

interface BuildHomeStepsOptions {
  t: TFunction;
  showTimelineEmptyState: boolean;
  elementExists?: ElementExists;
}

interface BuildSettingsStepsOptions {
  t: TFunction;
  elementExists?: ElementExists;
}

export function buildHomeOnboardingSteps({
  t,
  showTimelineEmptyState,
  elementExists = defaultElementExists,
}: BuildHomeStepsOptions): DriveStep[] {
  const steps: Array<DriveStep | null> = [
    toStep(
      ONBOARDING_SELECTORS.homeSearch,
      t("onboarding.home.search.title"),
      t("onboarding.home.search.description"),
      elementExists
    ),
    toStep(
      ONBOARDING_SELECTORS.homeSettingsButton,
      t("onboarding.home.settingsButton.title"),
      t("onboarding.home.settingsButton.description"),
      elementExists
    ),
    toStep(
      ONBOARDING_SELECTORS.homeCaptureToggle,
      t("onboarding.home.captureToggle.title"),
      t("onboarding.home.captureToggle.description"),
      elementExists
    ),
  ];

  if (showTimelineEmptyState) {
    steps.push(
      toStep(
        ONBOARDING_SELECTORS.homeEmptyActions,
        t("onboarding.home.emptyActions.title"),
        t("onboarding.home.emptyActions.description"),
        elementExists
      )
    );
  } else {
    steps.push(
      toStep(
        ONBOARDING_SELECTORS.homeTimeline,
        t("onboarding.home.timeline.title"),
        t("onboarding.home.timeline.description"),
        elementExists
      ),
      toStep(
        ONBOARDING_SELECTORS.homeSummary,
        t("onboarding.home.summary.title"),
        t("onboarding.home.summary.description"),
        elementExists
      )
    );
  }

  return steps.filter((step): step is DriveStep => step != null);
}

export function buildSettingsOnboardingSteps({
  t,
  elementExists = defaultElementExists,
}: BuildSettingsStepsOptions): DriveStep[] {
  const steps: Array<DriveStep | null> = [
    toStep(
      ONBOARDING_SELECTORS.settingsLanguage,
      t("onboarding.settings.language.title"),
      t("onboarding.settings.language.description"),
      elementExists
    ),
    toStep(
      ONBOARDING_SELECTORS.settingsPermissions,
      t("onboarding.settings.permissions.title"),
      t("onboarding.settings.permissions.description"),
      elementExists
    ),
    toStep(
      ONBOARDING_SELECTORS.settingsLlmConfig,
      t("onboarding.settings.llmConfig.title"),
      t("onboarding.settings.llmConfig.description"),
      elementExists
    ),
    toStep(
      ONBOARDING_SELECTORS.settingsCaptureSources,
      t("onboarding.settings.captureSources.title"),
      t("onboarding.settings.captureSources.description"),
      elementExists
    ),
    toStep(
      ONBOARDING_SELECTORS.settingsTheme,
      t("onboarding.settings.theme.title"),
      t("onboarding.settings.theme.description"),
      elementExists
    ),
    toStep(
      ONBOARDING_SELECTORS.settingsReplay,
      t("onboarding.settings.replay.title"),
      t("onboarding.settings.replay.description"),
      elementExists
    ),
  ];

  return steps.filter((step): step is DriveStep => step != null);
}
