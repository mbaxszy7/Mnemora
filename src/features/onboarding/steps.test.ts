import { describe, expect, it } from "vitest";
import {
  buildHomeOnboardingSteps,
  buildSettingsOnboardingSteps,
  type ElementExists,
} from "./steps";

const t = (key: string) => key;

function createElementExists(enabledSelectors: string[]): ElementExists {
  const set = new Set(enabledSelectors);
  return (selector: string) => set.has(selector);
}

describe("onboarding step builders", () => {
  it("builds home empty-state steps", () => {
    const elementExists = createElementExists([
      '[data-tour-id="home-search"]',
      '[data-tour-id="home-settings-button"]',
      '[data-tour-id="home-capture-toggle"]',
      '[data-tour-id="home-empty-actions"]',
    ]);
    const steps = buildHomeOnboardingSteps({ t, showTimelineEmptyState: true, elementExists });
    expect(steps).toHaveLength(4);
    expect(steps[3].element).toBe('[data-tour-id="home-empty-actions"]');
  });

  it("builds home data-state steps", () => {
    const elementExists = createElementExists([
      '[data-tour-id="home-search"]',
      '[data-tour-id="home-settings-button"]',
      '[data-tour-id="home-capture-toggle"]',
      '[data-tour-id="home-timeline"]',
      '[data-tour-id="home-summary"]',
    ]);
    const steps = buildHomeOnboardingSteps({ t, showTimelineEmptyState: false, elementExists });
    expect(steps).toHaveLength(5);
    expect(steps[3].element).toBe('[data-tour-id="home-timeline"]');
    expect(steps[4].element).toBe('[data-tour-id="home-summary"]');
  });

  it("skips missing targets", () => {
    const steps = buildSettingsOnboardingSteps({
      t,
      elementExists: createElementExists(['[data-tour-id="settings-language"]']),
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].element).toBe('[data-tour-id="settings-language"]');
  });
});
