import type { OnboardingProgress } from "@shared/user-settings-types";

export function resolveProgressOnTourClose(): OnboardingProgress {
  return "skipped";
}

export function resolveHomeProgressOnDone(): OnboardingProgress {
  return "pending_settings";
}

export function resolveSettingsProgressOnDone(): OnboardingProgress {
  return "completed";
}
