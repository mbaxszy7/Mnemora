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
  private readonly maxEntries = 5000;

  private constructor() {
    this.logsDir = this.getLogsDir();
    this.ensureLogsDir();
    this.logFile = path.join(this.logsDir, "main.log");
    this.logger = this.createLogger();
  }

  private trimLogFile(): void {
    try {
      const content = fs.readFileSync(this.logFile, "utf8");
      const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
      if (lines.length > this.maxEntries) {
        const trimmed = lines.slice(-this.maxEntries).join(os.EOL) + os.EOL;
        fs.writeFileSync(this.logFile, trimmed, "utf8");
      }
    } catch {
      // Fail silently to avoid blocking logging
    }
  }

  private isProd(): boolean {
    try {
      return app.isPackaged;
    } catch {
      return false;
    }
  }

  static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService();
    }
    return LoggerService.instance;
  }

  static resetInstance(): void {
    LoggerService.instance = null;
  }

  private getLogsDir(): string {
    const debugLogDir = path.join(os.homedir(), ".mnemora", "logs");
    // const __filename = fileURLToPath(import.meta.url);
    // const __dirname = path.dirname(__filename);
    // const projectRoot = path.join(__dirname, "..", "..");
    return debugLogDir;
  }

  private ensureLogsDir(): void {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  private createLogger(): pino.Logger {
    // Clear log file on each hot reload (development mode)
    // In production, retain latest maxEntries to cap file growth
    if (fs.existsSync(this.logFile)) {
      if (this.isProd()) {
        this.trimLogFile();
      } else {
        try {
          fs.unlinkSync(this.logFile);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          if (!this.shouldIgnoreLogCleanupError(code)) {
            throw error;
          }
        }
      }
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
    // Note: In packaged apps, async SonicBoom destinations can throw
    // "sonic boom is not ready yet" during early startup/teardown.
    // Use sync writes in production to avoid crashing the main process.
    const isProd = this.isProd();
    const filePrettyStream = pretty({
      colorize: false,
      translateTime: "SYS:standard",
      destination: this.logFile,
      sync: isProd,
      ignore: "pid,hostname,app,logFile,module",
      singleLine: true,
      messageFormat: (log, messageKey) => {
        const msg = log[messageKey];
        const modulePrefix = log.module ? `[${log.module}] ` : "";
        return `${modulePrefix}${msg}`;
      },
    });

    const logLevel = this.resolveLogLevel(process.env.MNEMORA_LOG_LEVEL, isProd);

    // Create multiple streams for file and console output with per-env levels
    // File: logLevel (info in prod, debug in dev) - ensures startup logs are captured
    // Console: error in prod (avoid spam), logLevel in dev
    const streams = [
      { level: logLevel as pino.Level, stream: filePrettyStream },
      { level: isProd ? "error" : (logLevel as pino.Level), stream: prettyStream },
    ];

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

  private shouldIgnoreLogCleanupError(code?: string): boolean {
    return code === "ENOENT" || code === "EPERM" || code === "EACCES" || code === "EBUSY";
  }

  /**
   * Resolves and validates the log level from environment variable.
   * Falls back to default if invalid or not set.
   */
  private resolveLogLevel(envLevel: string | undefined, isProd: boolean): pino.Level {
    const validLevels: pino.Level[] = ["trace", "debug", "info", "warn", "error", "fatal"];
    const defaultLevel: pino.Level = isProd ? "info" : "debug";

    if (!envLevel) {
      return defaultLevel;
    }

    const normalizedLevel = envLevel.toLowerCase() as pino.Level;
    if (validLevels.includes(normalizedLevel)) {
      return normalizedLevel;
    }

    console.warn(
      `[Logger] Invalid MNEMORA_LOG_LEVEL "${envLevel}", falling back to "${defaultLevel}"`
    );
    return defaultLevel;
  }

  getLogger(name?: string): pino.Logger {
    if (name) {
      return this.logger.child({ module: name });
    }
    return this.logger;
  }

  getLogFile(): string {
    return this.logFile;
  }
}

export function initializeLogger(): pino.Logger {
  const service = LoggerService.getInstance();
  const logger = service.getLogger();
  logger.info({ logFile: service.getLogFile() }, "Logger initialized");
  return logger;
}

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
