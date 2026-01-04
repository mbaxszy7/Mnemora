import { describe, it, expect } from "vitest";
import { Semaphore, aiSemaphore } from "./ai-semaphore";

describe("Semaphore", () => {
  describe("constructor", () => {
    it("should throw error if permits <= 0", () => {
      expect(() => new Semaphore(0)).toThrow("Semaphore permits must be positive");
      expect(() => new Semaphore(-1)).toThrow("Semaphore permits must be positive");
    });

    it("should initialize with correct permit count", () => {
      const sem = new Semaphore(3);
      expect(sem.available()).toBe(3);
      expect(sem.waiting_count()).toBe(0);
    });
  });

  describe("acquire", () => {
    it("should immediately acquire when permits available", async () => {
      const sem = new Semaphore(2);

      const release1 = await sem.acquire();
      expect(sem.available()).toBe(1);

      const release2 = await sem.acquire();
      expect(sem.available()).toBe(0);

      release1();
      expect(sem.available()).toBe(1);

      release2();
      expect(sem.available()).toBe(2);
    });

    it("should wait when no permits available", async () => {
      const sem = new Semaphore(1);

      // Acquire the only permit
      const release1 = await sem.acquire();
      expect(sem.available()).toBe(0);

      // Start acquiring second permit (will wait)
      let acquired = false;
      const acquirePromise = sem.acquire().then((release) => {
        acquired = true;
        return release;
      });

      // Should not have acquired yet
      expect(acquired).toBe(false);
      expect(sem.waiting_count()).toBe(1);

      // Release first permit
      release1();

      // Now second should acquire
      const release2 = await acquirePromise;
      expect(acquired).toBe(true);
      expect(sem.waiting_count()).toBe(0);

      release2();
    });

    it("should process waiters in order (FIFO)", async () => {
      const sem = new Semaphore(1);
      const order: number[] = [];

      // Acquire first permit
      const release1 = await sem.acquire();

      // Queue up multiple waiters
      const p1 = sem.acquire().then((r) => {
        order.push(1);
        return r;
      });
      const p2 = sem.acquire().then((r) => {
        order.push(2);
        return r;
      });
      const p3 = sem.acquire().then((r) => {
        order.push(3);
        return r;
      });

      expect(sem.waiting_count()).toBe(3);

      // Release permits one by one
      release1();
      const r1 = await p1;
      r1();

      const r2 = await p2;
      r2();

      const r3 = await p3;
      r3();

      // Should have been processed in order
      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe("tryAcquire", () => {
    it("should return release function when permits available", () => {
      const sem = new Semaphore(2);

      const release1 = sem.tryAcquire();
      expect(release1).not.toBeNull();
      expect(sem.available()).toBe(1);

      const release2 = sem.tryAcquire();
      expect(release2).not.toBeNull();
      expect(sem.available()).toBe(0);

      release1!();
      release2!();
      expect(sem.available()).toBe(2);
    });

    it("should return null when no permits available", () => {
      const sem = new Semaphore(1);

      const release = sem.tryAcquire();
      expect(release).not.toBeNull();
      expect(sem.available()).toBe(0);

      const shouldBeNull = sem.tryAcquire();
      expect(shouldBeNull).toBeNull();
      expect(sem.available()).toBe(0);

      release!();
    });
  });
});

describe("aiSemaphore manager", () => {
  it("should provide separate semaphores for each capability", () => {
    expect(aiSemaphore.vlm).toBeDefined();
    expect(aiSemaphore.text).toBeDefined();
    expect(aiSemaphore.embedding).toBeDefined();

    // They should be different instances
    expect(aiSemaphore.vlm).not.toBe(aiSemaphore.text);
    expect(aiSemaphore.text).not.toBe(aiSemaphore.embedding);
  });

  it("should return the same instance on repeated access", () => {
    const vlm1 = aiSemaphore.vlm;
    const vlm2 = aiSemaphore.vlm;
    expect(vlm1).toBe(vlm2);
  });

  it("should return correct semaphore via get method", () => {
    expect(aiSemaphore.get("vlm")).toBe(aiSemaphore.vlm);
    expect(aiSemaphore.get("text")).toBe(aiSemaphore.text);
    expect(aiSemaphore.get("embedding")).toBe(aiSemaphore.embedding);
  });
});
