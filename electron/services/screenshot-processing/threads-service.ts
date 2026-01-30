import { desc, eq, ne } from "drizzle-orm";

import { getDb } from "../../database";
import { threads, userSetting } from "../../database/schema";
import type { Thread } from "@shared/context-types";
import type { ActiveThreadState } from "@shared/thread-lens-types";
import { processingConfig } from "./config";
import { userSettingService } from "../user-setting-service";

type ThreadRow = {
  id: string;
  title: string;
  summary: string;
  currentPhase: string | null;
  currentFocus: string | null;
  status: "active" | "inactive" | "closed";
  startTime: number;
  lastActiveAt: number;
  durationMs: number;
  nodeCount: number;
  apps: string;
  mainProject: string | null;
  keyEntities: string;
  milestones: string | null;
  createdAt: number;
  updatedAt: number;
};

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    currentPhase: row.currentPhase ?? undefined,
    currentFocus: row.currentFocus ?? undefined,
    status: row.status,
    startTime: row.startTime,
    lastActiveAt: row.lastActiveAt,
    durationMs: row.durationMs,
    nodeCount: row.nodeCount,
    apps: safeJsonParse<string[]>(row.apps, []),
    mainProject: row.mainProject ?? undefined,
    keyEntities: safeJsonParse<string[]>(row.keyEntities, []),
    milestones: row.milestones ? safeJsonParse<unknown>(row.milestones, undefined) : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ThreadsService {
  private async ensureUserSettingRow(): Promise<void> {
    const db = getDb();
    const existing = db.select({ id: userSetting.id }).from(userSetting).get();
    if (existing) return;
    await userSettingService.getSettings();
  }

  async getActiveThreadState(): Promise<ActiveThreadState> {
    await this.ensureUserSettingRow();
    const db = getDb();
    const row = db
      .select({
        pinnedThreadId: userSetting.pinnedThreadId,
        pinnedThreadUpdatedAt: userSetting.pinnedThreadUpdatedAt,
      })
      .from(userSetting)
      .get();

    return {
      pinnedThreadId: row?.pinnedThreadId ?? null,
      updatedAt: row?.pinnedThreadUpdatedAt ?? Date.now(),
    };
  }

  async pinThread(threadId: string): Promise<ActiveThreadState> {
    await this.ensureUserSettingRow();
    const db = getDb();
    const now = Date.now();
    const id = threadId.trim();
    if (!id) {
      return this.getActiveThreadState();
    }

    const existing = db.select({ id: userSetting.id }).from(userSetting).get();
    if (!existing) {
      return this.getActiveThreadState();
    }

    db.update(userSetting)
      .set({ pinnedThreadId: id, pinnedThreadUpdatedAt: now, updatedAt: now })
      .where(eq(userSetting.id, existing.id))
      .run();

    return this.getActiveThreadState();
  }

  async unpinThread(): Promise<ActiveThreadState> {
    await this.ensureUserSettingRow();
    const db = getDb();
    const now = Date.now();

    const existing = db.select({ id: userSetting.id }).from(userSetting).get();
    if (!existing) {
      return this.getActiveThreadState();
    }

    db.update(userSetting)
      .set({ pinnedThreadId: null, pinnedThreadUpdatedAt: now, updatedAt: now })
      .where(eq(userSetting.id, existing.id))
      .run();

    return this.getActiveThreadState();
  }

  getThreadById(threadId: string): Thread | null {
    const id = threadId.trim();
    if (!id) return null;

    const db = getDb();
    const row = db
      .select({
        id: threads.id,
        title: threads.title,
        summary: threads.summary,
        currentPhase: threads.currentPhase,
        currentFocus: threads.currentFocus,
        status: threads.status,
        startTime: threads.startTime,
        lastActiveAt: threads.lastActiveAt,
        durationMs: threads.durationMs,
        nodeCount: threads.nodeCount,
        apps: threads.apps,
        mainProject: threads.mainProject,
        keyEntities: threads.keyEntities,
        milestones: threads.milestones,
        createdAt: threads.createdAt,
        updatedAt: threads.updatedAt,
      })
      .from(threads)
      .where(eq(threads.id, id))
      .get() as ThreadRow | undefined;

    return row ? rowToThread(row) : null;
  }

  listThreads(limit?: number): Thread[] {
    const db = getDb();
    const rows = db
      .select({
        id: threads.id,
        title: threads.title,
        summary: threads.summary,
        currentPhase: threads.currentPhase,
        currentFocus: threads.currentFocus,
        status: threads.status,
        startTime: threads.startTime,
        lastActiveAt: threads.lastActiveAt,
        durationMs: threads.durationMs,
        nodeCount: threads.nodeCount,
        apps: threads.apps,
        mainProject: threads.mainProject,
        keyEntities: threads.keyEntities,
        milestones: threads.milestones,
        createdAt: threads.createdAt,
        updatedAt: threads.updatedAt,
      })
      .from(threads)
      .where(ne(threads.status, "closed"))
      .orderBy(desc(threads.lastActiveAt))
      .limit(typeof limit === "number" && limit > 0 ? limit : 50)
      .all() as ThreadRow[];

    return rows.map(rowToThread);
  }

  getActiveThreadCandidates(): Thread[] {
    const db = getDb();

    const base = db
      .select({
        id: threads.id,
        title: threads.title,
        summary: threads.summary,
        currentPhase: threads.currentPhase,
        currentFocus: threads.currentFocus,
        status: threads.status,
        startTime: threads.startTime,
        lastActiveAt: threads.lastActiveAt,
        durationMs: threads.durationMs,
        nodeCount: threads.nodeCount,
        apps: threads.apps,
        mainProject: threads.mainProject,
        keyEntities: threads.keyEntities,
        milestones: threads.milestones,
        createdAt: threads.createdAt,
        updatedAt: threads.updatedAt,
      })
      .from(threads);

    const active = base
      .where(eq(threads.status, "active"))
      .orderBy(desc(threads.lastActiveAt))
      .limit(processingConfig.thread.maxActiveThreads)
      .all() as ThreadRow[];

    const fallback =
      active.length > 0
        ? active
        : (base
            .where(ne(threads.status, "closed"))
            .orderBy(desc(threads.lastActiveAt))
            .limit(processingConfig.thread.fallbackRecentThreads)
            .all() as ThreadRow[]);

    return fallback.map(rowToThread);
  }

  async getActiveThreadCandidatesWithPinned(): Promise<Thread[]> {
    const state = await this.getActiveThreadState();
    const pinned = state.pinnedThreadId ? this.getThreadById(state.pinnedThreadId) : null;
    const base = this.getActiveThreadCandidates();

    const out: Thread[] = [];
    if (pinned) out.push(pinned);
    for (const t of base) {
      if (pinned && t.id === pinned.id) continue;
      out.push(t);
      if (out.length >= processingConfig.thread.maxActiveThreads) break;
    }

    return out.slice(0, processingConfig.thread.maxActiveThreads);
  }

  async getResolvedActiveThread(): Promise<Thread | null> {
    const state = await this.getActiveThreadState();
    if (state.pinnedThreadId) {
      const pinned = this.getThreadById(state.pinnedThreadId);
      if (pinned) return pinned;
    }

    const candidates = await this.getActiveThreadCandidatesWithPinned();
    return candidates.length > 0 ? candidates[0] : null;
  }
}

export const threadsService = new ThreadsService();
