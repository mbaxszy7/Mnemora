import { app } from "electron";
import pino from "pino";
import path from "node:path";
import fs from "node:fs";
import pretty from "pino-pretty";
import { fileURLToPath } from "node:url";

// Get logs directory - use project electron/logs folder
function getLogsDir(): string {
  // Get the current file's directory in ESM
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // Get the project root directory (assuming this file is in electron/services/)
  const projectRoot = path.join(__dirname, "..", "..");
  return path.join(projectRoot, "electron", "logs");
}

// Ensure logs directory exists
function ensureLogsDir(logsDir: string): void {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

// Create logger instance
function createLogger(): pino.Logger {
  const logsDir = getLogsDir();
  ensureLogsDir(logsDir);

  const logFile = path.join(logsDir, "main.log");

  // Clear log file on each hot reload (development mode)
  if (fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  // Create pretty stream for console with custom format
  const prettyStream = pretty({
    colorize: true,
    translateTime: "HH:MM:ss",
    ignore: "pid,hostname,app,level",
    messageFormat: (log, messageKey) => {
      const msg = log[messageKey];
      return `${msg}`;
    },
  });

  // Create pretty stream for file with readable level names
  const filePrettyStream = pretty({
    colorize: false,
    translateTime: "SYS:standard",
    destination: logFile,
    sync: false,
    ignore: "pid,hostname,app,logFile,module",
    singleLine: true,
    messageFormat: (log, messageKey) => {
      const msg = log[messageKey];
      // Add module prefix if present
      const modulePrefix = log.module ? `[${log.module}] ` : "";
      return `${modulePrefix}${msg}`;
    },
  });

  // Create multiple streams for file and console output
  const streams = [
    // File stream - pretty format with readable levels
    { stream: filePrettyStream },
    // Console stream - pretty format
    { stream: prettyStream },
  ];

  return pino(
    {
      level: app.isPackaged ? "info" : "debug",
      base: {
        pid: process.pid,
        app: "mnemora",
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams)
  );
}

// Singleton logger instance
let logger: pino.Logger | null = null;

/**
 * Get the logger instance (lazy initialization)
 * Must be called after app is ready
 * @param name - Optional module name for child logger
 */
export function getLogger(name?: string): pino.Logger {
  if (!logger) {
    logger = createLogger();
  }

  // Return child logger with module name if provided
  if (name) {
    return logger.child({ module: name });
  }

  return logger;
}

/**
 * Initialize logger - call this in app.whenReady()
 */
export function initializeLogger(): pino.Logger {
  logger = createLogger();
  const logFile = path.join(getLogsDir(), "main.log");
  logger.info({ logFile }, "Logger initialized");
  return logger;
}

// Export convenience methods
export const log = {
  debug: (...args: Parameters<pino.Logger["debug"]>) => getLogger().debug(...args),
  info: (...args: Parameters<pino.Logger["info"]>) => getLogger().info(...args),
  warn: (...args: Parameters<pino.Logger["warn"]>) => getLogger().warn(...args),
  error: (...args: Parameters<pino.Logger["error"]>) => getLogger().error(...args),
  fatal: (...args: Parameters<pino.Logger["fatal"]>) => getLogger().fatal(...args),
};

export default log;
