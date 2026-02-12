import type { IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, type IPCResult, toIPCError } from "@shared/ipc-types";
import { IPCHandlerRegistry } from "./handler-registry";
import type {
  SearchQuery,
  SearchResult,
  ExpandedContextNode,
  ScreenshotEvidence,
} from "../services/screenshot-processing/types";
import { getLogger } from "../services/logger";

const logger = getLogger("context-graph-handlers");

let inFlightSearchController: AbortController | null = null;

async function getContextSearchService() {
  const { contextSearchService } =
    await import("../services/screenshot-processing/context-search-service");
  return contextSearchService;
}

/**
 * Handle semantic search
 */
async function handleSearch(
  _event: IpcMainInvokeEvent,
  query: SearchQuery
): Promise<IPCResult<SearchResult>> {
  try {
    const trimmed = query.trim();
    if (!trimmed) {
      return { success: true, data: { nodes: [], relatedEvents: [], evidence: [] } };
    }

    if (inFlightSearchController) {
      inFlightSearchController.abort();
    }

    const controller = new AbortController();
    inFlightSearchController = controller;

    try {
      const contextSearchService = await getContextSearchService();
      const result = await contextSearchService.search(trimmed, controller.signal);
      return { success: true, data: result };
    } finally {
      if (inFlightSearchController === controller) {
        inFlightSearchController = null;
      }
    }
  } catch (error) {
    logger.error({ error, query }, "IPC handleSearch failed");
    return { success: false, error: toIPCError(error) };
  }
}

/**
 * Handle cancelling an in-flight search
 */
async function handleSearchCancel(_event: IpcMainInvokeEvent): Promise<IPCResult<boolean>> {
  try {
    void _event;
    if (!inFlightSearchController) {
      return { success: true, data: false };
    }

    inFlightSearchController.abort();
    inFlightSearchController = null;
    return { success: true, data: true };
  } catch (error) {
    logger.error({ error }, "IPC handleSearchCancel failed");
    return { success: false, error: toIPCError(error) };
  }
}

/**
 * Handle getting a thread of events
 */
async function handleGetThread(
  _event: IpcMainInvokeEvent,
  threadId: string
): Promise<IPCResult<ExpandedContextNode[]>> {
  try {
    const id = threadId?.trim();
    if (!id) {
      return { success: true, data: [] };
    }
    const contextSearchService = await getContextSearchService();
    const data = await contextSearchService.getThread(id);
    return { success: true, data };
  } catch (error) {
    logger.error({ error, threadId }, "IPC handleGetThread failed");
    return { success: false, error: toIPCError(error) };
  }
}

/**
 * Handle getting evidence (screenshots)
 */
async function handleGetEvidence(
  _event: IpcMainInvokeEvent,
  nodeIds: number[]
): Promise<IPCResult<ScreenshotEvidence[]>> {
  try {
    const ids = Array.isArray(nodeIds) ? nodeIds : [];
    const contextSearchService = await getContextSearchService();
    const data = await contextSearchService.getEvidence(ids);
    return { success: true, data };
  } catch (error) {
    logger.error({ error, nodeIds }, "IPC handleGetEvidence failed");
    return { success: false, error: toIPCError(error) };
  }
}

/**
 * Register all context graph handlers
 */
export function registerContextGraphHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();
  registry.registerHandler(IPC_CHANNELS.CONTEXT_SEARCH, handleSearch);
  registry.registerHandler(IPC_CHANNELS.CONTEXT_SEARCH_CANCEL, handleSearchCancel);
  registry.registerHandler(IPC_CHANNELS.CONTEXT_GET_THREAD, handleGetThread);
  registry.registerHandler(IPC_CHANNELS.CONTEXT_GET_EVIDENCE, handleGetEvidence);
}
