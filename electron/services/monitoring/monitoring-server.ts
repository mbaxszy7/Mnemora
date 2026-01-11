import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getLogger } from "../logger";
import { metricsCollector } from "./metrics-collector";
import { queueInspector } from "./queue-inspector";
import { aiErrorStream } from "./ai-error-stream";
import { aiRequestTraceBuffer } from "./ai-request-trace";
import { activityAlertBuffer } from "./activity-alert-trace";
import { mainI18n } from "../i18n-service";
import type {
  SSEMessage,
  MetricsSnapshot,
  AIErrorEvent,
  AIRequestTrace,
  ActivityAlertEvent,
  HealthSummary,
  InitPayload,
} from "./monitoring-types";
import { DEFAULT_MONITORING_CONFIG, HEALTH_THRESHOLDS, getHealthLevel } from "./monitoring-types";

const logger = getLogger("monitoring-server");

// Get directory for static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Static files are copied to dist-electron/monitoring-static by vite build
const STATIC_DIR = path.join(__dirname, "monitoring-static");

/**
 * SSE Client connection tracking
 */
interface SSEClient {
  id: string;
  res: http.ServerResponse;
  sendQueue: string[];
  droppedFrames: number;
  backpressured: boolean;
  connected: boolean;
}

/**
 * MonitoringServer
 *
 * Local HTTP server for performance monitoring dashboard.
 * Binds only to 127.0.0.1 for security.
 *
 */
export class MonitoringServer {
  private static instance: MonitoringServer | null = null;

  private server: http.Server | null = null;
  private clients: Map<string, SSEClient> = new Map();
  private port: number = 0;
  private running: boolean = false;
  private queuePollInterval: NodeJS.Timeout | null = null;
  private clientIdCounter: number = 0;
  private streamingActive: boolean = false;

  private onMetrics = (snapshot: MetricsSnapshot) => {
    this.broadcastMessage({ type: "metrics", data: snapshot });
  };

  private onAIError = (event: AIErrorEvent) => {
    this.broadcastMessage({ type: "ai_error", data: event });
  };

  private onAIRequestTrace = (trace: AIRequestTrace) => {
    this.broadcastMessage({ type: "ai_request", data: trace });
  };

  private onActivityAlert = (event: ActivityAlertEvent) => {
    this.broadcastMessage({ type: "activity_alert", data: event });
  };

  private constructor() {}

  static getInstance(): MonitoringServer {
    if (!MonitoringServer.instance) {
      MonitoringServer.instance = new MonitoringServer();
    }
    return MonitoringServer.instance;
  }

