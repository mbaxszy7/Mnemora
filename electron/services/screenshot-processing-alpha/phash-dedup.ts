import crypto from "node:crypto";

export async function computeHash(imageBuffer: Buffer): Promise<string> {
  const digest = crypto.createHash("sha256").update(imageBuffer).digest("hex");
  return digest.slice(0, 16);
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

export function isDuplicateByLast(
  phash: string,
  lastPHash: string | null | undefined,
  threshold: number = 0
): boolean {
  if (!lastPHash) {
    return false;
  }

  return hammingDistance(phash, lastPHash) <= threshold;
}
