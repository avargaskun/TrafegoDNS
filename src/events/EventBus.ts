/**
 * Event Bus for application-wide event handling
 * Implements a simple pub/sub pattern for decoupled communication
 */
import EventEmitter from 'events';
import logger from '../utils/logger';
import { runGuarded } from '../utils/errors';
import EventTypes from './EventTypes';
import type { EventHandler, EventName, EventPayloads, EventWithoutPayload } from '../../types/events';

class EventBus {
  declare emitter: EventEmitter;
  declare subscriberCounts: Record<string, number>;

  constructor() {
    this.emitter = new EventEmitter();
    
    // Set higher limit for listeners to avoid warnings
    this.emitter.setMaxListeners(20);
    
    // Track number of subscribers for debugging
    this.subscriberCounts = {};
    
    // Setup debug logging of events if in TRACE mode
    if (logger.level >= 4) { // TRACE level
      this.setupDebugLogging();
    }
  }
  
  /**
   * Subscribe to an event
   * @param {string} eventType - Event type from EventTypes
   * @param {Function} handler - Event handler function
   */
  subscribe<K extends EventName>(eventType: K, handler: EventHandler<K>): () => void {
    if (!Object.values(EventTypes).includes(eventType)) {
      logger.warn(`Subscribing to unknown event type: ${eventType}`);
    }
    
    const wrapped = (data: EventPayloads[K]) => runGuarded(`Error in ${eventType} subscriber`, () => handler(data));
    this.emitter.on(eventType, wrapped);
    
    // Track subscriber counts
    this.subscriberCounts[eventType] = (this.subscriberCounts[eventType] || 0) + 1;
    logger.debug(`Subscribed to event ${eventType} (${this.subscriberCounts[eventType]} subscribers)`);
    
    // Return unsubscribe function for cleanup
    return () => {
      this.emitter.off(eventType, wrapped);
      this.subscriberCounts[eventType]--;
      logger.debug(`Unsubscribed from event ${eventType} (${this.subscriberCounts[eventType]} subscribers)`);
    };
  }
  
  /**
   * Publish an event
   * @param {string} eventType - Event type from EventTypes
   * @param {Object} data - Event data
   */
  publish<K extends EventName>(eventType: K, data: EventPayloads[K]): void;
  publish(eventType: EventWithoutPayload): void;
  publish(eventType: EventName, data: EventPayloads[EventName] = {}): void {
    if (!Object.values(EventTypes).includes(eventType)) {
      logger.warn(`Publishing unknown event type: ${eventType}`);
    }
    
    if (this.subscriberCounts[eventType] && this.subscriberCounts[eventType] > 0) {
      logger.debug(`Publishing event ${eventType} to ${this.subscriberCounts[eventType]} subscribers`);
      this.emitter.emit(eventType, data);
    } else {
      logger.debug(`No subscribers for event ${eventType}`);
    }
  }
  
  /**
   * Setup debug logging of all events
   * Only active in TRACE log level
   */
  setupDebugLogging(): void {
    Object.values(EventTypes).forEach(eventType => {
      this.emitter.on(eventType, (data) => {
        logger.trace(`EVENT: ${eventType} - ${JSON.stringify(data)}`);
      });
    });
    
    logger.debug('Event debug logging enabled');
  }
}

export { EventBus };