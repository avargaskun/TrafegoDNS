/**
 * Generic helper functions
 */
import logger from './logger';

/**
 * Create a debounced function that will only be called after a specified delay
 * @param {Function} func - Function to debounce
 * @param {number} wait - Delay in milliseconds
 * @returns {Function} - Debounced function
 */
function debounce<A extends unknown[]>(func: (...args: A) => unknown, wait: number): (...args: A) => void {
  let timeout: NodeJS.Timeout | undefined;
  
  return function executedFunction(...args: A) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Create a throttled function that will only be called at most once per specified period
 * @param {Function} func - Function to throttle
 * @param {number} limit - Period in milliseconds
 * @returns {Function} - Throttled function
 */
function throttle<A extends unknown[]>(func: (...args: A) => unknown, limit: number): (...args: A) => void {
  let inThrottle: boolean | undefined;
  
  return function executedFunction(...args: A) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

/**
 * Retry a function until it succeeds or reaches max attempts
 * @param {Function} func - Function to retry (should return a promise)
 * @param {number} retries - Maximum number of retries
 * @param {number} delay - Delay between retries in milliseconds
 * @param {Function} onRetry - Called on each retry with attempt count and error
 * @returns {Promise} - Promise that resolves when function succeeds
 */
async function retry<T>(func: () => T | PromiseLike<T>, retries = 3, delay = 1000, onRetry: ((retriesLeft: number, error: unknown) => void) | null = null): Promise<T> {
  try {
    return await func();
  } catch (error) {
    if (retries <= 0) {
      throw error;
    }
    
    if (onRetry) {
      onRetry(retries, error);
    }
    
    await new Promise(resolve => setTimeout(resolve, delay));
    return retry(func, retries - 1, delay, onRetry);
  }
}

/**
 * Group an array of objects by a key
 * @param {Array} array - Array to group
 * @param {string|Function} key - Key to group by (string or function that returns grouping value)
 * @returns {Object} - Grouped object
 */
function groupBy<T>(array: T[], key: string | ((item: T) => PropertyKey)): Record<PropertyKey, T[]> {
  return array.reduce<Record<PropertyKey, T[]>>((result, item) => {
    const groupKey = typeof key === 'function' ? key(item) : (item as Record<string, PropertyKey>)[key];
    
    // Create the group if it doesn't exist
    if (!result[groupKey]) {
      result[groupKey] = [];
    }
    
    // Add the item to the group
    result[groupKey].push(item);
    
    return result;
  }, {});
}

/**
 * Create a queue for sequential async processing
 * @returns {Object} - Queue object with methods
 */
function createAsyncQueue() {
  const queue: { task: () => unknown; resolve: (value: unknown) => void; reject: (reason?: unknown) => void }[] = [];
  let isProcessing = false;
  
  /**
   * Process next item in the queue
   */
  async function processNext(): Promise<void> {
    if (isProcessing || queue.length === 0) {
      return;
    }
    
    isProcessing = true;
    
    try {
      const { task, resolve, reject } = queue.shift()!;
      
      try {
        const result = await task();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    } finally {
      isProcessing = false;
      
      // Process next item if any
      if (queue.length > 0) {
        processNext();
      }
    }
  }
  
  return {
    /**
     * Add a task to the queue
     * @param {Function} task - Async function to execute
     * @returns {Promise} - Promise that resolves when task completes
     */
    enqueue(task: () => unknown): Promise<unknown> {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        
        // Start processing if not already
        if (!isProcessing) {
          processNext();
        }
      });
    },
    
    /**
     * Get the current queue length
     * @returns {number} - Number of tasks in queue
     */
    get length(): number {
      return queue.length;
    },
    
    /**
     * Check if the queue is currently processing
     * @returns {boolean} - True if processing
     */
    get isProcessing(): boolean {
      return isProcessing;
    }
  };
}

export {
  debounce,
  throttle,
  retry,
  groupBy,
  createAsyncQueue
};