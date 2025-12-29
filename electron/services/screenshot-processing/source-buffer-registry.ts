/**
 * Source Buffer Registry
 *
 * Manages per-source screenshot buffers with:
 * - Automatic periodic refresh via AutoRefreshCache
 * - pHash deduplication integrated in add()
 * - Grace period handling for inactive sources
 *
 * Public interface: add(), get(), refresh()
 *
 */

import { EventEmitter } from "events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { screen } from "electron";

import type { CapturePreferencesService } from "../capture-preferences-service";
import { AutoRefreshCache } from "../screen-capture/auto-refresh-cache";
import { batchConfig, sourceBufferConfig } from "./config";
import { computeHash, isDuplicateByLast } from "./phash-dedup";
import type { AcceptedScreenshot, SourceKey } from "./types";
import { isValidSourceKey } from "./types";
import { getLogger } from "../logger";

const logger = getLogger("source-buffer-registry");

// ============================================================================
// Types
// ============================================================================

/**
 * Buffer state for a single capture source
 */
export interface SourceBuffer {
  sourceKey: SourceKey;
  screenshots: AcceptedScreenshot[];
  lastPHash: string | null;
  lastSeenAt: number;
  sourceGeneration: number;
  batchStartTs: number | null;
}

/**
 * Result of adding a screenshot
 */
export interface AddResult {
  /** Whether the screenshot was accepted (not a duplicate) */
  accepted: boolean;
  /** Reason for rejection if not accepted */
  reason?: "duplicate" | "source_inactive";
}

/**
 * Screenshot input for add() method
 */
export interface ScreenshotInput {
  /** Source identifier */
  sourceKey: SourceKey;
  /** Image buffer for pHash computation */
  imageBuffer: Buffer;
  /** Pre-computed pHash (optional, will be computed if not provided) */
  phash?: string;
  /** Screenshot data to store */
  screenshot: Omit<AcceptedScreenshot, "id" | "phash"> & { id?: number; phash?: string };
  persistAcceptedScreenshot?: (screenshot: Omit<AcceptedScreenshot, "id">) => Promise<number>;
}

export type SourceBufferRegistryEvent = "batch:ready";

export interface BatchReadyEvent {
  type: "batch:ready";
  timestamp: number;
  trigger: "add" | "timeout";
  batches: Record<SourceKey, AcceptedScreenshot[]>;
}

export const sourceBufferRegistryEmitter = new EventEmitter();

// ============================================================================
// SourceBufferRegistry Class
// ============================================================================

/**
 * Source Buffer Registry
 *
 * Simplified public interface:
 * - add(input): Add screenshot with pHash dedup
 * - get(sourceKey): Get buffer for a source
 * - refresh(): Manually trigger source refresh
 *
 * Automatic behaviors:
 * - Periodic refresh via AutoRefreshCache
 * - Grace period cleanup for inactive sources
 * - pHash deduplication within same source
 */
export class SourceBufferRegistry {
  private buffers = new Map<string, SourceBuffer>();
  private activeSources = new Set<SourceKey>();
  private generationCounter = 0;
  private disposed = false;
  private processingBatches = false;

  // Services
  private capturePreferencesService: CapturePreferencesService | null = null;
  private refreshCache: AutoRefreshCache<Set<SourceKey>> | null = null;
  private batchTriggerCache: AutoRefreshCache<void> | null = null;

  // Config
  private readonly batchSize = batchConfig.batchSize;
  private readonly batchTimeoutMs = batchConfig.batchTimeoutMs;
  private readonly gracePeriodMs = sourceBufferConfig.gracePeriodMs;
  private readonly refreshIntervalMs = sourceBufferConfig.refreshIntervalMs;
  private readonly computeHashFn: (imageBuffer: Buffer) => Promise<string>;

