import { describe, it, expect, vi } from "vitest";

vi.mock("sharp", () => {
  const DCT_SIZE = 32;
  const pixels = new Uint8Array(DCT_SIZE * DCT_SIZE);
  for (let i = 0; i < pixels.length; i++) pixels[i] = i % 256;

  const chainObj = {
    ensureAlpha: () => chainObj,
    removeAlpha: () => chainObj,
    greyscale: () => chainObj,
    resize: () => chainObj,
    raw: () => chainObj,
    toBuffer: async () => ({
      data: Buffer.from(pixels.buffer),
    }),
  };
  return { default: () => chainObj };
});

import { hammingDistance, isDuplicateByLast, computeHash } from "./phash-dedup";

describe("computeHash", () => {
  it("returns a 16-char hex string", async () => {
    const hash = await computeHash(Buffer.from("fake-image-data"));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns deterministic results for same input", async () => {
    const h1 = await computeHash(Buffer.from("test"));
    const h2 = await computeHash(Buffer.from("test"));
    expect(h1).toBe(h2);
  });
});

describe("hammingDistance", () => {
  it("returns 0 for identical hashes", () => {
    expect(hammingDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingDistance("ffffffffffffffff", "ffffffffffffffff")).toBe(0);
    expect(hammingDistance("abcdef0123456789", "abcdef0123456789")).toBe(0);
  });

  it("returns 1 for single-bit difference", () => {
    // 0x0000000000000001 vs 0x0000000000000000 differ in 1 bit
    expect(hammingDistance("0000000000000001", "0000000000000000")).toBe(1);
  });

  it("returns 64 for fully inverted hashes", () => {
    // 0x0000000000000000 vs 0xffffffffffffffff differ in all 64 bits
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
  });

  it("is symmetric", () => {
    const h1 = "abcdef0123456789";
    const h2 = "1234567890abcdef";
    expect(hammingDistance(h1, h2)).toBe(hammingDistance(h2, h1));
  });

  it("correctly counts differing bits for known values", () => {
    // 0x0f = 00001111, 0xf0 = 11110000 → 8 bits differ in the last byte
    expect(hammingDistance("00000000000000f0", "000000000000000f")).toBe(8);
  });
});

describe("isDuplicateByLast", () => {
  it("returns false when lastPHash is null", () => {
    expect(isDuplicateByLast("abcdef0123456789", null)).toBe(false);
  });

  it("returns false when lastPHash is undefined", () => {
    expect(isDuplicateByLast("abcdef0123456789", undefined)).toBe(false);
  });

  it("returns true for identical hashes (distance 0 <= threshold)", () => {
    expect(isDuplicateByLast("abcdef0123456789", "abcdef0123456789")).toBe(true);
  });

  it("returns true when distance equals threshold", () => {
    // Use threshold=1, hashes with distance=1
    expect(isDuplicateByLast("0000000000000001", "0000000000000000", 1)).toBe(true);
  });

  it("returns false when distance exceeds threshold", () => {
    // distance=64, threshold=8 (default)
    expect(isDuplicateByLast("0000000000000000", "ffffffffffffffff")).toBe(false);
  });

  it("respects custom threshold", () => {
    // distance=64, default threshold=8 → false, custom threshold=64 → true
    expect(isDuplicateByLast("0000000000000000", "ffffffffffffffff", 64)).toBe(true);
    expect(isDuplicateByLast("0000000000000000", "ffffffffffffffff", 63)).toBe(false);
  });

  it("returns false for threshold=0 unless hashes are identical", () => {
    expect(isDuplicateByLast("abcdef0123456789", "abcdef0123456789", 0)).toBe(true);
    expect(isDuplicateByLast("0000000000000001", "0000000000000000", 0)).toBe(false);
  });
});
