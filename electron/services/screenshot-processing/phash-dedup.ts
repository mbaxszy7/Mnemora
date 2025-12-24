/**
 * pHash Deduplication Module
 *
 * Implements perceptual hashing (pHash) for screenshot deduplication.
 * Uses DCT (Discrete Cosine Transform) to generate 64-bit hashes.
 *
 * Key features:
 * - Per-source deduplication (only compares within same source_key)
 * - Sliding window for memory-bounded comparison
 * - Configurable similarity threshold
 * - Concurrency limiting to avoid thread pool congestion
 */

import sharp from "sharp";
import { phashConfig } from "./config";

// ============================================================================
// DCT Implementation
// ============================================================================

// Pre-computed DCT cosine coefficients for 32x32 -> 8x8
const DCT_SIZE = 32;
const HASH_SIZE = 8;

// Pre-compute cosine table for DCT
const cosineTable: Float32Array = new Float32Array(DCT_SIZE * DCT_SIZE);
for (let i = 0; i < DCT_SIZE; i++) {
  for (let j = 0; j < DCT_SIZE; j++) {
    cosineTable[i * DCT_SIZE + j] = Math.cos(((2 * j + 1) * i * Math.PI) / (2 * DCT_SIZE));
  }
}

/**
 * Compute 2D DCT on a 32x32 grayscale image
 * Returns the low-frequency 8x8 coefficients (excluding DC)
 */
function computeDCT(pixels: Uint8Array): Float32Array {
  const dct = new Float32Array(HASH_SIZE * HASH_SIZE);

  // Compute 2D DCT for the low-frequency 8x8 block
  for (let u = 0; u < HASH_SIZE; u++) {
    for (let v = 0; v < HASH_SIZE; v++) {
      let sum = 0;

      for (let x = 0; x < DCT_SIZE; x++) {
        for (let y = 0; y < DCT_SIZE; y++) {
          const pixel = pixels[x * DCT_SIZE + y];
          sum += pixel * cosineTable[u * DCT_SIZE + x] * cosineTable[v * DCT_SIZE + y];
        }
      }

      // Apply DCT normalization factors
      const cu = u === 0 ? 1 / Math.sqrt(2) : 1;
      const cv = v === 0 ? 1 / Math.sqrt(2) : 1;
      dct[u * HASH_SIZE + v] = (sum * cu * cv * 2) / DCT_SIZE;
    }
  }

  return dct;
}

/**
 * Generate 64-bit hash from DCT coefficients
 * Compares each coefficient (excluding DC) to the median
 */
function generateHash(dct: Float32Array): string {
  const coefficients = Array.from(dct);

  // Calculate median excluding DC component (index 0)
  const sorted = coefficients.slice(1).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  // Generate 64-bit hash: 1 if coefficient > median, 0 otherwise
  let hash = BigInt(0);
  for (let i = 0; i < 64; i++) {
    if (coefficients[i] > median) {
      hash |= BigInt(1) << BigInt(63 - i);
    }
  }

  // Convert to 16-character hex string
  return hash.toString(16).padStart(16, "0");
}

// ============================================================================
// PHash Utility Functions
// ============================================================================

/**
 * Compute pHash for an image buffer
 *
 * Process:
 * 1. Decode and resize to 32x32 grayscale
 * 2. Compute 2D DCT
 * 3. Extract low-frequency 8x8 coefficients
 * 4. Generate 64-bit hash by comparing to median
 *
 * @param imageBuffer - Raw image buffer (PNG, JPEG, etc.)
 * @returns 16-character hex string representing 64-bit hash
 */
export async function computeHash(imageBuffer: Buffer): Promise<string> {
  // Decode, convert to grayscale, resize to 32x32
  const { data } = await sharp(imageBuffer)
    .ensureAlpha()
    .removeAlpha()
    .greyscale()
    .resize(DCT_SIZE, DCT_SIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  // Compute DCT and generate hash
  const dct = computeDCT(pixels);
  return generateHash(dct);
}

/**
 * Calculate Hamming distance between two pHash values
 *
 * Uses BigInt XOR and popcount for efficiency.
 *
 * @param hash1 - First hash (16-char hex string)
 * @param hash2 - Second hash (16-char hex string)
 * @returns Number of differing bits (0-64)
 */
export function hammingDistance(hash1: string, hash2: string): number {
  const h1 = BigInt("0x" + hash1);
  const h2 = BigInt("0x" + hash2);
  const xor = h1 ^ h2;

  // Popcount using Brian Kernighan's algorithm
  let count = 0;
  let n = xor;
  while (n > 0n) {
    n &= n - 1n;
    count++;
  }

  return count;
}

/**
 * Check if a screenshot is a duplicate compared to the last accepted hash.
 *
 * @param phash - pHash of the screenshot to check
 * @param lastPHash - Last accepted pHash for the source (if any)
 * @returns true if duplicate (should be rejected), false if unique (should be accepted)
 */
export function isDuplicateByLast(
  phash: string,
  lastPHash: string | null | undefined,
  threshold: number = phashConfig.similarityThreshold
): boolean {
  if (!lastPHash) {
    return false;
  }

  const distance = hammingDistance(phash, lastPHash);
  if (distance < threshold) {
    return true;
  }

  return false;
}
