import { describe, expect, it } from "vitest";
import * as monitoring from "./index";

describe("monitoring index exports", () => {
  it("re-exports core services and utilities", () => {
    expect(monitoring.RingBuffer).toBeTypeOf("function");
    expect(monitoring.MetricsCollector).toBeTypeOf("function");
    expect(monitoring.QueueInspector).toBeTypeOf("function");
    expect(monitoring.AIErrorStream).toBeTypeOf("function");
    expect(monitoring.MonitoringServer).toBeTypeOf("function");
    expect(monitoring.metricsCollector).toBeDefined();
    expect(monitoring.queueInspector).toBeDefined();
    expect(monitoring.aiErrorStream).toBeDefined();
    expect(monitoring.monitoringServer).toBeDefined();
    expect(monitoring.activityAlertBuffer).toBeDefined();
  });
});
