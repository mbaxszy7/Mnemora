import { vi } from "vitest";

type QueryStep = {
  all?: unknown[];
  get?: unknown;
  run?: unknown;
  awaited?: unknown;
};

type DbMockOptions = {
  selectSteps?: QueryStep[];
  insertSteps?: QueryStep[];
  updateSteps?: QueryStep[];
};

type QueryBuilder = {
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  groupBy: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  then: PromiseLike<unknown[]>["then"];
};

function createQueryBuilder(step: QueryStep): QueryBuilder {
  const query = {} as QueryBuilder;
  const chain = () => query;

  query.from = vi.fn(chain);
  query.where = vi.fn(chain);
  query.groupBy = vi.fn(chain);
  query.orderBy = vi.fn(chain);
  query.limit = vi.fn(chain);
  query.innerJoin = vi.fn(chain);
  query.set = vi.fn(chain);
  query.values = vi.fn(chain);
  query.returning = vi.fn(chain);
  query.get = vi.fn(() => step.get);
  query.all = vi.fn(() => step.all ?? []);
  query.run = vi.fn(() => step.run ?? { changes: 1, lastInsertRowid: 1 });
  query.then = (onfulfilled, onrejected) =>
    Promise.resolve(step.awaited ?? step.all ?? []).then(onfulfilled, onrejected);

  return query;
}

function takeStep(queue: QueryStep[] | undefined): QueryStep {
  if (!queue || queue.length === 0) {
    return {};
  }
  return queue.shift() ?? {};
}

export function createDbMock(options: DbMockOptions = {}) {
  const selectSteps = [...(options.selectSteps ?? [])];
  const insertSteps = [...(options.insertSteps ?? [])];
  const updateSteps = [...(options.updateSteps ?? [])];

  const db = {
    select: vi.fn(() => createQueryBuilder(takeStep(selectSteps))),
    insert: vi.fn(() => createQueryBuilder(takeStep(insertSteps))),
    update: vi.fn(() => createQueryBuilder(takeStep(updateSteps))),
    transaction: vi.fn((fn: (tx: typeof db) => unknown) => fn(db)),
  };

  return db;
}
