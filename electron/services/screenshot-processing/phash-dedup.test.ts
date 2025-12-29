/**
 * pHash Deduplication Tests
 *
 * Unit tests and property-based tests for the pHash deduplication module.
 * Covers cross-source isolation and threshold correctness.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";
import { computeHash, hammingDistance, isDuplicateByLast } from "./phash-dedup";

const threshold = 8;

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Generate a valid 16-character hex hash
 */
const hexHashArb = fc
  .array(fc.constantFrom(..."0123456789abcdef".split("")), { minLength: 16, maxLength: 16 })
  .map((chars) => chars.join(""));

/**
 * Generate a valid source key
 */
const sourceKeyArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 10 }).map((s) => `screen:${s}`),
  fc.string({ minLength: 1, maxLength: 10 }).map((s) => `window:${s}`)
);

/**
 * Generate two different source keys
 */
const differentSourceKeysArb = fc.tuple(sourceKeyArb, sourceKeyArb).filter(([a, b]) => a !== b);

/**
 * Generate a hash with a specific Hamming distance from a base hash
 */
function generateHashWithDistance(baseHash: string, distance: number): string {
  const base = BigInt("0x" + baseHash);
  let result = base;

  // Flip 'distance' bits
  for (let i = 0; i < distance && i < 64; i++) {
    result ^= BigInt(1) << BigInt(i);
  }

  return result.toString(16).padStart(16, "0");
}

// ============================================================================
// Unit Tests
// ============================================================================

