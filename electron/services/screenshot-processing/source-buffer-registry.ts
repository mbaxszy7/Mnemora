import { screen } from "electron";

import type { CapturePreferences } from "@shared/capture-source-types";
import { getLogger } from "../logger";
import { processingConfig } from "./config";
import { computeHash, isDuplicateByLast } from "./phash-dedup";
import type { AcceptedScreenshot, SourceKey } from "./types";
import { isValidSourceKey } from "./types";
import type { BatchReadyEvent } from "./events";
import { screenshotProcessingEventBus } from "./event-bus";

const logger = getLogger("source-buffer-registry");

export interface SourceBuffer {
  sourceKey: SourceKey;
  screenshots: AcceptedScreenshot[];
  lastPHash: string | null;
  lastSeenAt: number;
  batchStartTs: number | null;
}

export interface AddResult {
  accepted: boolean;
  reason?: "duplicate" | "source_inactive";
}

export interface ScreenshotInput {
  sourceKey: SourceKey;
  imageBuffer: Buffer;
  phash?: string;
  screenshot: Omit<AcceptedScreenshot, "id" | "phash"> & { id?: number; phash?: string };
}

export class SourceBufferRegistry {
  private buffers = new Map<SourceKey, SourceBuffer>();
  private activeSources = new Set<SourceKey>();
  private batchTimeoutTimers = new Map<SourceKey, NodeJS.Timeout>();
  private disposed = false;
  private processingBatches = false;
  private persistAcceptedScreenshot:
    | ((screenshot: Omit<AcceptedScreenshot, "id">) => Promise<number>)
    | null = null;

  private preferences: CapturePreferences | null = null;

  private readonly batchSize = processingConfig.batch.minSize;
  private readonly batchTimeoutMs = processingConfig.batch.timeoutMs;
  private phashThreshold = processingConfig.backpressure.levels[0].phashThreshold;
  private readonly gracePeriodMs = 60 * 1000;
  private readonly computeHashFn: (imageBuffer: Buffer) => Promise<string>;

  constructor(computeHashFn: (imageBuffer: Buffer) => Promise<string> = computeHash) {
    this.computeHashFn = computeHashFn;
  }

  initialize(
    onPersistAcceptedScreenshot: (screenshot: Omit<AcceptedScreenshot, "id">) => Promise<number>
  ): void {
    this.preferences = null;
    this.persistAcceptedScreenshot = onPersistAcceptedScreenshot;

    this.clearAllBatchTimeouts();
    this.disposed = false;

    try {
      this.doRefresh();
    } catch (error) {
      logger.error({ error }, "Failed to perform initial source refresh");
    }
  }

  /**
   * Update the pHash Hamming distance threshold for deduplication.
   */
  setPhashThreshold(threshold: number): void {
    this.phashThreshold = threshold;
  }

  async add(input: ScreenshotInput): Promise<AddResult> {
    const { sourceKey, imageBuffer, screenshot } = input;

    if (!this.isSourceActive(sourceKey)) {
      logger.debug({ sourceKey }, "Rejected screenshot: source inactive");
      return { accepted: false, reason: "source_inactive" };
    }

    const buffer = this.getOrCreateBuffer(sourceKey);

    const phash: string =
      input.phash ?? screenshot.phash ?? (await this.computeHashFn(imageBuffer));

    if (isDuplicateByLast(phash, buffer.lastPHash, this.phashThreshold)) {
      logger.debug({ sourceKey, phash }, "Rejected screenshot: duplicate");
      return { accepted: false, reason: "duplicate" };
    }

    buffer.lastPHash = phash;
    const now = Date.now();

    let id = screenshot.id;
    if (this.persistAcceptedScreenshot) {
      const payload: Omit<AcceptedScreenshot, "id"> = {
        ts: screenshot.ts,
        sourceKey: screenshot.sourceKey,
        filePath: screenshot.filePath,
        meta: screenshot.meta,
        phash,
      };

      id = await this.persistAcceptedScreenshot(payload);
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

    screenshotProcessingEventBus.emit("screenshot-accept", acceptedScreenshot);

    if (buffer.batchStartTs === null) {
      buffer.batchStartTs = now;
    }

    this.processReadyBatches("add");
    this.ensureBatchTimeout(sourceKey, buffer);

    return { accepted: true };
  }

  get(sourceKey: SourceKey): SourceBuffer | undefined {
    return this.buffers.get(sourceKey);
  }

  async refresh(): Promise<void> {
    await this.doRefresh();
  }

  setPreferences(preferences: CapturePreferences): void {
    this.preferences = {
      selectedScreens: [...preferences.selectedScreens],
      selectedApps: [...preferences.selectedApps],
    };
    this.doRefresh();
  }

  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.clearAllBatchTimeouts();
    this.buffers.clear();
    this.activeSources.clear();
  }

