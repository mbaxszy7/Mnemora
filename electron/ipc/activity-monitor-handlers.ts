/**
 * Activity Monitor IPC Handlers
 *
 * Handles IPC requests for Activity Monitor:
 * - activity:get-timeline - Get 24h timeline windows and long events
 * - activity:get-summary - Get summary for a specific window
 * - activity:get-event-details - Get event details (on-demand generation)
 */

import type { IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, type IPCResult, toIPCError } from "@shared/ipc-types";
import { IPCHandlerRegistry } from "./handler-registry";
import { activityMonitorService } from "../services/screenshot-processing-alpha/activity-monitor-service";
import type {
  TimelineRequest,
  TimelineResponse,
  SummaryRequest,
  SummaryResponse,
  EventDetailsRequest,
  EventDetailsResponse,
  RegenerateSummaryRequest,
  RegenerateSummaryResponse,
} from "@shared/activity-types";
import { getLogger } from "../services/logger";

const logger = getLogger("activity-monitor-handlers");

/**
 * Handle timeline request
 */
async function handleGetTimeline(
  _event: IpcMainInvokeEvent,
  request: TimelineRequest
): Promise<IPCResult<TimelineResponse>> {
  try {
    const result = await activityMonitorService.getTimeline(request.fromTs, request.toTs);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, request }, "IPC handleGetTimeline failed");
    return { success: false, error: toIPCError(error) };
  }
}

async function handleRegenerateSummary(
  _event: IpcMainInvokeEvent,
  request: RegenerateSummaryRequest
): Promise<IPCResult<RegenerateSummaryResponse>> {
  try {
    const result = await activityMonitorService.regenerateSummary(
      request.windowStart,
      request.windowEnd
    );
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, request }, "IPC handleRegenerateSummary failed");
    return { success: false, error: toIPCError(error) };
  }
}

/**
 * Handle summary request
 */
async function handleGetSummary(
  _event: IpcMainInvokeEvent,
  request: SummaryRequest
): Promise<IPCResult<SummaryResponse | null>> {
  try {
    const result = await activityMonitorService.getSummary(request.windowStart, request.windowEnd);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, request }, "IPC handleGetSummary failed");
    return { success: false, error: toIPCError(error) };
  }
}

/**
 * Handle event details request
 */
async function handleGetEventDetails(
  _event: IpcMainInvokeEvent,
  request: EventDetailsRequest
): Promise<IPCResult<EventDetailsResponse>> {
  try {
    const result = await activityMonitorService.getEventDetails(request.eventId);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, request }, "IPC handleGetEventDetails failed");
    return { success: false, error: toIPCError(error) };
  }
}

/**
 * Register all Activity Monitor handlers
 */
export function registerActivityMonitorHandlers(): void {
  const registry = IPCHandlerRegistry.getInstance();
  registry.registerHandler(IPC_CHANNELS.ACTIVITY_GET_TIMELINE, handleGetTimeline);
  registry.registerHandler(IPC_CHANNELS.ACTIVITY_GET_SUMMARY, handleGetSummary);
  registry.registerHandler(IPC_CHANNELS.ACTIVITY_GET_EVENT_DETAILS, handleGetEventDetails);
  registry.registerHandler(IPC_CHANNELS.ACTIVITY_REGENERATE_SUMMARY, handleRegenerateSummary);
}
