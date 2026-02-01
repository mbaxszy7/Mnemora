import type { IpcMainInvokeEvent } from "electron";

import { IPC_CHANNELS, type IPCResult, toIPCError } from "@shared/ipc-types";
import type {
  ThreadsGetByIdRequest,
  ThreadsGetActiveCandidatesResponse,
  ThreadsGetActiveStateResponse,
  ThreadsGetBriefRequest,
  ThreadsGetBriefResponse,
  ThreadsGetLensStateResponse,
  ThreadsGetResolvedActiveResponse,
  ThreadsGetResponse,
  ThreadsListRequest,
  ThreadsListResponse,
  ThreadsPinRequest,
  ThreadsPinResponse,
  ThreadsUnpinResponse,
} from "@shared/thread-lens-types";

import { IPCHandlerRegistry } from "./handler-registry";
import { getLogger } from "../services/logger";
import { threadsService } from "../services/screenshot-processing/threads-service";
import { threadRuntimeService } from "../services/screenshot-processing/thread-runtime-service";

const logger = getLogger("threads-handlers");

async function handleGetActiveState(): Promise<IPCResult<ThreadsGetActiveStateResponse>> {
  try {
    const state = await threadsService.getActiveThreadState();
    return { success: true, data: { state } };
  } catch (error) {
    logger.error({ error }, "IPC handleGetActiveState failed");
    return { success: false, error: toIPCError(error) };
  }
}

async function handleGetActiveCandidates(): Promise<IPCResult<ThreadsGetActiveCandidatesResponse>> {
  try {
    const threads = await threadsService.getActiveThreadCandidatesWithPinned();
    return { success: true, data: { threads } };
  } catch (error) {
    logger.error({ error }, "IPC handleGetActiveCandidates failed");
    return { success: false, error: toIPCError(error) };
  }
}

async function handleGetResolvedActive(): Promise<IPCResult<ThreadsGetResolvedActiveResponse>> {
  try {
    const thread = await threadsService.getResolvedActiveThread();
    return { success: true, data: { thread } };
  } catch (error) {
    logger.error({ error }, "IPC handleGetResolvedActive failed");
    return { success: false, error: toIPCError(error) };
  }
}

async function handlePin(
  _event: IpcMainInvokeEvent,
  request: ThreadsPinRequest
): Promise<IPCResult<ThreadsPinResponse>> {
  try {
    const state = await threadsService.pinThread(request.threadId);
    threadRuntimeService.markLensDirty("pin");
    return { success: true, data: { state } };
  } catch (error) {
    logger.error({ error, request }, "IPC handlePin failed");
    return { success: false, error: toIPCError(error) };
  }
}

async function handleUnpin(): Promise<IPCResult<ThreadsUnpinResponse>> {
  try {
    const state = await threadsService.unpinThread();
    threadRuntimeService.markLensDirty("unpin");
    return { success: true, data: { state } };
  } catch (error) {
    logger.error({ error }, "IPC handleUnpin failed");
    return { success: false, error: toIPCError(error) };
  }
}

async function handleGetLensState(): Promise<IPCResult<ThreadsGetLensStateResponse>> {
  try {
    const snapshot = await threadRuntimeService.getLensStateSnapshot();
    return { success: true, data: { snapshot } };
  } catch (error) {
    logger.error({ error }, "IPC handleGetLensState failed");
    return { success: false, error: toIPCError(error) };
  }
}

async function handleGet(
  _event: IpcMainInvokeEvent,
  request: ThreadsGetByIdRequest
): Promise<IPCResult<ThreadsGetResponse>> {
  try {
    const thread = threadsService.getThreadById(request.threadId);
    return { success: true, data: { thread } };
  } catch (error) {
    logger.error({ error, request }, "IPC handleGet thread failed");
    return { success: false, error: toIPCError(error) };
  }
}

async function handleList(
  _event: IpcMainInvokeEvent,
  request: ThreadsListRequest
): Promise<IPCResult<ThreadsListResponse>> {
  try {
    const threads = threadsService.listThreads(request.limit);
    return { success: true, data: { threads } };
  } catch (error) {
    logger.error({ error, request }, "IPC handleList threads failed");
    return { success: false, error: toIPCError(error) };
  }
}

async function handleGetBrief(
  _event: IpcMainInvokeEvent,
  request: ThreadsGetBriefRequest
): Promise<IPCResult<ThreadsGetBriefResponse>> {
  try {
    const brief = await threadRuntimeService.getBrief({
      threadId: request.threadId,
      force: request.force ?? false,
    });
    return { success: true, data: { brief } };
  } catch (error) {
    logger.error({ error, request }, "IPC handleGetBrief failed");
    return { success: false, error: toIPCError(error) };
  }
}

export function registerThreadsHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();

  registry.registerHandler(IPC_CHANNELS.THREADS_GET_ACTIVE_STATE, async () =>
    handleGetActiveState()
  );
  registry.registerHandler(IPC_CHANNELS.THREADS_GET_ACTIVE_CANDIDATES, async () =>
    handleGetActiveCandidates()
  );
  registry.registerHandler(IPC_CHANNELS.THREADS_GET_RESOLVED_ACTIVE, async () =>
    handleGetResolvedActive()
  );
  registry.registerHandler(IPC_CHANNELS.THREADS_PIN, handlePin);
  registry.registerHandler(IPC_CHANNELS.THREADS_UNPIN, async () => handleUnpin());
  registry.registerHandler(IPC_CHANNELS.THREADS_GET, handleGet);
  registry.registerHandler(IPC_CHANNELS.THREADS_LIST, handleList);
  registry.registerHandler(IPC_CHANNELS.THREADS_GET_BRIEF, handleGetBrief);
  registry.registerHandler(IPC_CHANNELS.THREADS_GET_LENS_STATE, async () => handleGetLensState());

  logger.info("Threads IPC handlers registered");
}
