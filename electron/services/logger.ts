import { app } from "electron";
import pino from "pino";
import path from "node:path";
import fs from "node:fs";
import pretty from "pino-pretty";
// import { fileURLToPath } from "node:url";
import os from "node:os";

/**
 * Logger Service - Singleton pattern implementation
 * Provides centralized logging with file and console output
 */
class LoggerService {
  private static instance: LoggerService | null = null;
  private logger: pino.Logger;
  private logsDir: string;
  private logFile: string;

  private constructor() {
    this.logsDir = this.getLogsDir();
    this.ensureLogsDir();
    this.logFile = path.join(this.logsDir, "main.log");
    this.logger = this.createLogger();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService();
    }
    return LoggerService.instance;
  }

  /**
   * Reset instance (for testing only)
   */
  static resetInstance(): void {
    LoggerService.instance = null;
  }

  /**
   * Get logs directory - use project electron/logs folder
   */
  private getLogsDir(): string {
    const debugLogDir = path.join(os.homedir(), ".mnemora", "logs");
    // const __filename = fileURLToPath(import.meta.url);
    // const __dirname = path.dirname(__filename);
    // const projectRoot = path.join(__dirname, "..", "..");
    return debugLogDir;
  }

  /**
   * Ensure logs directory exists
   */
  private ensureLogsDir(): void {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  /**
   * Create logger instance with file and console streams
   */
  private createLogger(): pino.Logger {
    // Clear log file on each hot reload (development mode)
    if (fs.existsSync(this.logFile)) {
      fs.unlinkSync(this.logFile);
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
      destination: this.logFile,
      sync: false,
      ignore: "pid,hostname,app,logFile,module",
      singleLine: true,
      messageFormat: (log, messageKey) => {
        const msg = log[messageKey];
        const modulePrefix = log.module ? `[${log.module}] ` : "";
        return `${modulePrefix}${msg}`;
      },
    });

    // Create multiple streams for file and console output
    const streams = [{ stream: filePrettyStream }, { stream: prettyStream }];

    // Use try-catch for app.isPackaged as it may not be available before app is ready
    let logLevel = "debug";
    try {
      logLevel = app.isPackaged ? "info" : "debug";
    } catch {
      // Default to debug if app is not ready
    }

    return pino(
      {
        level: logLevel,
        base: {
          pid: process.pid,
          app: "mnemora",
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      pino.multistream(streams)
    );
  }

  /**
   * Get the pino logger instance
   * @param name - Optional module name for child logger
   */
  getLogger(name?: string): pino.Logger {
    if (name) {
      return this.logger.child({ module: name });
    }
    return this.logger;
  }

  /**
   * Get the log file path
   */
  getLogFile(): string {
    return this.logFile;
  }
}

/**
 * Initialize logger - call this in app.whenReady()
 */
export function initializeLogger(): pino.Logger {
  const service = LoggerService.getInstance();
  const logger = service.getLogger();
  logger.info({ logFile: service.getLogFile() }, "Logger initialized");
  return logger;
}

/**
 * Get the logger instance (convenience function)
 * @param name - Optional module name for child logger
 */
export function getLogger(name?: string): pino.Logger {
  return LoggerService.getInstance().getLogger(name);
}

// Export convenience methods
// export const log = {
//   debug: (...args: Parameters<pino.Logger["debug"]>) => getLogger().debug(...args),
//   info: (...args: Parameters<pino.Logger["info"]>) => getLogger().info(...args),
//   warn: (...args: Parameters<pino.Logger["warn"]>) => getLogger().warn(...args),
//   error: (...args: Parameters<pino.Logger["error"]>) => getLogger().error(...args),
//   fatal: (...args: Parameters<pino.Logger["fatal"]>) => getLogger().fatal(...args),
// };

// export default log;
