import { createWorker, type Worker } from "tesseract.js";
import sharp from "sharp";

import { getLogger } from "../logger";
import { processingConfig } from "./config";
import type { KnowledgePayload } from "./types";

type TextRegion = KnowledgePayload["textRegion"];

type CropBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type OcrResult = {
  text: string;
  confidence: number;
  durationMs: number;
  preprocessMs: number;
  recognizeMs: number;
};

type WorkerSlot = {
  worker: Worker;
  busy: boolean;
};

export class OcrService {
  private readonly logger = getLogger("ocr-service");
  private readonly maxWorkers = Math.max(1, Math.floor(processingConfig.ocr.concurrency));
  private readonly workerSlots: WorkerSlot[] = [];
  private readonly waiters: Array<(slot: WorkerSlot) => void> = [];
  private creatingCount = 0;

  async warmup(): Promise<void> {
    try {
      const slot = await this.acquireWorker();
      this.releaseWorker(slot);
    } catch (error) {
      this.logger.warn({ error }, "Failed to warm up OCR worker");
    }
  }

  async recognize(options: {
    filePath: string;
    textRegion?: TextRegion | null;
  }): Promise<OcrResult> {
    const startTime = Date.now();
    const slot = await this.acquireWorker();

    try {
      const preprocessStart = Date.now();
      const processedBuffer = await this.preprocessImage(options.filePath, options.textRegion);
      const preprocessMs = Date.now() - preprocessStart;

      const recognizeStart = Date.now();
      const { data } = await slot.worker.recognize(processedBuffer);
      const recognizeMs = Date.now() - recognizeStart;

      const text = (data.text ?? "").trim();
      const truncated = text.slice(0, processingConfig.ocr.maxChars).trim();

      return {
        text: truncated,
        confidence: data.confidence ?? 0,
        durationMs: Date.now() - startTime,
        preprocessMs,
        recognizeMs,
      };
    } finally {
      this.releaseWorker(slot);
    }
  }

  async dispose(): Promise<void> {
    const slots = [...this.workerSlots];
    this.workerSlots.length = 0;
    this.waiters.length = 0;

    await Promise.all(
      slots.map(async (slot) => {
        try {
          await slot.worker.terminate();
        } catch (error) {
          this.logger.warn({ error }, "Failed to terminate OCR worker");
        }
      })
    );
  }

  private async acquireWorker(): Promise<WorkerSlot> {
    const idle = this.workerSlots.find((slot) => !slot.busy);
    if (idle) {
      idle.busy = true;
      return idle;
    }

    if (this.workerSlots.length + this.creatingCount < this.maxWorkers) {
      this.creatingCount += 1;
      try {
        const worker = await this.createWorkerInstance();
        const slot: WorkerSlot = { worker, busy: true };
        this.workerSlots.push(slot);
        return slot;
      } finally {
        this.creatingCount = Math.max(0, this.creatingCount - 1);
      }
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private releaseWorker(slot: WorkerSlot): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      slot.busy = true;
      waiter(slot);
      return;
    }

    slot.busy = false;
  }

  private async createWorkerInstance(): Promise<Worker> {
    this.logger.debug({ languages: processingConfig.ocr.languages }, "Creating OCR worker");
    const worker = await createWorker(processingConfig.ocr.languages, 1);
    return worker;
  }

  private async preprocessImage(filePath: string, textRegion?: TextRegion | null): Promise<Buffer> {
    const cropBox = await this.computeCropBox(filePath, textRegion);
    let pipeline = sharp(filePath);

    if (cropBox) {
      pipeline = pipeline.extract(cropBox);
    }

    return pipeline.greyscale().normalize().sharpen({ sigma: 1 }).linear(1.2, -20).toBuffer();
  }

  private async computeCropBox(
    filePath: string,
    textRegion?: TextRegion | null
  ): Promise<CropBox | null> {
    if (!textRegion?.box) {
      return null;
    }

    const metadata = await sharp(filePath).metadata();
    const imageWidth = metadata.width ?? 0;
    const imageHeight = metadata.height ?? 0;

    if (imageWidth <= 0 || imageHeight <= 0) {
      return null;
    }

    const clamp = (value: number, min: number, max: number) =>
      Math.min(Math.max(Math.floor(value), min), max);

    const left = clamp(textRegion.box.left, 0, Math.max(0, imageWidth - 1));
    const top = clamp(textRegion.box.top, 0, Math.max(0, imageHeight - 1));
    const maxWidth = Math.max(0, imageWidth - left);
    const maxHeight = Math.max(0, imageHeight - top);
    const width = clamp(textRegion.box.width, 1, Math.max(1, maxWidth));
    const height = clamp(textRegion.box.height, 1, Math.max(1, maxHeight));

    if (width <= 0 || height <= 0) {
      return null;
    }

    return {
      left,
      top,
      width: Math.min(width, maxWidth),
      height: Math.min(height, maxHeight),
    };
  }
}

export const ocrService = new OcrService();
