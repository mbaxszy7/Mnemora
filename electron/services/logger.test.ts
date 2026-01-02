import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock electron app module
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
  },
}));

// Mock pino and pino-pretty
vi.mock("pino", () => {
  const mockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => mockLogger),
  };

  const pino = vi.fn(() => mockLogger) as unknown as {
    (...args: unknown[]): typeof mockLogger;
    multistream: (...args: unknown[]) => unknown;
    stdTimeFunctions: {
      isoTime: (...args: unknown[]) => unknown;
    };
  };

  pino.multistream = vi.fn(() => ({}));
  pino.stdTimeFunctions = { isoTime: vi.fn() };

  return { default: pino };
});

vi.mock("pino-pretty", () => ({
  default: vi.fn(() => ({})),
}));

// Mock fs module
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

describe("LoggerService", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should export initializeLogger function", async () => {
    const { initializeLogger } = await import("./logger");
    expect(typeof initializeLogger).toBe("function");
  });

  it("should export getLogger function", async () => {
    const { getLogger } = await import("./logger");
    expect(typeof getLogger).toBe("function");
  });

  it("initializeLogger should return a logger instance", async () => {
    const { initializeLogger } = await import("./logger");
    const logger = initializeLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
  });

  it("getLogger should return a logger instance", async () => {
    const { getLogger, initializeLogger } = await import("./logger");
    initializeLogger();
    const logger = getLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
  });

  it("getLogger with name should return a child logger", async () => {
    const { getLogger, initializeLogger } = await import("./logger");
    initializeLogger();
    const logger = getLogger("test-module");
    expect(logger).toBeDefined();
  });
});
