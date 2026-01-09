import type { ScreenshotProcessingEventMap } from "./events";
import { getLogger } from "../logger";

type EventName<EventMap> = Extract<keyof EventMap, string>;

const logger = getLogger("screenshot-processing-event-bus");

export interface ScreenshotProcessingEventBus {
  on<K extends EventName<ScreenshotProcessingEventMap>>(
    eventName: K,
    handler: (payload: ScreenshotProcessingEventMap[K]) => void | Promise<void>
  ): () => void;

  once<K extends EventName<ScreenshotProcessingEventMap>>(
    eventName: K,
    handler: (payload: ScreenshotProcessingEventMap[K]) => void | Promise<void>
  ): () => void;

  off<K extends EventName<ScreenshotProcessingEventMap>>(
    eventName: K,
    handler: (payload: ScreenshotProcessingEventMap[K]) => void | Promise<void>
  ): void;

  emit<K extends EventName<ScreenshotProcessingEventMap>>(
    eventName: K,
    payload: ScreenshotProcessingEventMap[K]
  ): void;

  removeAllListeners<K extends EventName<ScreenshotProcessingEventMap>>(eventName?: K): void;
}

class TypedEventBus<EventMap extends object> {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();

  on<K extends EventName<EventMap>>(
    eventName: K,
    handler: (payload: EventMap[K]) => void | Promise<void>
  ): () => void {
    const key = eventName as string;
    const set = this.listeners.get(key) ?? new Set<(payload: unknown) => void | Promise<void>>();
    set.add(handler as unknown as (payload: unknown) => void | Promise<void>);
    this.listeners.set(key, set);

    return () => {
      this.off(eventName, handler);
    };
  }

  once<K extends EventName<EventMap>>(
    eventName: K,
    handler: (payload: EventMap[K]) => void | Promise<void>
  ): () => void {
    const wrapped = (payload: EventMap[K]) => {
      this.off(eventName, wrapped);
      handler(payload);
    };
    return this.on(eventName, wrapped);
  }

  off<K extends EventName<EventMap>>(
    eventName: K,
    handler: (payload: EventMap[K]) => void | Promise<void>
  ): void {
    const key = eventName as string;
    const set = this.listeners.get(key);
    if (!set) {
      return;
    }
    set.delete(handler as unknown as (payload: unknown) => void | Promise<void>);
    if (set.size === 0) {
      this.listeners.delete(key);
    }
  }

  emit<K extends EventName<EventMap>>(eventName: K, payload: EventMap[K]): void {
    const key = eventName as string;
    const set = this.listeners.get(key);
    if (!set || set.size === 0) {
      return;
    }

    for (const handler of [...set]) {
      try {
        const result = handler(payload);
        void Promise.resolve(result).catch((error) => {
          logger.error(
            { error, eventName },
            "Unhandled async error (Promise rejection) thrown by screenshot processing event handler"
          );
        });
      } catch (error) {
        logger.error(
          { error, eventName },
          "Unhandled error thrown by screenshot processing event handler"
        );
      }
    }
  }

  removeAllListeners<K extends EventName<EventMap>>(eventName?: K): void {
    if (eventName) {
      this.listeners.delete(eventName as string);
      return;
    }

    this.listeners.clear();
  }
}

export const screenshotProcessingEventBus: ScreenshotProcessingEventBus =
  new TypedEventBus<ScreenshotProcessingEventMap>();
