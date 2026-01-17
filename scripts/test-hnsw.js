import hnswlib from "hnswlib-node";
import fs from "fs";
import path from "path";

async function testHnsw() {
  globalThis.console.log("Testing hnswlib-node...");

  const numDimensions = 8;
  const maxElements = 100;

  // 1. Initialize index
  // @ts-expect-error hnswlib-node typings
  const index = new hnswlib.HierarchicalNSW("l2", numDimensions);
  index.initIndex(maxElements);

  // 2. Add points
  const points = [
    [1, 1, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 0], // Close to first
    [0, 0, 0, 0, 0, 0, 0, 0], // Far
  ];

  // Labels (IDs) must be integers
  for (let i = 0; i < points.length; i++) {
    index.addPoint(points[i], i);
  }

  globalThis.console.log(`Added ${points.length} points.`);

  // 3. Search
  const query = [1, 1, 1, 1, 1, 1, 1, 1];
  const result = index.searchKnn(query, 2);
  globalThis.console.log("Search result:", result);

  // Result object has { distances: [...], neighbors: [...] }

  if (result.neighbors.length !== 2) throw new Error("Search result count mismatch");
  if (result.neighbors[0] !== 0) throw new Error("Nearest neighbor mismatch");

  // 4. Persistence
  const indexPath = path.resolve("hnsw-test.index");
  index.writeIndexSync(indexPath);
  globalThis.console.log(`Index saved to ${indexPath}`);

  // @ts-expect-error hnswlib-node typings
  const newIndex = new hnswlib.HierarchicalNSW("l2", numDimensions);
  newIndex.readIndexSync(indexPath);
  globalThis.console.log("Index loaded from disk.");

  const result2 = newIndex.searchKnn(query, 2);
  globalThis.console.log("Search result after reload:", result2);

  if (result2.neighbors[0] !== 0) throw new Error("Reloaded index search mismatch");

  // 5. Test markDelete / delete
  if (typeof newIndex.markDelete === "function") {
    globalThis.console.log("markDelete is supported.");
    newIndex.markDelete(0);
    const result3 = newIndex.searchKnn(query, 2);
    globalThis.console.log("Search result after markDelete(0):", result3);
    if (result3.neighbors.includes(0))
      globalThis.console.log(
        "WARNING: markDelete did not exclude the item from search (this is expected behavior for markDelete usually, unless filtered on search or just physically removed?)"
      );
    // hnswlib markDelete removes it from results usually
    if (result3.neighbors[0] === 0)
      throw new Error("markDelete failed to remove item 0 from top 1");
  } else {
    globalThis.console.log("markDelete NOT supported.");
  }

  // Cleanup
  try {
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
  } catch {
    void 0;
  }

  globalThis.console.log("HNSW test passed!");
}

testHnsw().catch((err) => {
  globalThis.console.error("Test failed:", err);
  globalThis.process.exit(1);
});
