import type { IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, type IPCResult, toIPCError } from "@shared/ipc-types";
import { IPCHandlerRegistry } from "./handler-registry";
import { contextSearchService } from "../services/screenshot-processing/context-search-service";
import type {
  SearchQuery,
  SearchResult,
  ExpandedContextNode,
  GraphTraversalResult,
  EdgeType,
  ScreenshotEvidence,
} from "../services/screenshot-processing/types";
import { getLogger } from "../services/logger";

const logger = getLogger("context-graph-handlers");

/**
 * Handle semantic search
 */
async function handleSearch(
  _event: IpcMainInvokeEvent,
  query: SearchQuery
): Promise<IPCResult<SearchResult>> {
  try {
    const result = await contextSearchService.search(query);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, query }, "IPC handleSearch failed");
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
    const result = await contextSearchService.getThread(threadId);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, threadId }, "IPC handleGetThread failed");
    return { success: false, error: toIPCError(error) };
  }
}

/**
 * Handle graph traversal
 */
async function handleTraverse(
  _event: IpcMainInvokeEvent,
  { nodeId, edgeTypes, depth }: { nodeId: string; edgeTypes?: EdgeType[]; depth: number }
): Promise<IPCResult<GraphTraversalResult>> {
  try {
    const result = await contextSearchService.traverse(nodeId, depth, edgeTypes);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, nodeId, edgeTypes, depth }, "IPC handleTraverse failed");
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
    const result = await contextSearchService.getEvidence(nodeIds);
    return { success: true, data: result };
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
  registry.registerHandler(IPC_CHANNELS.CONTEXT_GET_THREAD, handleGetThread);
  registry.registerHandler(IPC_CHANNELS.CONTEXT_TRAVERSE, handleTraverse);
  registry.registerHandler(IPC_CHANNELS.CONTEXT_GET_EVIDENCE, handleGetEvidence);
}