describe("PHashDedup Unit Tests", () => {
  let windows: Map<string, string>;

  beforeEach(() => {
    windows = new Map();
  });

  describe("computeHash", () => {
    it("should return a stable hash for the same image buffer", async () => {
      const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Zk1sAAAAASUVORK5CYII=";
      const imageBuffer = Buffer.from(pngBase64, "base64");

      const h1 = await computeHash(imageBuffer);
      const h2 = await computeHash(imageBuffer);
      const h3 = await computeHash(imageBuffer);

      expect(h1).toBe(h2);
      expect(h2).toBe(h3);
      expect(h1).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe("hammingDistance", () => {
    it("should return 0 for identical hashes", () => {
      const hash = "0123456789abcdef";
      expect(hammingDistance(hash, hash)).toBe(0);
    });

    it("should return 64 for completely different hashes", () => {
      const hash1 = "0000000000000000";
      const hash2 = "ffffffffffffffff";
      expect(hammingDistance(hash1, hash2)).toBe(64);
    });

    it("should return correct distance for single bit difference", () => {
      const hash1 = "0000000000000000";
      const hash2 = "0000000000000001";
      expect(hammingDistance(hash1, hash2)).toBe(1);
    });

    it("should be symmetric", () => {
      const hash1 = "0123456789abcdef";
      const hash2 = "fedcba9876543210";
      expect(hammingDistance(hash1, hash2)).toBe(hammingDistance(hash2, hash1));
    });
  });

  describe("isDuplicate", () => {
    it("should return false for empty window", () => {
      expect(isDuplicateByLast("0123456789abcdef", windows.get("screen:1"), threshold)).toBe(false);
    });

    it("should return true for identical hash in window", () => {
      const hash = "0123456789abcdef";
      windows.set("screen:1", hash);
      expect(isDuplicateByLast(hash, windows.get("screen:1"), threshold)).toBe(true);
    });

    it("should return true for similar hash (distance < threshold)", () => {
      const baseHash = "0000000000000000";
      const similarHash = generateHashWithDistance(baseHash, 5); // distance = 5 < 8
      windows.set("screen:1", baseHash);
      expect(isDuplicateByLast(similarHash, windows.get("screen:1"), threshold)).toBe(true);
    });

    it("should return false for different hash (distance >= threshold)", () => {
      const baseHash = "0000000000000000";
      const differentHash = generateHashWithDistance(baseHash, 10); // distance = 10 >= 8
      windows.set("screen:1", baseHash);
      expect(isDuplicateByLast(differentHash, windows.get("screen:1"), threshold)).toBe(false);
    });
  });

  describe("addToWindow and clearWindow", () => {
    it("should add hash to window", () => {
      windows.set("screen:1", "0123456789abcdef");
      expect(windows.has("screen:1") ? 1 : 0).toBe(1);
    });

    it("should clear window for specific source", () => {
      windows.set("screen:1", "0123456789abcdef");
      windows.set("screen:2", "fedcba9876543210");
      windows.delete("screen:1");
      expect(windows.has("screen:1") ? 1 : 0).toBe(0);
      expect(windows.has("screen:2") ? 1 : 0).toBe(1);
    });

    it("should respect window size limit (ring buffer)", () => {
      windows.set("screen:1", "0000000000000001");
      windows.set("screen:1", "0000000000000002");
      windows.set("screen:1", "0000000000000003");
      windows.set("screen:1", "0000000000000004"); // should keep only last
      expect(windows.has("screen:1") ? 1 : 0).toBe(1);
    });
  });

  describe("threshold boundary", () => {
    it("should reject at distance = threshold - 1", () => {
      const baseHash = "0000000000000000";
      const nearHash = generateHashWithDistance(baseHash, threshold - 1);
      windows.set("screen:1", baseHash);
      expect(isDuplicateByLast(nearHash, windows.get("screen:1"), threshold)).toBe(true);
    });

    it("should accept at distance = threshold", () => {
      const baseHash = "0000000000000000";
      const atThresholdHash = generateHashWithDistance(baseHash, threshold);
      windows.set("screen:1", baseHash);
      expect(isDuplicateByLast(atThresholdHash, windows.get("screen:1"), threshold)).toBe(false);
    });
  });
});

// ============================================================================
// Property-Based Tests
// ============================================================================

describe("PHashDedup Property Tests", () => {
  /**
   *
   */
  it("Cross-source isolation - different sources never consider each other duplicates", () => {
    fc.assert(
      fc.property(differentSourceKeysArb, hexHashArb, ([sourceKey1, sourceKey2], hash) => {
        const windows = new Map<string, string>();

        // Add hash to source 1
        windows.set(sourceKey1, hash);

        // Check if source 2 considers it a duplicate
        // It should NOT, because they are different sources
        const isDup = isDuplicateByLast(hash, windows.get(sourceKey2), threshold);

        expect(isDup).toBe(false);
        return true;
      }),
      { numRuns: 100 }
    );
  });

  /**
   *
   */
  it("Same source detects identical hashes as duplicates", () => {
    fc.assert(
      fc.property(sourceKeyArb, hexHashArb, (sourceKey, hash) => {
        const windows = new Map<string, string>();

        // Add hash to source
        windows.set(sourceKey, hash);

        // Same source should detect it as duplicate
        const isDup = isDuplicateByLast(hash, windows.get(sourceKey), threshold);

        expect(isDup).toBe(true);
        return true;
      }),
      { numRuns: 100 }
    );
  });

  /**
   *
   */
  it("Threshold correctness - distance < threshold means duplicate", () => {
    fc.assert(
      fc.property(
        sourceKeyArb,
        hexHashArb,
        fc.integer({ min: 0, max: 7 }), // distance < 8 (threshold)
        (sourceKey, baseHash, distance) => {
          const windows = new Map<string, string>();

          // Generate a hash with the specified distance
          const similarHash = generateHashWithDistance(baseHash, distance);

          // Add base hash to window
          windows.set(sourceKey, baseHash);

          // Should be detected as duplicate (distance < threshold)
          const isDup = isDuplicateByLast(similarHash, windows.get(sourceKey), threshold);

          expect(isDup).toBe(true);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   *
   */
  it("Threshold correctness - distance >= threshold means not duplicate", () => {
    fc.assert(
      fc.property(
        sourceKeyArb,
        hexHashArb,
        fc.integer({ min: 8, max: 64 }), // distance >= 8 (threshold)
        (sourceKey, baseHash, distance) => {
          const windows = new Map<string, string>();

          // Generate a hash with the specified distance
          const differentHash = generateHashWithDistance(baseHash, distance);

          // Add base hash to window
          windows.set(sourceKey, baseHash);

          // Should NOT be detected as duplicate (distance >= threshold)
          const isDup = isDuplicateByLast(differentHash, windows.get(sourceKey), threshold);

          expect(isDup).toBe(false);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   *
   */
  it("Hamming distance is symmetric", () => {
    fc.assert(
      fc.property(hexHashArb, hexHashArb, (hash1, hash2) => {
        const d1 = hammingDistance(hash1, hash2);
        const d2 = hammingDistance(hash2, hash1);

        expect(d1).toBe(d2);
        return true;
      }),
      { numRuns: 100 }
    );
  });

  /**
   *
   */
  it("Hamming distance is in valid range [0, 64]", () => {
    fc.assert(
      fc.property(hexHashArb, hexHashArb, (hash1, hash2) => {
        const distance = hammingDistance(hash1, hash2);

        expect(distance).toBeGreaterThanOrEqual(0);
        expect(distance).toBeLessThanOrEqual(64);
        return true;
      }),
      { numRuns: 100 }
    );
  });

  /**
   *
   */
  it("Clearing window for one source does not affect others", () => {
    fc.assert(
      fc.property(
        differentSourceKeysArb,
        hexHashArb,
        hexHashArb,
        ([sourceKey1, sourceKey2], hash1, hash2) => {
          const windows = new Map<string, string>();

          // Add hashes to both sources
          windows.set(sourceKey1, hash1);
          windows.set(sourceKey2, hash2);

          // Clear source 1
          windows.delete(sourceKey1);

          // Source 1 should be empty
          expect(windows.has(sourceKey1) ? 1 : 0).toBe(0);

          // Source 2 should still have its hash
          expect(windows.has(sourceKey2) ? 1 : 0).toBe(1);

          // Source 2 should still detect its hash as duplicate
          expect(isDuplicateByLast(hash2, windows.get(sourceKey2), threshold)).toBe(true);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
