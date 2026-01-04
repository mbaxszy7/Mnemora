import { describe, it, expect, beforeEach, vi } from "vitest";
import { entityService } from "./entity-service";
import { contextGraphService } from "./context-graph-service";

// ============================================================================
// Mock Setup
// ============================================================================

// Interface to satisfy linting without using 'any'
interface MockDrizzle {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
}

function makeSelectChain(getValue: unknown) {
  const get = vi.fn(() => getValue);
  const orderBy = vi.fn(() => ({ get }));
  const where = vi.fn(() => ({ get, orderBy }));
  const from = vi.fn(() => ({ where }));
  return { from };
}

const mockDb: MockDrizzle = {
  select: vi.fn(() => makeSelectChain(null)),
  insert: vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => ({
        run: vi.fn(),
      })),
    })),
  })),
};

vi.mock("../../database", () => ({
  getDb: vi.fn(() => mockDb),
}));

vi.mock("./context-graph-service", () => ({
  contextGraphService: {
    createNode: vi.fn(),
    updateNode: vi.fn(),
  },
}));

vi.mock("../logger", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("EntityService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("normalizeAlias", () => {
    it("should collapse whitespace, trim and lowercase", () => {
      expect(entityService.normalizeAlias("  Alice   Wonderland  ")).toBe("alice wonderland");
      expect(entityService.normalizeAlias("Project-X")).toBe("project-x");
      expect(entityService.normalizeAlias("\nNew\tLine  ")).toBe("new line");
    });
  });

  describe("resolveEntities", () => {
    it("should reuse existing entity from aliases", async () => {
      mockDb.select.mockReturnValueOnce(makeSelectChain({ entityId: 101 }));

      mockDb.select.mockReturnValueOnce(makeSelectChain({ title: "Alice" }));

      const refs = [{ name: "Alice" }];
      const result = await entityService.resolveEntities(refs, "llm");

      expect(result).toHaveLength(1);
      expect(result[0].entityId).toBe(101);
      expect(result[0].name).toBe("Alice");
      expect(contextGraphService.createNode).not.toHaveBeenCalled();
    });

    it("should create new entity if not found", async () => {
      // 1. Alias lookup fails
      mockDb.select.mockReturnValueOnce(makeSelectChain(null));
      // 2. Canonical title lookup fails
      mockDb.select.mockReturnValueOnce(makeSelectChain(null));
      // 3. Mock createNode
      vi.mocked(contextGraphService.createNode).mockResolvedValue("202");
      // 4. Canonical name lookup for the new node
      mockDb.select.mockReturnValueOnce(makeSelectChain({ title: "New Entity" }));

      const refs = [{ name: "New Entity" }];
      const result = await entityService.resolveEntities(refs, "vlm");

      expect(result).toHaveLength(1);
      expect(result[0].entityId).toBe(202);
      expect(contextGraphService.createNode).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should ignore invalid entityId and fallback to resolution", async () => {
      // 1. Verify entityId fails (returns non-entity node or null)
      mockDb.select.mockReturnValueOnce(makeSelectChain({ id: 999, kind: "event" }));

      // 2. Alias lookup fails
      mockDb.select.mockReturnValueOnce(makeSelectChain(null));

      // 3. Canonical title lookup fails
      mockDb.select.mockReturnValueOnce(makeSelectChain(null));

      vi.mocked(contextGraphService.createNode).mockResolvedValue("102");

      // 4. Canonical name lookup for the new node
      mockDb.select.mockReturnValueOnce(makeSelectChain({ title: "Alice" }));

      const refs = [{ name: "Alice", entityId: 999 }];
      const result = await entityService.resolveEntities(refs, "llm");

      expect(result[0].entityId).toBe(102);
      expect(contextGraphService.createNode).toHaveBeenCalled();
    });
  });

  describe("syncEventEntityMentions", () => {
    it("should resolve entities and create edges", async () => {
      // 0. Guard lookup
      mockDb.select.mockReturnValueOnce(makeSelectChain({ kind: "event" }));

      // 1. Resolve lookup
      mockDb.select.mockReturnValue(makeSelectChain({ entityId: 101, title: "Alice" }));

      const refs = [{ name: "Alice" }];
      await entityService.syncEventEntityMentions(1, refs, "llm");

      expect(mockDb.insert).toHaveBeenCalled(); // Should insert into contextEdges
      expect(contextGraphService.updateNode).toHaveBeenCalledWith(
        "1",
        expect.objectContaining({
          entities: expect.arrayContaining([expect.objectContaining({ entityId: 101 })]),
        })
      );
    });
  });
});
