import type { IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, type IPCResult, toIPCError } from "@shared/ipc-types";
import { IPCHandlerRegistry } from "./handler-registry";
import type {
  SearchQuery,
  SearchResult,
  ExpandedContextNode,
  ScreenshotEvidence,
} from "../services/screenshot-processing-alpha/types";
import { getLogger } from "../services/logger";

const logger = getLogger("context-graph-handlers");

const inFlightSearchControllers = new Map<string, AbortController>();

/**
 * Handle semantic search
 */
async function handleSearch(
  _event: IpcMainInvokeEvent,
  query: SearchQuery
): Promise<IPCResult<SearchResult>> {
  try {
    void query;
    return {
      success: true,
      data: {
        nodes: [],
        relatedEvents: [],
        evidence: [],
      },
    };
  } catch (error) {
    logger.error({ error, query }, "IPC handleSearch failed");
    return { success: false, error: toIPCError(error) };
  }
}

/**
 * Handle cancelling an in-flight search
 */
async function handleSearchCancel(
  _event: IpcMainInvokeEvent,
  requestId: string
): Promise<IPCResult<boolean>> {
  try {
    const id = requestId?.trim();
    if (!id) {
      return { success: true, data: false };
    }

    const controller = inFlightSearchControllers.get(id);
    if (!controller) {
      return { success: true, data: false };
    }

    controller.abort();
    inFlightSearchControllers.delete(id);
    return { success: true, data: true };
  } catch (error) {
    logger.error({ error, requestId }, "IPC handleSearchCancel failed");
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
    void threadId;
    return { success: true, data: [] };
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
    void nodeIds;
    return { success: true, data: [] };
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
