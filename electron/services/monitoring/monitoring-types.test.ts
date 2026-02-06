import { describe, it, expect } from "vitest";
import { getHealthLevel, HEALTH_THRESHOLDS, DEFAULT_MONITORING_CONFIG } from "./monitoring-types";

describe("getHealthLevel", () => {
  it("returns healthy when value is below warning threshold", () => {
    expect(getHealthLevel(10, { warning: 50, critical: 200 })).toBe("healthy");
    expect(getHealthLevel(0, { warning: 50, critical: 200 })).toBe("healthy");
    expect(getHealthLevel(49, { warning: 50, critical: 200 })).toBe("healthy");
  });

  it("returns warning when value is at or above warning but below critical", () => {
    expect(getHealthLevel(50, { warning: 50, critical: 200 })).toBe("warning");
    expect(getHealthLevel(100, { warning: 50, critical: 200 })).toBe("warning");
    expect(getHealthLevel(199, { warning: 50, critical: 200 })).toBe("warning");
  });

  it("returns critical when value is at or above critical threshold", () => {
    expect(getHealthLevel(200, { warning: 50, critical: 200 })).toBe("critical");
    expect(getHealthLevel(999, { warning: 50, critical: 200 })).toBe("critical");
  });

  it("works with all HEALTH_THRESHOLDS", () => {
    expect(getHealthLevel(0, HEALTH_THRESHOLDS.eventLoopLagMs)).toBe("healthy");
    expect(getHealthLevel(50, HEALTH_THRESHOLDS.eventLoopLagMs)).toBe("warning");
    expect(getHealthLevel(200, HEALTH_THRESHOLDS.eventLoopLagMs)).toBe("critical");

    expect(getHealthLevel(0.5, HEALTH_THRESHOLDS.eventLoopUtilization)).toBe("healthy");
    expect(getHealthLevel(0.7, HEALTH_THRESHOLDS.eventLoopUtilization)).toBe("warning");
    expect(getHealthLevel(0.9, HEALTH_THRESHOLDS.eventLoopUtilization)).toBe("critical");

    expect(getHealthLevel(50, HEALTH_THRESHOLDS.cpuUsagePercent)).toBe("healthy");
    expect(getHealthLevel(70, HEALTH_THRESHOLDS.cpuUsagePercent)).toBe("warning");
    expect(getHealthLevel(90, HEALTH_THRESHOLDS.cpuUsagePercent)).toBe("critical");
  });
});

describe("DEFAULT_MONITORING_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_MONITORING_CONFIG.preferredPort).toBe(23333);
    expect(DEFAULT_MONITORING_CONFIG.metricsIntervalMs).toBe(2000);
    expect(DEFAULT_MONITORING_CONFIG.queueIntervalMs).toBe(5000);
    expect(DEFAULT_MONITORING_CONFIG.bufferSize).toBe(300);
  });
});
