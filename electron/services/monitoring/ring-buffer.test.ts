import { describe, it, expect, beforeEach } from "vitest";
import { RingBuffer } from "./ring-buffer";

describe("RingBuffer", () => {
  describe("constructor", () => {
    it("should create buffer with specified capacity", () => {
      const buffer = new RingBuffer<number>(5);
      expect(buffer.getCapacity()).toBe(5);
      expect(buffer.size()).toBe(0);
    });

    it("should throw error for non-positive capacity", () => {
      expect(() => new RingBuffer<number>(0)).toThrow("capacity must be positive");
      expect(() => new RingBuffer<number>(-1)).toThrow("capacity must be positive");
    });
  });

  describe("push", () => {
    it("should add items to buffer", () => {
      const buffer = new RingBuffer<number>(3);
      buffer.push(1);
      buffer.push(2);
      expect(buffer.size()).toBe(2);
      expect(buffer.toArray()).toEqual([1, 2]);
    });

    it("should overwrite oldest items when full", () => {
      const buffer = new RingBuffer<number>(3);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      buffer.push(4); // Should overwrite 1
      expect(buffer.size()).toBe(3);
      expect(buffer.toArray()).toEqual([2, 3, 4]);
    });

    it("should maintain FIFO order after multiple overwrites", () => {
      const buffer = new RingBuffer<number>(3);
      for (let i = 1; i <= 10; i++) {
        buffer.push(i);
      }
      expect(buffer.size()).toBe(3);
      expect(buffer.toArray()).toEqual([8, 9, 10]);
    });
  });

  describe("toArray", () => {
    it("should return empty array for empty buffer", () => {
      const buffer = new RingBuffer<number>(5);
      expect(buffer.toArray()).toEqual([]);
    });

    it("should return items in FIFO order", () => {
      const buffer = new RingBuffer<number>(5);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      expect(buffer.toArray()).toEqual([1, 2, 3]);
    });
  });

  describe("getRecent", () => {
    it("should return empty array for empty buffer", () => {
      const buffer = new RingBuffer<number>(5);
      expect(buffer.getRecent(3)).toEqual([]);
    });

    it("should return empty array for n=0", () => {
      const buffer = new RingBuffer<number>(5);
      buffer.push(1);
      buffer.push(2);
      expect(buffer.getRecent(0)).toEqual([]);
    });

    it("should return most recent items (newest first)", () => {
      const buffer = new RingBuffer<number>(5);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      buffer.push(4);
      expect(buffer.getRecent(2)).toEqual([4, 3]);
    });

    it("should return all items if n exceeds size", () => {
      const buffer = new RingBuffer<number>(5);
      buffer.push(1);
      buffer.push(2);
      expect(buffer.getRecent(10)).toEqual([2, 1]);
    });

    it("should work correctly after buffer wraps", () => {
      const buffer = new RingBuffer<number>(3);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      buffer.push(4);
      buffer.push(5);
      expect(buffer.getRecent(2)).toEqual([5, 4]);
    });
  });

  describe("getLast", () => {
    it("should return undefined for empty buffer", () => {
      const buffer = new RingBuffer<number>(5);
      expect(buffer.getLast()).toBeUndefined();
    });

    it("should return most recently added item", () => {
      const buffer = new RingBuffer<number>(5);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      expect(buffer.getLast()).toBe(3);
    });
  });

  describe("isEmpty/isFull", () => {
    it("should correctly report empty state", () => {
      const buffer = new RingBuffer<number>(3);
      expect(buffer.isEmpty()).toBe(true);
      expect(buffer.isFull()).toBe(false);
      buffer.push(1);
      expect(buffer.isEmpty()).toBe(false);
    });

    it("should correctly report full state", () => {
      const buffer = new RingBuffer<number>(3);
      buffer.push(1);
      buffer.push(2);
      expect(buffer.isFull()).toBe(false);
      buffer.push(3);
      expect(buffer.isFull()).toBe(true);
    });
  });

  describe("clear", () => {
    it("should reset buffer to empty state", () => {
      const buffer = new RingBuffer<number>(3);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      buffer.clear();
      expect(buffer.size()).toBe(0);
      expect(buffer.isEmpty()).toBe(true);
      expect(buffer.toArray()).toEqual([]);
    });
  });

  describe("with complex objects", () => {
    interface TestItem {
      id: number;
      value: string;
    }

    let buffer: RingBuffer<TestItem>;

    beforeEach(() => {
      buffer = new RingBuffer<TestItem>(3);
    });

    it("should store and retrieve objects correctly", () => {
      buffer.push({ id: 1, value: "a" });
      buffer.push({ id: 2, value: "b" });
      expect(buffer.toArray()).toEqual([
        { id: 1, value: "a" },
        { id: 2, value: "b" },
      ]);
    });

    it("should handle object overwrites", () => {
      buffer.push({ id: 1, value: "a" });
      buffer.push({ id: 2, value: "b" });
      buffer.push({ id: 3, value: "c" });
      buffer.push({ id: 4, value: "d" });
      expect(buffer.getLast()).toEqual({ id: 4, value: "d" });
      expect(buffer.toArray()[0]).toEqual({ id: 2, value: "b" });
    });
  });
});
