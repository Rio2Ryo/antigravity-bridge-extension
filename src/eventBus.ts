import { EventEmitter } from 'events';
import { SSEEvent, SSEEventType } from './types';
import { logger } from './logger';

let eventIdCounter = 0;

class EventBus extends EventEmitter {
  emit(eventType: 'sse', event: SSEEvent): boolean;
  emit(eventType: string, ...args: unknown[]): boolean {
    return super.emit(eventType, ...args);
  }

  publish(type: SSEEventType, data: unknown): void {
    const event: SSEEvent = {
      event: type,
      data,
      id: String(++eventIdCounter),
    };
    logger.debug(`SSE publish: ${type} (id=${event.id})`);
    this.emit('sse', event);
  }
}

export const eventBus = new EventBus();
