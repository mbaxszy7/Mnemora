import sharp from "sharp";

const DCT_SIZE = 32;
const HASH_SIZE = 8;

const cosineTable: Float32Array = new Float32Array(DCT_SIZE * DCT_SIZE);
for (let i = 0; i < DCT_SIZE; i++) {
  for (let j = 0; j < DCT_SIZE; j++) {
    cosineTable[i * DCT_SIZE + j] = Math.cos(((2 * j + 1) * i * Math.PI) / (2 * DCT_SIZE));
  }
}

function computeDCT(pixels: Uint8Array): Float32Array {
  const dct = new Float32Array(HASH_SIZE * HASH_SIZE);
  for (let u = 0; u < HASH_SIZE; u++) {
    for (let v = 0; v < HASH_SIZE; v++) {
      let sum = 0;
      for (let x = 0; x < DCT_SIZE; x++) {
        for (let y = 0; y < DCT_SIZE; y++) {
          const pixel = pixels[x * DCT_SIZE + y];
          sum += pixel * cosineTable[u * DCT_SIZE + x] * cosineTable[v * DCT_SIZE + y];
        }
      }
      const cu = u === 0 ? 1 / Math.sqrt(2) : 1;
      const cv = v === 0 ? 1 / Math.sqrt(2) : 1;
      dct[u * HASH_SIZE + v] = (sum * cu * cv * 2) / DCT_SIZE;
    }
  }
  return dct;
}

function generateHash(dct: Float32Array): string {
  const coefficients = Array.from(dct);
  const sorted = coefficients.slice(1).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  let hash = BigInt(0);
  for (let i = 0; i < 64; i++) {
    if (coefficients[i] > median) {
      hash |= BigInt(1) << BigInt(63 - i);
    }
  }

  return hash.toString(16).padStart(16, "0");
}

export async function computeHash(imageBuffer: Buffer): Promise<string> {
  const { data } = await sharp(imageBuffer)
    .ensureAlpha()
    .removeAlpha()
    .greyscale()
    .resize(DCT_SIZE, DCT_SIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const dct = computeDCT(pixels);
  return generateHash(dct);
}

export function hammingDistance(hash1: string, hash2: string): number {
  const h1 = BigInt("0x" + hash1);
  const h2 = BigInt("0x" + hash2);
  const xor = h1 ^ h2;

  let count = 0;
  let n = xor;
  while (n > 0n) {
    n &= n - 1n;
    count++;
  }

  return count;
}

const SimilarityThreshold = 8;

export function isDuplicateByLast(
  phash: string,
  lastPHash: string | null | undefined,
  threshold: number = SimilarityThreshold
): boolean {
  if (!lastPHash) {
    return false;
  }

  const distance = hammingDistance(phash, lastPHash);
  return distance <= threshold;
}