  private drainForBatch(sourceKey: SourceKey): AcceptedScreenshot[] {
    const buffer = this.buffers.get(sourceKey);

    if (!buffer || buffer.screenshots.length === 0) {
      return [];
    }

    const screenshots = [...buffer.screenshots];
    buffer.screenshots = [];
    buffer.batchStartTs = null;
    this.clearBatchTimeout(sourceKey);

    return screenshots;
  }

  private isSourceActive(sourceKey: SourceKey): boolean {
    return this.activeSources.has(sourceKey);
  }

  private doRefresh(): Set<SourceKey> {
    const now = Date.now();
    const currentSources = this.fetchActiveSources();

    for (const sourceKey of currentSources) {
      const buffer = this.getOrCreateBuffer(sourceKey);
      buffer.lastSeenAt = now;
    }

    const keysToRemove: SourceKey[] = [];
    for (const [key, buffer] of this.buffers) {
      if (!currentSources.has(key) && now - buffer.lastSeenAt >= this.gracePeriodMs) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this.drainForBatch(key);
      this.clearBatchTimeout(key);
      this.buffers.delete(key);
    }

    this.activeSources = currentSources;

    return currentSources;
  }

  private fetchActiveSources(): Set<SourceKey> {
    if (!this.preferences) {
      return new Set();
    }

    const prefs = this.preferences;
    const sources = new Set<SourceKey>();

    if (prefs.selectedScreens.length === 0 && prefs.selectedApps.length === 0) {
      try {
        const displays = screen.getAllDisplays();
        for (const display of displays) {
          const key = `screen:${display.id.toString()}`;
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

    for (const selectedScreen of prefs.selectedScreens) {
      const displayId = selectedScreen.displayId;
      const key = `screen:${displayId}`;
      if (isValidSourceKey(key)) sources.add(key);
    }

    for (const selectedApp of prefs.selectedApps) {
      const id = selectedApp.id;
      const key = `window:${id}`;
      if (isValidSourceKey(key)) sources.add(key);
    }

    return sources;
  }

  private getOrCreateBuffer(sourceKey: SourceKey): SourceBuffer {
    let buffer = this.buffers.get(sourceKey);

    if (!buffer) {
      buffer = {
        sourceKey,
        screenshots: [],
        lastPHash: null,
        lastSeenAt: Date.now(),
        batchStartTs: null,
      };
      this.buffers.set(sourceKey, buffer);
    }

    return buffer;
  }

  private ensureBatchTimeout(sourceKey: SourceKey, buffer: SourceBuffer): void {
    if (buffer.batchStartTs === null) {
      return;
    }

    if (this.batchTimeoutTimers.has(sourceKey)) {
      return;
    }

    const now = Date.now();
    const elapsed = now - buffer.batchStartTs;
    const delayMs = Math.max(0, this.batchTimeoutMs - elapsed);

    const timer = setTimeout(() => {
      this.batchTimeoutTimers.delete(sourceKey);
      this.handleBatchTimeout(sourceKey);
    }, delayMs);

    this.batchTimeoutTimers.set(sourceKey, timer);
  }

  private handleBatchTimeout(sourceKey: SourceKey): void {
    if (this.disposed) {
      return;
    }

    const buffer = this.buffers.get(sourceKey);
    if (!buffer || buffer.screenshots.length === 0 || buffer.batchStartTs === null) {
      return;
    }

    if (this.processingBatches) {
      this.scheduleBatchTimeoutRetry(sourceKey);
      return;
    }

    this.processReadyBatches("timeout");
    this.rescheduleBatchTimeoutIfNeeded(sourceKey);
  }

  private rescheduleBatchTimeoutIfNeeded(sourceKey: SourceKey): void {
    const buffer = this.buffers.get(sourceKey);
    if (!buffer || buffer.screenshots.length === 0 || buffer.batchStartTs === null) {
      return;
    }

    this.ensureBatchTimeout(sourceKey, buffer);
  }

  private scheduleBatchTimeoutRetry(sourceKey: SourceKey): void {
    if (this.batchTimeoutTimers.has(sourceKey)) {
      return;
    }

    const delayMs = Math.min(250, this.batchTimeoutMs);
    const timer = setTimeout(() => {
      this.batchTimeoutTimers.delete(sourceKey);
      this.handleBatchTimeout(sourceKey);
    }, delayMs);

    this.batchTimeoutTimers.set(sourceKey, timer);
  }

  private clearBatchTimeout(sourceKey: SourceKey): void {
    const timer = this.batchTimeoutTimers.get(sourceKey);
    if (timer) {
      clearTimeout(timer);
      this.batchTimeoutTimers.delete(sourceKey);
    }
  }

  private clearAllBatchTimeouts(): void {
    for (const timer of this.batchTimeoutTimers.values()) {
      clearTimeout(timer);
    }
    this.batchTimeoutTimers.clear();
  }

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
      }

      const batchKeys = Object.keys(batches);
      if (batchKeys.length > 0) {
        const event: BatchReadyEvent = {
          type: "batch:ready",
          timestamp: now,
          trigger,
          batches: batches as Record<SourceKey, AcceptedScreenshot[]>,
        };

        screenshotProcessingEventBus.emit("batch:ready", event);
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