  /**
   * Start the monitoring server
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.debug("MonitoringServer already running");
      return;
    }

    try {
      // Find available port
      this.port = await this.findAvailablePort();

      // Create HTTP server
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // Start listening
      await new Promise<void>((resolve, reject) => {
        this.server!.listen(this.port, "127.0.0.1", () => {
          resolve();
        });
        this.server!.on("error", reject);
      });

      this.running = true;

      logger.info({ port: this.port }, "MonitoringServer started at http://127.0.0.1:" + this.port);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to start MonitoringServer"
      );
      throw error;
    }
  }

  /**
   * Stop the monitoring server
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;

    this.stopStreaming();

    // Close all SSE connections
    for (const client of this.clients.values()) {
      client.connected = false;
      client.res.end();
    }
    this.clients.clear();

    // Close server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    logger.info("MonitoringServer stopped");
  }

  /**
   * Get the port the server is listening on
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.running;
  }

  private async findAvailablePort(): Promise<number> {
    const { preferredPort, maxPortAttempts } = DEFAULT_MONITORING_CONFIG;

    for (let i = 0; i < maxPortAttempts; i++) {
      const port = preferredPort + i;
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }

    throw new Error(
      `No available port found in range ${preferredPort}-${preferredPort + maxPortAttempts}`
    );
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = http.createServer();
      server.listen(port, "127.0.0.1");
      server.on("listening", () => {
        server.close();
        resolve(true);
      });
      server.on("error", () => {
        resolve(false);
      });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? "/";

    // CORS headers for local development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route handling
    if (url === "/" || url === "/index.html") {
      this.serveStaticFile(res, "dashboard.html", "text/html");
    } else if (url === "/ai-monitor" || url === "/ai-monitor.html") {
      this.serveStaticFile(res, "ai-monitor.html", "text/html");
    } else if (url === "/health") {
      this.handleHealthCheck(res);
    } else if (url === "/api/stream") {
      this.handleSSEConnection(req, res);
    } else if (url === "/api/locale") {
      this.handleLocale(res);
    } else if (url === "/api/queue") {
      void this.handleQueueStatus(res);
    } else if (url === "/api/errors") {
      void this.handleRecentErrors(res);
    } else if (url === "/api/error-rates") {
      void this.handleErrorRates(res);
    } else if (url === "/api/ai-requests") {
      this.handleAIRequests(res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  private serveStaticFile(res: http.ServerResponse, filename: string, contentType: string): void {
    const filePath = path.join(STATIC_DIR, filename);

    fs.readFile(filePath, "utf8", (err, data) => {
      if (err) {
        logger.warn({ filename, error: err.message }, "Static file not found");
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("File not found");
        return;
      }

      res.writeHead(200, { "Content-Type": contentType + "; charset=utf-8" });
      res.end(data);
    });
  }

  private handleHealthCheck(res: http.ServerResponse): void {
    const health = {
      status: "ok",
      port: this.port,
      uptime: process.uptime(),
      clients: this.clients.size,
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health));
  }

  private handleLocale(res: http.ServerResponse): void {
    const lang = mainI18n.getCurrentLanguage();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ lang }));
  }

  private async handleQueueStatus(res: http.ServerResponse): Promise<void> {
    try {
      const status = await queueInspector.getQueueStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to get queue status" }));
    }
  }

  private async handleRecentErrors(res: http.ServerResponse): Promise<void> {
    try {
      const errors = await aiErrorStream.queryRecentErrors(50);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(errors));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to get recent errors" }));
    }
  }

  private async handleErrorRates(res: http.ServerResponse): Promise<void> {
    try {
      const [rate1m, rate5m, topErrors] = await Promise.all([
        aiErrorStream.getErrorRate(60000),
        aiErrorStream.getErrorRate(300000),
        aiErrorStream.getErrorsByCode(10),
      ]);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ rate1m, rate5m, topErrors }));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to get error rates" }));
    }
  }

  private handleAIRequests(res: http.ServerResponse): void {
    try {
      const traces = aiRequestTraceBuffer.getRecent();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(traces));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to get AI requests" }));
    }
  }

  private handleSSEConnection(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.clients.size >= DEFAULT_MONITORING_CONFIG.maxClientsPerConnection) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many monitoring clients" }));
      return;
    }

    const clientId = `client-${++this.clientIdCounter}`;

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Create client
    const client: SSEClient = {
      id: clientId,
      res,
      sendQueue: [],
      droppedFrames: 0,
      backpressured: false,
      connected: true,
    };

    this.clients.set(clientId, client);
    logger.debug({ clientId, totalClients: this.clients.size }, "SSE client connected");

    res.on("drain", () => {
      this.flushClientQueue(client);
    });

    if (this.clients.size === 1) {
      this.startStreaming();
    }

    // Send initial data
    void this.sendInitialData(client);

    // Handle disconnect
    req.on("close", () => {
      client.connected = false;
      this.clients.delete(clientId);
      logger.debug({ clientId, totalClients: this.clients.size }, "SSE client disconnected");

      if (this.clients.size === 0) {
        this.stopStreaming();
      }
    });
  }

  private async sendInitialData(client: SSEClient): Promise<void> {
    try {
      const [queueStatus, healthSummary] = await Promise.all([
        queueInspector.getQueueStatus(),
        this.getFullHealthSummary(),
      ]);

      const initPayload: InitPayload = {
        recentMetrics: metricsCollector.getRecentMetrics(),
        recentQueue: queueStatus,
        recentErrors: await aiErrorStream.queryRecentErrors(50),
        recentActivityAlerts: activityAlertBuffer.getRecent(50),
        health: healthSummary,
      };

      this.sendToClient(client, { type: "init", data: initPayload });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to send initial data"
      );
    }
  }

  private async getFullHealthSummary(): Promise<HealthSummary> {
    const baseSummary = metricsCollector.getHealthSummary();

    // Add queue backlog health
    const pendingCount = await queueInspector.getTotalPendingCount();
    baseSummary.queueBacklog = {
      level: getHealthLevel(pendingCount, HEALTH_THRESHOLDS.queueBacklog),
      value: pendingCount,
      threshold: HEALTH_THRESHOLDS.queueBacklog,
    };

    return baseSummary;
  }

  private broadcastMessage(message: SSEMessage): void {
    for (const client of this.clients.values()) {
      this.sendToClient(client, message);
    }
  }

  private sendToClient(client: SSEClient, message: SSEMessage): void {
    if (!client.connected) return;

    try {
      const data = `data: ${JSON.stringify(message)}\n\n`;

      if (client.backpressured) {
        this.enqueueClientData(client, data);
        return;
      }

      const ok = client.res.write(data);
      if (!ok) {
        client.backpressured = true;
      }
    } catch {
      logger.warn({ clientId: client.id }, "Failed to send SSE message");
      client.droppedFrames++;
    }
  }

  private enqueueClientData(client: SSEClient, data: string): void {
    const limit = DEFAULT_MONITORING_CONFIG.maxClientQueueSize;

    if (limit <= 0) {
      client.droppedFrames++;
      return;
    }

    if (client.sendQueue.length >= limit) {
      // Keep latest frame only (drop older)
      client.sendQueue.splice(0, client.sendQueue.length - limit + 1);
      client.droppedFrames++;
    }

    client.sendQueue.push(data);
  }

  private flushClientQueue(client: SSEClient): void {
    if (!client.connected) return;

    try {
      while (client.sendQueue.length > 0) {
        const chunk = client.sendQueue[0];
        const ok = client.res.write(chunk);
        if (!ok) {
          client.backpressured = true;
          return;
        }
        client.sendQueue.shift();
      }

      client.backpressured = false;
    } catch {
      client.droppedFrames++;
    }
  }

  private startStreaming(): void {
    if (this.streamingActive) return;
    this.streamingActive = true;

    metricsCollector.start();
    aiErrorStream.start();

    metricsCollector.on("metrics", this.onMetrics);
    aiErrorStream.on("error", this.onAIError);
    aiRequestTraceBuffer.on("trace", this.onAIRequestTrace);
    activityAlertBuffer.on("alert", this.onActivityAlert);

    this.startQueuePolling();
  }

  private stopStreaming(): void {
    if (!this.streamingActive) return;
    this.streamingActive = false;

    if (this.queuePollInterval) {
      clearInterval(this.queuePollInterval);
      this.queuePollInterval = null;
    }

    metricsCollector.off("metrics", this.onMetrics);
    aiErrorStream.off("error", this.onAIError);
    aiRequestTraceBuffer.off("trace", this.onAIRequestTrace);
    activityAlertBuffer.off("alert", this.onActivityAlert);

    metricsCollector.stop();
    aiErrorStream.stop();

    for (const client of this.clients.values()) {
      client.sendQueue = [];
      client.backpressured = false;
    }
  }

  private startQueuePolling(): void {
    this.queuePollInterval = setInterval(async () => {
      if (this.clients.size === 0) return;

      try {
        const status = await queueInspector.getQueueStatus();
        this.broadcastMessage({ type: "queue", data: status });

        // Also send health update
        const health = await this.getFullHealthSummary();
        this.broadcastMessage({ type: "health", data: health });
      } catch (error) {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to poll queue status"
        );
      }
    }, DEFAULT_MONITORING_CONFIG.queueIntervalMs);
  }
}

export const monitoringServer = MonitoringServer.getInstance();