  constructor(computeHashFn: (imageBuffer: Buffer) => Promise<string> = computeHash) {
    this.computeHashFn = computeHashFn;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Initialization
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Initialize the registry with CapturePreferencesService
   * Starts automatic periodic refresh
   */
  initialize(preferencesService: CapturePreferencesService): void {
    this.capturePreferencesService = preferencesService;

    // Ensure idempotent initialization (e.g., dev hot reload)
    this.refreshCache?.dispose();
    this.refreshCache = null;
    this.batchTriggerCache?.dispose();
    this.batchTriggerCache = null;
    this.disposed = false;

    // Create AutoRefreshCache for periodic source refresh
    this.refreshCache = new AutoRefreshCache<Set<SourceKey>>({
      fetchFn: async () => this.doRefresh(),
      interval: this.refreshIntervalMs,
      immediate: true,
      onError: (error) => {
        logger.error({ error }, "Failed to refresh active sources");
      },
    });

    this.batchTriggerCache = new AutoRefreshCache<void>({
      fetchFn: async () => {
        this.processReadyBatches("timeout");
      },
      interval: this.batchTimeoutMs,
      immediate: false,
      onError: (error) => {
        logger.error({ error }, "Failed to process batch timeouts");
      },
    });

    logger.info(
      { refreshIntervalMs: this.refreshIntervalMs, gracePeriodMs: this.gracePeriodMs },
      "SourceBufferRegistry initialized"
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public API: add, get, refresh
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Add a screenshot to the buffer with pHash deduplication
   *
   * Process:
   * 1. Check if source is active (reject if not)
   * 2. Compute pHash if not provided
   * 3. Check for duplicates within same source
   * 4. Add to buffer if unique
   * 5. Internally trigger batch processing if needed
   */
  async add(input: ScreenshotInput): Promise<AddResult> {
    const { sourceKey, imageBuffer, screenshot } = input;

    // Check if source is active
    if (!this.isSourceActive(sourceKey)) {
      logger.debug({ sourceKey }, "Rejected screenshot: source inactive");
      return { accepted: false, reason: "source_inactive" };
    }

    const buffer = this.getOrCreateBuffer(sourceKey);

    // Compute pHash if not provided
    const phash: string =
      input.phash ?? screenshot.phash ?? (await this.computeHashFn(imageBuffer));

    // Check for duplicates within same source
    if (isDuplicateByLast(phash, buffer.lastPHash)) {
      logger.debug({ sourceKey, phash }, "Rejected screenshot: duplicate");
      return { accepted: false, reason: "duplicate" };
    }

    buffer.lastPHash = phash;
    const now = Date.now();

    let id = screenshot.id;
    if (input.persistAcceptedScreenshot) {
      const payload: Omit<AcceptedScreenshot, "id"> = {
        ts: screenshot.ts,
        sourceKey: screenshot.sourceKey,
        filePath: screenshot.filePath,
        meta: screenshot.meta,
        phash,
      };

      id = await input.persistAcceptedScreenshot(payload);
    }
    if (typeof id !== "number") {
      throw new Error("Accepted screenshot is missing database id");
    }

    const acceptedScreenshot: AcceptedScreenshot = {
      ...screenshot,
      id,
      phash,
    };

    buffer.screenshots.push(acceptedScreenshot);
    buffer.lastSeenAt = now;

    if (buffer.batchStartTs === null) {
      buffer.batchStartTs = now;
    }

    this.processReadyBatches("add");

    logger.debug(
      { sourceKey, phash, bufferSize: buffer.screenshots.length },
      "Screenshot added to buffer"
    );

    return { accepted: true };
  }

  /**
   * Get buffer for a source
   *
   * @param sourceKey - Source identifier
   * @returns Buffer if exists, undefined otherwise
   */
  get(sourceKey: SourceKey): SourceBuffer | undefined {
    return this.buffers.get(sourceKey);
  }

  /**
   * Manually trigger source refresh
   * Also performs grace period cleanup
   */
  async refresh(): Promise<void> {
    await this.doRefresh();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Batch Operations
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Consume screenshots from buffer for batch processing
   * Returns screenshots in FIFO order and clears the buffer
   */
  private drainForBatch(sourceKey: SourceKey): AcceptedScreenshot[] {
    const buffer = this.buffers.get(sourceKey);

    if (!buffer || buffer.screenshots.length === 0) {
      return [];
    }

    const screenshots = [...buffer.screenshots];
    buffer.screenshots = [];
    buffer.batchStartTs = null;

    logger.debug({ sourceKey, count: screenshots.length }, "Drained screenshots for batch");

    return screenshots;
  }

  /**
   * Check if a source is currently active
   */
  private isSourceActive(sourceKey: SourceKey): boolean {
    return this.activeSources.has(sourceKey);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Dispose the registry and stop automatic refresh
   */
  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.refreshCache?.dispose();
    this.refreshCache = null;
    this.batchTriggerCache?.dispose();
    this.batchTriggerCache = null;
    this.buffers.clear();
    this.activeSources.clear();

    logger.info("SourceBufferRegistry disposed");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal Methods
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Perform source refresh and grace period cleanup
   */
  doRefresh(): Set<SourceKey> {
    const now = Date.now();
    const currentSources = this.fetchActiveSources();

    // Update active sources set
    // For sources in currentSources: create buffer if not exists, update lastSeenAt
    for (const sourceKey of currentSources) {
      const buffer = this.getOrCreateBuffer(sourceKey);
      buffer.lastSeenAt = now;
      this.generationCounter++;
      buffer.sourceGeneration = this.generationCounter;
    }

    // Grace period cleanup: remove buffers not seen within grace period
    const keysToRemove: string[] = [];
    for (const [key, buffer] of this.buffers) {
      if (!currentSources.has(key as SourceKey) && now - buffer.lastSeenAt >= this.gracePeriodMs) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      const discarded = this.drainForBatch(key as SourceKey);
      this.buffers.delete(key);
      logger.debug(
        { sourceKey: key, discardedCount: discarded.length },
        "Removed inactive source buffer after grace period"
      );
    }

    // Update active sources
    this.activeSources = currentSources;

    logger.debug(
      {
        activeCount: currentSources.size,
        bufferedCount: this.buffers.size,
        removedCount: keysToRemove.length,
      },
      "Source refresh completed"
    );

    return currentSources;
  }

  /**
   * Fetch active sources from CapturePreferencesService
   */
  private fetchActiveSources(): Set<SourceKey> {
    if (!this.capturePreferencesService) {
      return new Set();
    }

    const prefs = this.capturePreferencesService.getEffectiveCaptureSources() as unknown as {
      selectedScreens: Array<string | { displayId: string }>;
      selectedApps: Array<string | { id: string }>;
    };
    const sources = new Set<SourceKey>();

    if (prefs.selectedScreens.length === 0 && prefs.selectedApps.length === 0) {
      try {
        const displays = screen.getAllDisplays();
        for (const display of displays) {
          const key = `screen:${display.id.toString()}` as SourceKey;
          if (isValidSourceKey(key)) sources.add(key);
        }
      } catch (error) {
        logger.debug(
          { error },
          "Failed to read displays from electron.screen; leaving activeSources empty"
        );
      }
      return sources;
    }

    for (const screen of prefs.selectedScreens) {
      const displayId = typeof screen === "string" ? screen : screen.displayId;
      const key = `screen:${displayId}` as SourceKey;
      if (isValidSourceKey(key)) sources.add(key);
    }

    for (const app of prefs.selectedApps) {
      const id = typeof app === "string" ? app : app.id;
      const key = `window:${id}` as SourceKey;
      if (isValidSourceKey(key)) sources.add(key);
    }

    return sources;
  }

  /**
   * Get or create a buffer for the given source
   */
  private getOrCreateBuffer(sourceKey: SourceKey): SourceBuffer {
    let buffer = this.buffers.get(sourceKey);

    if (!buffer) {
      this.generationCounter++;
      buffer = {
        sourceKey,
        screenshots: [],
        lastPHash: null,
        lastSeenAt: Date.now(),
        sourceGeneration: this.generationCounter,
        batchStartTs: null,
      };
      this.buffers.set(sourceKey, buffer);
      logger.debug({ sourceKey, generation: this.generationCounter }, "Created new source buffer");
    }

    return buffer;
  }

  /**
   * Process any sources that are ready to form a batch.
   *
   * NOTE: The orchestration (BatchBuilder/VLM pipeline) should be done in
   * ScreenshotProcessingModule.initialize(). This registry only owns buffering
   * and trigger detection.
   */
  private processReadyBatches(trigger: "add" | "timeout"): void {
    if (this.processingBatches) {
      return;
    }

    this.processingBatches = true;
    try {
      const now = Date.now();
      const readySourceKeys = this.collectReadySourceKeys(now);

      const batches: Record<string, AcceptedScreenshot[]> = {};

      for (const sourceKey of readySourceKeys) {
        const screenshots = this.drainForBatch(sourceKey);
        if (screenshots.length === 0) {
          continue;
        }

        batches[sourceKey] = screenshots;

        logger.info(
          { sourceKey, count: screenshots.length, trigger },
          "Batch ready from source buffer"
        );
        // TODO: hand off `screenshots` to BatchBuilder/VLM pipeline via ScreenshotProcessingModule
        // Temporary debug: copy accepted screenshots to ~/.mnemora/screenshots
        try {
          const outDir = path.join(os.homedir(), ".mnemora", "screenshots");
          fs.mkdirSync(outDir, { recursive: true });
          for (const screenshot of screenshots) {
            if (!screenshot.filePath) continue;
            const fileName = `${screenshot.ts}-${sourceKey}.png`;
            const destPath = path.join(outDir, fileName);
            fs.copyFileSync(screenshot.filePath, destPath);
          }
        } catch (error) {
          logger.warn({ error }, "Failed to write debug screenshots to disk");
        }
      }

      const batchKeys = Object.keys(batches);
      if (batchKeys.length > 0) {
        const event: BatchReadyEvent = {
          type: "batch:ready",
          timestamp: now,
          trigger,
          batches,
        };

        sourceBufferRegistryEmitter.emit("batch:ready", event);
      }
    } finally {
      this.processingBatches = false;
    }
  }

  private collectReadySourceKeys(now: number): SourceKey[] {
    const ready: SourceKey[] = [];
    for (const sourceKey of this.activeSources) {
      const buffer = this.buffers.get(sourceKey);
      if (!buffer || buffer.screenshots.length === 0) {
        continue;
      }

      if (this.isBufferReadyForBatch(buffer, now)) {
        ready.push(sourceKey);
      }
    }
    return ready;
  }

  private isBufferReadyForBatch(buffer: SourceBuffer, now: number): boolean {
    if (buffer.screenshots.length >= this.batchSize) {
      return true;
    }

    if (buffer.batchStartTs !== null) {
      const elapsed = now - buffer.batchStartTs;
      if (elapsed >= this.batchTimeoutMs) {
        return true;
      }
    }

    return false;
  }
}

export const sourceBufferRegistry = new SourceBufferRegistry();
