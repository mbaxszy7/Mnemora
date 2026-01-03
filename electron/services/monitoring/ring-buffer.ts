/**
 * RingBuffer - Memory-efficient circular buffer
 *
 * Used to store recent metrics data with fixed memory footprint.
 * When capacity is reached, oldest items are overwritten.
 */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private capacity: number;
  private head: number = 0; // next write position
  private count: number = 0; // current item count

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error("RingBuffer capacity must be positive");
    }
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  /**
   * Add an item to the buffer
   * If buffer is full, overwrites the oldest item
   */
  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /**
   * Get all items in order (oldest to newest)
   */
  toArray(): T[] {
    if (this.count === 0) return [];

    const result: T[] = [];
    const start = this.count < this.capacity ? 0 : this.head;

    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      result.push(this.buffer[idx] as T);
    }

    return result;
  }

  /**
   * Get the most recent N items (newest first)
   */
  getRecent(n: number): T[] {
    if (this.count === 0 || n <= 0) return [];

    const take = Math.min(n, this.count);
    const result: T[] = [];

    for (let i = 0; i < take; i++) {
      // head points to next write position, so head-1 is the most recent
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      result.push(this.buffer[idx] as T);
    }

    return result;
  }

  /**
   * Get the most recent item, or undefined if empty
   */
  getLast(): T | undefined {
    if (this.count === 0) return undefined;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buffer[idx];
  }

  /**
   * Get current number of items in the buffer
   */
  size(): number {
    return this.count;
  }

  /**
   * Get the maximum capacity of the buffer
   */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Check if buffer is empty
   */
  isEmpty(): boolean {
    return this.count === 0;
  }

  /**
   * Check if buffer is at capacity
   */
  isFull(): boolean {
    return this.count === this.capacity;
  }

  /**
   * Clear all items from the buffer
   */
  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}
