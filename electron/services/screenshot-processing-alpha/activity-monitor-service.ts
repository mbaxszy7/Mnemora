import type {
  EventDetailsResponse,
  SummaryResponse,
  TimelineResponse,
} from "@shared/activity-types";

class ActivityMonitorService {
  async getTimeline(_fromTs: number, _toTs: number): Promise<TimelineResponse> {
    void _fromTs;
    void _toTs;
    return {
      windows: [],
      longEvents: [],
    };
  }

  async getSummary(_windowStart: number, _windowEnd: number): Promise<SummaryResponse | null> {
    void _windowStart;
    void _windowEnd;
    return null;
  }

  async getEventDetails(eventId: number): Promise<EventDetailsResponse> {
    return {
      id: eventId,
      eventKey: "",
      title: "",
      kind: "unknown",
      startTs: 0,
      endTs: 0,
      durationMs: 0,
      isLong: false,
      confidence: 0,
      importance: 0,
      threadId: null,
      nodeIds: null,
      details: null,
      detailsStatus: "pending",
    };
  }
}

export const activityMonitorService = new ActivityMonitorService();
