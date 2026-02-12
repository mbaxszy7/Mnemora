import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@shared/ipc-types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const mockConfigService = vi.hoisted(() => ({
  checkConfiguration: vi.fn(async () => ({ configured: true })),
  validateConfiguration: vi.fn(async () => ({ success: true })),
  saveConfiguration: vi.fn(async () => undefined),
  loadConfiguration: vi.fn(async () => null),
}));
const mockHandleConfigSaved = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./handler-registry", () => ({
  IPCHandlerRegistry: {
    getInstance: vi.fn(() => ({
      registerHandler: vi.fn(
        (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(channel, handler);
        }
      ),
    })),
  },
}));

vi.mock("../services/llm-config-service", () => ({
  LLMConfigService: {
    getInstance: vi.fn(() => mockConfigService),
  },
}));

vi.mock("../services/ai-runtime-service", () => ({
  aiRuntimeService: {
    handleConfigSaved: mockHandleConfigSaved,
  },
}));

vi.mock("../services/logger", () => ({
  getLogger: vi.fn(() => mockLogger),
}));

import { registerLLMConfigHandlers } from "./llm-config-handlers";

describe("registerLLMConfigHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
  });

  it("registers llm config check handler and returns configured status", async () => {
    registerLLMConfigHandlers();
    expect(handlers.has(IPC_CHANNELS.LLM_CONFIG_CHECK)).toBe(true);

    const handler = handlers.get(IPC_CHANNELS.LLM_CONFIG_CHECK);
    const result = (await handler?.({} as never)) as { configured: boolean };

    expect(result.configured).toBe(true);
    expect(mockConfigService.checkConfiguration).toHaveBeenCalledTimes(1);
  });
});
