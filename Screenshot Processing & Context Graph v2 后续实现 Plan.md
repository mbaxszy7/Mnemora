# Screenshot Processing & Context Graph v2 — 后续实现 Plan（MVP=1A+2A）

本文档描述在当前代码基础上，将「截图处理 → VLM → Text LLM → Context Graph → Embedding → 本地向量检索 → IPC」打通为一个可恢复、可重试、可回溯证据的完整闭环。

## MVP 决策（已确认）

- **决策 1（1A）**：只对 `context_nodes` 生成向量文档并做 embedding（不做 screenshot snippet / batch summary 的向量化）。
- **决策 2（2A）**：本地索引使用 `hnswlib-node` 作为**独立本地向量索引**（HNSW / ANN），索引持久化到本地文件（注意：这是 native 依赖，需要评估 Electron 打包与 `electron-rebuild` 风险）。

这些决策的直接后果：

- **检索结果**以结构化的 `context_nodes` 为主（event/knowledge/state_snapshot/procedure/plan/entity_profile）。
- **可回溯证据链**固定为：`vector_documents -> context_nodes -> context_screenshot_links -> screenshots`。
- **工程复杂度上升**：需要评估 Electron 打包/原生依赖风险、索引持久化格式与兼容性、以及近似检索带来的 recall 变化（需回归测试）。

---

## 目标与 DoD（Definition of Done）

### 功能闭环

- 截图进入 DB（`screenshots`）后，通过 `BatchBuilder` 生成批次（`batches`）。
- `ReconcileLoop` 作为唯一“重任务执行引擎”推进：
  - `batches.vlmStatus: pending -> running -> succeeded`（或失败重试/永久失败）
  - VLM 结果扩写为 `context_nodes/context_edges/context_screenshot_links`
  - `context_nodes.mergeStatus` 合并完成
  - 为 `context_nodes` 生成 `vector_documents`，并完成：
    - `vector_documents.embeddingStatus`
    - `vector_documents.indexStatus`
- IPC 提供 search / traverse / getThread / getEvidence API，主功能可直接调用。

### 鲁棒性

- 支持 stale recovery（running 超时自动回滚为 pending）。
- 支持指数退避重试，超过阈值进入 `failed_permanent`。
- 幂等：重复触发同一任务不会产生重复图节点 / 重复向量文档。

### 可回溯证据

- 任意搜索结果（node）可获取其关联截图证据（至少包含：`screenshotId/ts/storageState/filePath?`）。
- Entities 归一化完成后，可作为后续 Deep Search（见 Milestone 3 拓展）中的一个集成点，用于增强检索的召回/排序；MVP 不要求实现“从 query 抽取 entities 并用于检索”的能力。

---

## 当前代码基线（关键入口/集成点）

- **主进程入口**：`electron/main.ts`
- **屏幕捕获模块**：`electron/services/screen-capture/screen-capture-module.ts`
- **截图处理门面**：`electron/services/screenshot-processing/screenshot-processing-module.ts`
- **协调循环（唯一执行引擎）**：`electron/services/screenshot-processing/reconcile-loop.ts`
- **批次构建**：`electron/services/screenshot-processing/batch-builder.ts`
- **VLM**：`electron/services/screenshot-processing/vlm-processor.ts`
- **Text LLM**：`electron/services/screenshot-processing/text-llm-processor.ts`
- **Context Graph**：`electron/services/screenshot-processing/context-graph-service.ts`
- **类型与 DTO**：`electron/services/screenshot-processing/types.ts`（包含 `SearchQuery/SearchResult/ScreenshotEvidence/PendingRecord`）
- **DB schema**：`electron/database/schema.ts`（包含 `vector_documents`）
- **IPC 类型定义**：`shared/ipc-types.ts`

---

# Milestones（按实现顺序）

## X Milestone 0 — 单一编排：ReconcileLoop 成为唯一重任务执行者（必须）

### 目的

消除 `ScreenshotProcessingModule` 直接跑 VLM/TextLLM 与 `ReconcileLoop` 重复跑导致的竞态、重复写入与不可控重试。

### 需要改动的文件

- `electron/services/screenshot-processing/screenshot-processing-module.ts`
- `electron/services/screenshot-processing/reconcile-loop.ts`

### 具体实现清单

- **[改造] ScreenshotProcessingModule：只负责落库 + 唤醒**
  - 在 `batch:ready` 事件中：
    - 继续调用 `BatchBuilder.createAndPersistBatch(...)`（保持现有落库行为）
    - **移除/禁用**任何“直接调用 `runVlmOnBatch` / `expandVLMIndexToNodes` / `textLLMProcessor.persistNodes`”的代码路径
    - 在批次落库后调用 `reconcileLoop.wake()`（见下一条）

- **[新增 public API] ReconcileLoop.wake()**
  - `wake(): void`
  - 行为：触发尽快执行一次 reconcile（例如：设置标记 + `setImmediate` 或重置 timer）
  - 目标：新 batch/screenshot 入库后无需等待 `scanIntervalMs`

### 验收标准

- 产生 batch 后，VLM/TextLLM 只会由 reconcile-loop 推进一次。
- 失败重试只发生在 reconcile-loop 的状态机内。

---

## X Milestone 1 — v2 MVP：只对 context_nodes 生成 VectorDocuments（必须）

### 目的

为 embedding/index 建立稳定的“工作队列”：`vector_documents`。

### 需要新增的类/模块

#### 1) `VectorDocumentService`

- **新增文件**：`electron/services/screenshot-processing/vector-document-service.ts`
- **职责**：
  - 从 `context_nodes` 构建统一的待嵌入文本 `textContent`
  - 计算 `textHash` 做幂等 upsert
  - 维护 `vector_documents` 状态（`embeddingStatus/indexStatus`）

- **建议 public 方法**
  - `buildTextForNode(nodeId: number): Promise<string>`
  - `buildMetaForNode(nodeId: number): Promise<Record<string, unknown>>`
  - `upsertForContextNode(nodeId: number): Promise<{ vectorId: string; vectorDocumentId: number }>`
    - 根据 `textHash` 查重（`uniqueIndex(text_hash)` 已存在）
    - 如文本变更：更新 `metaPayload/textHash/updatedAt` 并将 `embeddingStatus/indexStatus` 置回 `pending`

### 类型复用

- 复用 `electron/services/screenshot-processing/types.ts`
  - `ExpandedContextNode`
  - `SearchQuery/SearchFilters/SearchResult/ScreenshotEvidence`
- 复用 `electron/database/schema.ts`
  - `VectorDocumentRecord/NewVectorDocumentRecord`
  - `DocType`（`vector_documents.docType`）

### 数据约定（MVP）

- `vector_documents.docType`：使用你现有枚举中的 **context node 对应类型**（例如 `context_node` 或类似值；以 schema 为准）。
- `vector_documents.refId`：写入 `context_nodes.id`
- `vector_documents.metaPayload`（JSON 字符串）最少包含：
  - `nodeId`
  - `kind`
  - `threadId`（如有）
  - `eventTime`（如有）
  - `entities`（可选）
  - `sourceKey`（如现有节点/截图链路可推导则写入，否则先留空）

### 集成点（谁来调用 upsert）

- **推荐**：由 `ReconcileLoop` 在以下时机调用 `VectorDocumentService.upsertForContextNode(nodeId)`：
  - `TextLLMProcessor.persistNodes(...)` 成功写入新节点后
  - `handleSingleMerge(...)` 成功更新目标节点内容后（因为 node 文本变了，需要重算 embedding/index）

### 验收标准

- 新增或更新 `context_nodes` 后，能够产生/更新对应 `vector_documents`，并使其进入 `embeddingStatus=pending`。

---

## X Milestone 2 — Embedding + Index（2A：hnswlib-node / HNSW）并补齐 ReconcileLoop（必须）

### 目的

完成 MVP 可检索闭环：把 `vector_documents` 的文本嵌入并写入 `hnswlib-node` 本地索引（文件）以支持向量检索。

### 需要新增的类/模块

#### 1) `EmbeddingService`

- **新增文件**：`electron/services/screenshot-processing/embedding-service.ts`
- **依赖**：`AISDKService.getEmbeddingClient()`
- **public 方法**
  - `embed(text: string): Promise<Float32Array>`

#### 2) `VectorIndexService`（2A：hnswlib-node / HNSW ANN）

- **新增文件**：`electron/services/screenshot-processing/vector-index-service.ts`
- **依赖**：`hnswlib-node`
- **存储**：复用 `vectorStoreConfig.indexFilePath`（索引文件路径）
- **底层 API（对齐实现）**：
  - `new HierarchicalNSW(space, numDimensions)`
  - `initIndex(maxElements)`
  - `addPoint(vector, label)`（写入/更新行为以库实际语义为准）
  - `searchKnn(queryVector, k)`
  - `readIndexSync/readIndex` + `writeIndexSync/writeIndex`
- **ID 约定（强烈建议）**：
  - HNSW 常见实现要求 **numeric label/id**。
  - 以 `vector_documents.id` 作为索引内的 `docId`（number），避免维护额外的 string->int 映射表。
  - `vector_documents.vectorId` 继续保留为业务层稳定 ID（例如 `node:<nodeId>`）。
- **索引生命周期（MVP）**：
  - 应用启动：`load()` 尝试从 `indexFilePath` 加载（`readIndexSync/readIndex`）；如文件不存在则创建空索引
  - capacity：需要在 `initIndex(maxElements)` 指定上限。推荐策略：
    - `maxElements = 当前 vector_documents 行数 + headroom`（例如 2x 或 +5000）
    - 若超过 capacity：触发“全量重建索引”（从 DB 扫描所有 `indexStatus=succeeded` 的 embedding 重新 build）
  - 增量更新：每个 `index` subtask 成功后把该 `vector_documents.id` 与 embedding 写入索引
  - 持久化：使用 `writeIndexSync/writeIndex` 落盘；封装为 `flush()`
- **public 方法（MVP 最小集合）**
  - `load(): Promise<void>`
  - `flush(): Promise<void>`
  - `upsert(docId: number, embedding: Float32Array): Promise<void>`
  - `remove(docId: number): Promise<void>`（如不支持删除/标记删除，则先实现为 tombstone/重建策略，见下）
  - `search(queryEmbedding: Float32Array, topK: number): Promise<Array<{ docId: number; score: number }>>`
- **删除/更新的现实约束（先写清楚，避免实现时踩坑）**：
  - 如 `hnswlib-node` 不支持真正的 delete（或只支持标记删除）：
    - MVP 先不删除（`vector_documents` 也基本只增量）
    - 文本变更导致“同一 docId 更新向量”时：
      - 方案 A：允许重复向量（召回后再按 `vector_documents.id` 去重取最新 `updatedAt`）
      - 方案 B：触发“全量重建索引”（从 DB 扫描所有 `indexStatus=succeeded` 的 embedding 重新 build）
    - 以上细节以 `hnswlib-node` 的实际 API 为准，优先选“可对同 label 覆盖更新”的路径。

#### 0) 依赖可用性与打包风险验证（必须先做）

在进入 reconcile-loop 状态机实现前，先做一个最小 smoke test（目标：确保不会在 Electron/Windows 打包时翻车）：

- `import('hnswlib-node')` 在 Electron main 进程可正常加载
- 创建索引 + `addPoint` 写入一批向量 + `searchKnn` 返回结果
- save/flush 到 `indexFilePath` 后重启可 load 并继续 search
- 明确：是否支持 overwrite、是否支持 delete、是否线程安全
- 明确：Electron 打包时是否需要额外配置（例如 `electron-rebuild`、`electron-builder` 的 native 模块处理）

### 必须调整的类型（PendingRecord 扩展）

当前 `PendingRecord`（`types.ts`）只表达 `table/status/attempts/nextRunAt`，但 `vector_documents` 有两套独立状态机：

- `embeddingStatus/embeddingAttempts/embeddingNextRunAt`
- `indexStatus/indexAttempts/indexNextRunAt`

**必须做的调整（推荐）**：扩展 `PendingRecord` 增加 `subtask`：

- `subtask?: "embedding" | "index"`
- `attempts/nextRunAt` 语义取决于 subtask

### ReconcileLoop 需要补齐的逻辑

- **改动文件**：`electron/services/screenshot-processing/reconcile-loop.ts`

- **scanPendingRecords() 扫描 `vector_documents`**
  - 返回两类 record：
    - `{ table: 'vector_documents', id, status, attempts, nextRunAt, subtask: 'embedding' }`
    - `{ table: 'vector_documents', id, status, attempts, nextRunAt, subtask: 'index' }`
  - 扫描逻辑：
    - embedding：`embeddingStatus in ('pending','failed') AND (embeddingNextRunAt IS NULL OR <= now)`
    - index：`indexStatus in ('pending','failed') AND (indexNextRunAt IS NULL OR <= now) AND embeddingStatus='succeeded'`

- **processRecord() 路由**
  - `vector_documents + subtask=embedding` → `processVectorDocumentEmbeddingRecord`
  - `vector_documents + subtask=index` → `processVectorDocumentIndexRecord`（新增）

- **processVectorDocumentEmbeddingRecord（实现）**
  - 设置 `embeddingStatus=running`，更新 attempts
  - 读取 `vector_documents` 对应 refId（context node id）
  - `VectorDocumentService.buildTextForNode(refId)` 得到稳定文本
  - `EmbeddingService.embed(text)` 得到 `Float32Array`
  - 将 embedding 存入 `vector_documents.embedding`（BLOB）
  - 标记 `embeddingStatus=succeeded`，并将 `indexStatus` 置为 `pending`
  - 失败：写入 `embeddingStatus=failed`/`failed_permanent`，更新 `embeddingNextRunAt`

- **processVectorDocumentIndexRecord（新增实现）**
  - 设置 `indexStatus=running`，更新 attempts
  - 读取 `vector_documents.embedding` 并转回 `Float32Array`
  - `VectorIndexService.upsert(vectorDocumentId, embedding)`（以 `vector_documents.id` 作为索引内 docId）
  - `VectorIndexService.flush()`（MVP 可先简单每次 flush；后续再做批量 flush）
  - 标记 `indexStatus=succeeded`
  - 失败：写入 `indexStatus=failed`/`failed_permanent`，更新 `indexNextRunAt`

### 数据编码约定（embedding blob）

- `Float32Array -> BLOB`：`Buffer.from(float32Array.buffer)`
- `BLOB -> Float32Array`：`new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)`

### 验收标准

- `vector_documents.embeddingStatus` 与 `indexStatus` 均可从 pending→running→succeeded，并支持失败重试。
- HNSW index 文件生成并可 `load()` 恢复（`hnswlib-node readIndex/writeIndex`）。

---

## X Milestone 2B — 重构：VectorDocuments 独立调度（Embedding + Index 从 ReconcileLoop 剥离）（必须）

### 目的

将 `vector_documents` 的两套子任务状态机：

- `embeddingStatus/embeddingAttempts/embeddingNextRunAt`
- `indexStatus/indexAttempts/indexNextRunAt`

从 `ReconcileLoop` 中拆出来，交给一个独立的 `VectorDocumentScheduler` 管理（类似 `ActivityTimelineScheduler`）。

预期收益：

- 避免向量任务（可能大量堆积）影响 VLM/merge 的调度轮次与单轮时长。
- 更可控的 nextRun 计算与最小间隔（避免 tight loop）。
- 提供“快速唤醒”机制：当 `vector_documents` 更新为 pending 时无需等待固定 scan interval。

### 需要新增的类/模块

#### 1) `VectorDocumentScheduler`

- **新增文件**：`electron/services/screenshot-processing/vector-document-scheduler.ts`
- **职责**：
  - 独立扫描并推进 `vector_documents.embedding` 与 `vector_documents.index` 两个子任务
  - stale recovery（running 超时回滚到 pending）
  - 动态 nextRun 调度（基于 `embeddingNextRunAt/indexNextRunAt`）
  - 支持快速唤醒（wake）

- **实现要求（对齐现有 ReconcileLoop 的 aiRuntimeService 用法）**：
  - 并发上限需要参考 `aiRuntimeService.getLimit(...)`
    - embedding 并发：`aiRuntimeService.getLimit('embedding')`（并做 clamp，例如 1..10）
    - index 并发：可固定上限（例如 10），或后续也可挂到 `aiRuntimeService`（非必须）
  - embedding 的真实 API 并发控制仍由 `EmbeddingService.embed()` 内部的 `aiRuntimeService.acquire('embedding')` 兜底
    - scheduler 的并发上限属于“外层并发池”，用于降低 DB/日志/任务风暴

- **建议 public 方法**：
  - `start(): void`
  - `stop(): void`
  - `wake(reason?: string): void`（快速唤醒）

- **核心调度结构（建议与 ActivityTimelineScheduler 类似）**：
  - `scheduleSoon()`：启动后 1s 跑首轮
  - `computeEarliestNextRun()`：取 embedding/index 两类 pending/failed 的最小 nextRunAt
  - `scheduleNext()`：把 delay clamp 到 `[minDelayMs, defaultIntervalMs]`
    - `minDelayMs` 建议 5~10s（避免 earliestNextRun<=now 导致 tight loop）
    - `defaultIntervalMs` 可复用 `reconcileConfig.scanIntervalMs` 或单独加一个 `vectorDocSchedulerConfig.intervalMs`

- **核心执行步骤（runCycle）**：
  1. `recoverStaleStates()`
     - `embeddingStatus='running' AND updatedAt < staleThreshold` → `pending + embeddingNextRunAt=null`
     - `indexStatus='running' AND updatedAt < staleThreshold` → `pending + indexNextRunAt=null`
  2. `processPendingEmbeddings()`
     - 扫描条件与原 ReconcileLoop 保持一致：
       - `embeddingStatus in ('pending','failed')`
       - `(embeddingNextRunAt IS NULL OR <= now)`
       - `embeddingAttempts < retryConfig.maxAttempts`
     - 使用并发池（与 ReconcileLoop 的 `processRecordsWithConcurrency` 同思路）推进：
       - 每条记录复用原 `processVectorDocumentEmbeddingRecord` 的状态机逻辑
  3. `processPendingIndexes()`
     - 扫描条件与原 ReconcileLoop 保持一致：
       - `embeddingStatus='succeeded'`
       - `indexStatus in ('pending','failed')`
       - `(indexNextRunAt IS NULL OR <= now)`
       - `indexAttempts < retryConfig.maxAttempts`
     - 使用并发池推进：
       - 每条记录复用原 `processVectorDocumentIndexRecord` 的状态机逻辑
  4. `scheduleNext()`

- **建议实现细节（避免 index 等待下一轮）**：
  - embedding 成功会把 `indexStatus` 置为 `pending`。
  - 为减少“embedding 成功后 index 还要等下一轮”的延迟：
    - `runCycle()` 内先处理 embedding，再处理 index（同一轮就能吃到刚刚置为 pending 的 index）。

#### 2) “快速唤醒”事件机制（避免循环依赖）

- **新增文件（建议）**：`electron/services/screenshot-processing/vector-document-events.ts`
- **内容**：导出一个 `EventEmitter`（或等价轻量实现），例如：
  - 事件名：`vector-documents:dirty`
  - payload：`{ reason: string; vectorDocumentId?: number; nodeId?: number }`

- `VectorDocumentScheduler.start()`：订阅该事件，收到后调用 `wake()`
- `VectorDocumentService.upsertForContextNode(...)`：当发生 insert/update（导致 status 变为 pending）后 emit

> 说明：不要让 `VectorDocumentService` 直接 import `vectorDocumentScheduler`，否则容易造成模块循环依赖。

### 需要改动的现有代码

#### 1) 入口接入（启动/停止）

- **改动文件**：`electron/services/screenshot-processing/screenshot-processing-module.ts`
- `initialize()`：新增 `vectorDocumentScheduler.start()`
- `dispose()`：新增 `vectorDocumentScheduler.stop()`

#### 2) 从 ReconcileLoop 移除 vector_documents 相关调度

- **改动文件**：`electron/services/screenshot-processing/reconcile-loop.ts`
- **改动点**：
  - `getScanLimit()`：去掉 embedding/index worker 的贡献（只按 batch + merge 推导）
  - `computeNextRunAt()`：删除对 `vector_documents.embeddingNextRunAt/indexNextRunAt` 的 consider
  - `recoverStaleStates()`：删除对 `vector_documents` embedding/index 的 stale recovery（交给新 scheduler）
  - `scanPendingRecords()`：删除 `vector_documents` 的 embedding/index 扫描与拼接
  - `processOtherRecordsConcurrently()`：只保留 `context_nodes.merge` 分组
  - `processRecord()`：删除或保留 `vector_documents` case（建议删除，避免误调用）

#### 3) 触发快速唤醒

- **改动文件**：`electron/services/screenshot-processing/vector-document-service.ts`
- 在以下场景 emit `vector-documents:dirty`：
  - insert 新的 vector document
  - update 且 `textHash` 变化（状态被 reset 为 pending）
- payload 至少包含 `reason`（例如：`'upsert_for_context_node'`）

### 验收标准

- `ReconcileLoop` 不再扫描/执行 `vector_documents`，其 `nextRunAt` 计算不再受 embedding/index 影响。
- `VectorDocumentScheduler` 能在后台独立推进：
  - embedding pending/failed → running → succeeded/failed_permanent
  - index pending/failed → running → succeeded/failed_permanent
- `VectorDocumentService.upsertForContextNode()` 后，`VectorDocumentScheduler` 能被快速唤醒并尽快开始处理。
- 无 tight loop：即使 due task 很多，也至少等待 `minDelayMs` 再进入下一轮。

---

## X Milestone 3 — IPC：Search / Traverse / Evidence 接入主功能（必须）

### 目的

让前端/主功能能调用：语义检索、获取线程、图遍历、证据回溯。

### 需要新增 IPC channels 与 payload

- **改动文件**：`shared/ipc-types.ts`
- **新增 channels（示例命名）**：
  - `CONTEXT_SEARCH: "context:search"`
  - `CONTEXT_GET_THREAD: "context:get-thread"`
  - `CONTEXT_TRAVERSE: "context:traverse"`
  - `CONTEXT_GET_EVIDENCE: "context:get-evidence"`
- **payload/DTO（复用）**：
  - `SearchQuery` / `SearchFilters` / `SearchResult` / `ScreenshotEvidence`

### 新增服务：`ContextSearchService`

- **新增文件**：`electron/services/screenshot-processing/context-search-service.ts`
- **依赖**：
  - `EmbeddingService`
  - `VectorIndexService`
  - `ContextGraphService`
  - DB（Drizzle / getDb）
- **public 方法（建议）**
  - `search(query: SearchQuery): Promise<SearchResult>`
  - `getThread(threadId: string)`
  - `traverse(nodeId: string, depth: number, edgeTypes?: EdgeType[])`
  - `getEvidence(nodeIds: number[]): Promise<ScreenshotEvidence[]>`

### 关键实现约定（与 HNSW docId 对齐）

- `ContextSearchService.search()` 中：
  - `EmbeddingService.embed(queryText)` 得到 queryEmbedding
  - `VectorIndexService.search(queryEmbedding, topK)` 返回 `docId[]`
  - 以 `docId == vector_documents.id` 回查 `vector_documents.refId`（context node id）
  - 再通过 `ContextGraphService` / SQL 拉取 node 与证据链

### （拓展）Deep Search：LLM 增强（Query Understanding + Answer Synthesis）

#### 背景与目标

把“用户自然语言 query”变成更可控的检索，并把“检索结果（nodes/evidence）”进一步变成一个更理想的面向用户的答案。

这一扩展能力在 UI 上只需要一个选项：`Deep Search`。

- 未开启：沿用当前 search（embedding → 向量召回 → 结果级 filters）
- 开启：在一次 search 内同时启用：
  - Query Understanding（LLM 解析/格式化 query，产出 `SearchQueryPlan`）
  - Answer Synthesis（LLM 基于 nodes/evidence 合成答案，产出 `SearchAnswer`）

#### 简化的参数设计（避免复杂选项）

扩展 `SearchQuery`（位于 `shared/context-types.ts`）增加一个可选字段：

- `deepSearch?: boolean`

不引入更多可选参数（timeout、裁剪数量等用服务内部默认值即可）。

#### Query Understanding 输出

新增 DTO（是否暴露给 renderer 取决于 UI 需要；建议暴露为 debug 能力）：

- `SearchQueryPlan`
  - `embeddingText`: string
    - 用于实际 embedding 的文本（去冗余、规范化实体名、明确检索意图）
  - `filtersPatch?`: Partial<SearchFilters>
    - 从 query 中抽取出的结构化约束（推荐只包含：`timeRange/appHint/entities`），与原 filters 做 merge
    - 注意：`threadId` 属于内部上下文过滤（UI 传入），用户不会在自然语言里给出，因此 LLM 不应抽取/生成 `threadId`
  - `kindHint?`: "event" | "knowledge" | "state_snapshot" | "procedure" | "plan" | "entity_profile" | "any"
    - 不改变召回逻辑（MVP 仍向量召回），但可用于排序/裁剪输入的增强
  - `extractedEntities?`: string[]
  - `timeRangeReasoning?`: string（可选，仅 debug；注意不要返回敏感内容）
  - `confidence`: number（0~1，用于决定是否采纳 filtersPatch）

> 说明：`extractedEntities` 的主要用途之一是作为 entity-aware search 的输入（例如对 event 做 boost/扩召回）。
> 该能力依赖 Milestone 4 的 Entities 归一化（`entity_profile + entity_aliases + event_mentions_entity`），但不属于 MVP；在 Deep Search 未实现前可忽略此字段。

#### Answer Synthesis 输出

- `SearchAnswer`
  - `answerTitle?`: string（可选）
  - `answer`: string（面向用户的简洁回答/总结）
  - `bullets?`: string[]（可选要点，≤8）
  - `citations`: Array<{ nodeId?: number; screenshotId?: number; quote?: string }>
    - `quote` 仅用于 UI 展示的简短依据（可选，建议 ≤80 chars，且不得包含敏感内容）
  - `followUps?`: string[]（可选：建议追问）
  - `confidence`: number（0~1）

（可选）扩展 `SearchResult`：

- `queryPlan?: SearchQueryPlan`
- `answer?: SearchAnswer`

#### 重要说明：prompt 必须专业设计（两段 schema 都一样重要）

即使 schema 本身合理，如果 prompt 不够清晰，模型会：

- 搞错字段含义（例如把 `filtersPatch` 当成强制过滤；把 `kindHint` 当成事实）
- 产生不合规输出（非 JSON、字段缺失、超长文本、包含敏感信息）
- 在 Answer Synthesis 中出现“看似合理但无证据”的幻觉

因此必须在 prompt 中明确：

- 每个字段的语义、可选性、限制（长度/枚举/必须引用）
- 可用信息范围（只能使用输入 nodes/evidence，不得编造）
- citations 的规则（至少 1 条；无 citations 则 `confidence` 降到很低）
- 时间解析规则（提供 `nowTs/timezone`，要求输出绝对时间戳范围）

并用 `zod` 对返回 JSON 强校验，失败即回退。

#### 新增服务建议：单一 `DeepSearchService`

- **新增文件（建议）**：`electron/services/screenshot-processing/deep-search-service.ts`
- **职责**：
  - `understandQuery(...) -> SearchQueryPlan`
  - `synthesizeAnswer(...) -> SearchAnswer`
  - 统一负责：prompt 设计、schema 校验、超时控制、失败回退策略

#### 与现有 search 的集成方式（推荐数据流）

在 `ContextSearchService.search()` 中：

- 读取 `deepSearch`（来自 UI 的 `Deep Search` 选项）
- 若未开启：完全走现有逻辑
- 若开启：
  - 尝试 `queryPlan = await deepSearchService.understandQuery(...)`（内部带超时；失败回退为不理解）
  - `embeddingText = queryPlan?.embeddingText ?? queryText`
  - `filtersMerged = merge(filters, queryPlan?.filtersPatch)`（白名单字段；不得覆盖 UI 传入的 `threadId`）
  - 执行原有向量检索与 filtersMerged 过滤，得到 `SearchResult { nodes, relatedEvents, evidence }`
  - 尝试 `answer = await deepSearchService.synthesizeAnswer(...)`（内部带超时；失败则无 answer）
  - 返回 `SearchResult`（可选带上 `queryPlan/answer`）

#### 输入打包策略（尽可能多信息，但有默认上限）

目标：在 Deep Search 场景下尽可能把“有助于理解/合成答案”的信息传给 LLM，但必须设置**硬上限**，避免 tokens 与隐私风险失控。

约定：不把这些上限做成对外参数；全部使用服务内部默认值（后续如需调参再引入设置项）。

**默认硬上限（示例，按实现调优）**：

- `maxNodes = 15`
- `maxEvidence = 25`
- `maxScreenshotIdsPerNode = 8`
- `maxEntitiesPerNode = 8`
- `maxKeywordsPerNode = 10`
- `maxCharsPerNodeSummary = 600`（超出截断）
- `maxCharsTotalPayload`：以“字符预算”作为最终硬上限（超过就按优先级截断/减项）

**额外的全局摘要（低成本、高收益）**：

在不显著增加 payload 体积的前提下，建议给 LLM 增加一个 compact 的“结果摘要区”，例如：

- `resultTimeSpan`: `[minTs, maxTs]`
- `topApps`: `[{ appHint, count }]`（从 evidence 统计）
- `topEntities`: `string[]`（从 nodes.entities 聚合去重）
- `kindsBreakdown`: `[{ kind, count }]`

这样模型能更快建立全局图景，减少反复阅读全部 nodes。

**传递给 LLM 的 nodes 信息（按优先级保留）**：

- 必须：`id/kind/title/summary`
- 尽可能保留：`eventTime/threadId/keywords/entities/screenshotIds`
- 如有：可附加 `score`（向量距离/排序分数），帮助模型理解相关性强弱
- `screenshotIds` 只传前 `maxScreenshotIdsPerNode` 个（按时间倒序或去重后顺序）
- 所有长文本字段都要截断（以 `maxCharsPerNodeSummary` 为准）

**传递给 LLM 的 evidence 信息（尽可能多，但脱敏）**：

- 默认包含：`screenshotId/ts/appHint/windowTitle/storageState`
- `filePath`：不传完整绝对路径。若确实需要给模型“文件线索”，只传脱敏后的 `fileName`（basename）或 `pathHint`（例如仅最后 1~2 段路径），并避免包含用户名/主目录等敏感信息
- 高价值文本（在严格预算内尽可能提供）：
  - `ocrText`：只传截断后的 `ocrTextExcerpt`（例如前 500~1500 chars，去除连续空白；超过截断）
  - `uiTextSnippets`：只传 Top N（例如 10~20 条；每条截断到 80~120 chars；去重）
  - `vlmIndexFragment`：只传关键字段或截断后的片段（避免整段 JSON 过大）
- evidence 数量超过 `maxEvidence` 时，优先保留：
  - 与 top nodes 关联度高的 screenshotId（出现在这些 nodes 的 screenshotIds 中）
  - 时间更接近 queryPlan.timeRange 的证据（若存在）
  - `ts` 更新的证据（fallback）

**去重与裁剪策略（避免无节制）**：

- 节点：按向量检索排序取前 `maxNodes`，必要时对同一 `threadId` 做轻量去重（避免全部来自同一个 thread）
- 证据：对 screenshotId 去重
- 最终以 `maxCharsTotalPayload` 做兜底：超出则按以下优先级裁剪：
  - 先删 evidence 的可选文本：`vlmIndexFragment` → `uiTextSnippets` → `ocrTextExcerpt`
  - 再减少 evidence 数量（保留与 top nodes 关联最强的）
  - 再减少 nodes 数量（保留 top score 的）
  - 最后再对 nodes.summary 做更激进的截断

**不传的内容（MVP 默认）**：

- 截图图像内容
- OCR 原文的全量内容（只传 excerpt；且必须受字符预算控制）
- 大段、不可控体量的原始文本（所有文本字段都必须截断/去重后再进入 payload）

#### 风险与治理（保持简洁但必须明确）

- **延迟**：Deep Search 会多 1~2 次 Text LLM 调用；必须允许超时回退。
- **成本**：Deep Search 才产生额外 tokens；默认不开启。
- **幻觉**：Answer 必须 citations；否则视为低可信。
- **隐私**：严格最小化输入；不落库 prompt/response。

### 新增 IPC handlers

- **新增文件**：`electron/ipc/context-graph-handlers.ts`
- 统一返回 `IPCResult<T>`，错误用 `toIPCError`

### main 注册

- **改动文件**：`electron/main.ts`
- 注册新的 handler（与 `vlm-handlers` 同风格）

### 验收标准

- 前端调用 `context:search` 可以得到 `SearchResult`，且 `evidence` 可回溯到截图。

---

## X Milestone 4 — Entities 归一化：entity_profile + aliases + event_mentions_entity（必须）

### 目标

让 “entities” 从当前的 JSON 字段（`screenshots.detectedEntities` / `context_nodes.entities`）升级为**可索引、可消歧**的结构化能力。

核心要求（MVP）：对 `context_nodes(kind='event')` 中的 `entities`（以及可选的 VLM 候选）完成归一化落库：

- 以 `context_nodes.kind = entity_profile` 作为 canonical entity
- 以 `entity_aliases` 存 alias -> entity_profile 映射
- 以 `context_edges.edge_type = event_mentions_entity` 建立 `event -> entity_profile` 结构化关联

备注：后续若要将 query 中抽取的 entities 用于检索增强，属于 Milestone 3（拓展）Deep Search 的集成点。

### 设计决策（建议推翻“把 VLM/LLM entities 合并进 event JSON 就够了”的想法）

- **不把 VLM/LLM 的原始 entities 视为权威事实**：
  - `screenshots.detectedEntities` 作为 EvidencePack 的“原始候选”，用于可追溯与回看（可能噪声大、可能跨截图泛化）。
  - `context_nodes.entities` 作为“事件/节点层”的抽取结果（更接近用户意图），但依然只是文本引用。
- **权威 entity 必须有稳定 ID（可索引）**：
  - 使用现有 `context_nodes.kind = entity_profile` 作为实体维表（canonical entity）。
  - 使用现有 `entity_aliases` 存 alias -> entity_profile 的映射（消歧/归一化入口）。
- **event 与 entity 的关联必须结构化**：
  - 使用现有 `context_edges.edge_type = event_mentions_entity` 建立 `event -> entity_profile` 的关系。
  - `context_nodes.entities` 继续保留（方便向量 meta/展示），但它是冗余字段；**查询与反查以 edges + aliases 为主**。

### 需要新增的类/模块

#### 1) `EntityService`（实体解析与补边）

- **新增文件**：`electron/services/screenshot-processing/entity-service.ts`
- **职责**：
  - 从 `EntityRef[]` 解析/归一化为 `entity_profile` 节点（创建或复用）
  - 写入 `entity_aliases`
  - 建立/同步 `event_mentions_entity` 边
  - 将 event 节点的 `entities` 回填 `entityId`（可选但强烈推荐，方便 UI 与向量 meta）

- **建议 public 方法**：
  - `normalizeAlias(name: string): string`
    - 建议：`trim` + `toLowerCase` + collapse whitespace
  - `resolveEntities(entityRefs: EntityRef[], source: 'vlm' | 'llm' | 'manual' | 'ocr'): Promise<EntityRef[]>`
    - 为每个 `EntityRef` 补齐 `entityId`（必要时创建 `entity_profile`）
    - 返回 canonical 化后的 `EntityRef[]`（name 建议回填为 canonical title）
  - `syncEventEntityMentions(eventNodeId: number, entityRefs: EntityRef[], source: 'vlm' | 'llm'): Promise<void>`
    - 解析 entityRefs 得到 entityId
    - `INSERT OR IGNORE` 写入 `context_edges(eventNodeId -> entityId, edge_type='event_mentions_entity')`
    - 回写 event 节点 `entities`：为每个 ref 补齐 `entityId`

### 必须改动的现有代码路径

#### 1) Text LLM 输入侧：把 VLM 的 entity 候选显式传入

- **改动文件**：`electron/services/screenshot-processing/text-llm-processor.ts`
- **改动点**：`buildExpandPrompt(...)`
- **原因**：目前 prompt 只传 `segments` 与 `evidencePacks`，Text LLM 看不到 `vlmIndex.entities` 的 batch-level 候选，导致产出的 entities 更不稳定。
- **做法**：在 prompt 中新增：
  - `## VLM Entities (batch-level candidates)`
  - `${JSON.stringify(vlmIndex.entities, null, 2)}`

#### 2) Text LLM 落库后：统一做“实体解析 + 补边 + 回填 entityId”

- **改动文件**：`electron/services/screenshot-processing/text-llm-processor.ts`
- **改动点**：`persistNodes(...)`
- **做法**：
  - 创建完某个 `event` node 后，立刻调用 `EntityService.syncEventEntityMentions(eventId, entities, 'llm')`
  - 再继续创建 derived nodes（derived nodes 是否也补边，MVP 可先不做）

#### 3) Merge 后的实体一致性

- **改动文件**：`electron/services/screenshot-processing/reconcile-loop.ts`
- **改动点**：`handleSingleMerge(...)` 更新 target node 后追加：
  - `EntityService.syncEventEntityMentions(targetId, mergedEntities, 'llm')`
- **原因**：merge 会改变 event 的 `entities` JSON，如果不同步 `event_mentions_entity` 边，entity 反查会缺漏。

### 兼容与回填（必须，避免“旧数据不可反查”）

- **目标**：对已有 `context_nodes(kind='event')` 中的 `entities` JSON（如果存在）进行一次性回填，补齐：
  - `entity_profile` 节点
  - `entity_aliases`
  - `event_mentions_entity` 边
- **推荐实现方式（MVP）**：新增一个一次性脚本/命令式入口（不进 ReconcileLoop 状态机）
  - 输入：起始时间范围或 nodeId 范围
  - 逻辑：遍历 event 节点，读取 `entities`，对每个 entity 执行 `EntityService.syncEventEntityMentions(eventId, entities, 'llm')`
  - 幂等：
    - `context_edges` 已有 `(from,to,type)` unique index，可用 `INSERT OR IGNORE`
    - `entity_aliases` 需要补 unique 约束（见下一条）

### 建议的 DB 约束（可选但强烈建议）

- **问题**：当前 `entity_aliases` 只有普通 index，没有唯一约束，容易产生重复 alias 行，且无法对 `(entity_id, alias)` 使用 `ON CONFLICT DO NOTHING`。
- **建议迁移**：新增 unique index
  - `CREATE UNIQUE INDEX idx_entity_aliases_entity_alias_unique ON entity_aliases(entity_id, alias);`
- **注意**：如果你希望同一个 alias 指向多个 entity（歧义），这个 unique 仍然允许（因为 entity_id 不同）。

### 验收标准

- 给定一个 alias（例如：`ABC-123` / `Alice` / `Mnemora`）：
  - 能找到或创建对应 `entity_profile`
  - 能查到所有提及该 entity 的 `event`（通过 `event_mentions_entity` 边）
  - 能通过 `context_screenshot_links` 继续回溯到 `screenshots` 证据
- 对新写入/新 merge 的 event，`entities` 中的 `entityId` 会被稳定回填。

---

## X Milestone 5 — LLM 用量统计（按模型）+ Settings 页面展示 + Tray 展示（必须）

### 目的

为应用提供**可计量、可审计、可按模型拆分**的 AI 调用用量观测能力：

- 能看见：
  - 每日/近 7 天/本月 **tokens 与调用次数**
  - 按 **capability（VLM/Text/Embedding）** 拆分
  - 按 **model** 拆分
  - 失败调用的次数与错误分布
- 能在 **Settings** 页面查看明细与汇总，并可跳转/导出
- 能在 **Tray** 快速查看“今日用量”

### 非目标（明确避免）

- 不在 DB 中保存 prompt/response 原文（避免隐私与体量问题）
- 不在 MVP 阶段实现精确 tokenizer 估算（以 provider 返回的 usage 为准；没有 usage 时允许记录为 unknown）

---

### 数据来源与口径（重要）

当前调用链路涉及：

- `VLMProcessor`：`generateText()`（vision/text completion）
- `TextLLMProcessor`：`generateText()`（text completion）
- `EmbeddingService`：`embed()`（embedding）

设计约定：

- **优先使用 provider 返回的 usage**（例如 OpenAI-compatible 响应中的 tokens 字段/usage 对象）。
- 若 provider 不返回 usage：
  - 仍记录一次 `llm_usage_events`（标记 `usageStatus='missing'`），用于统计“调用次数/失败率”。
  - tokens 可为空（后续增强可补 tokenizer 估算）。

#### 配置变更的“重置”口径（必须）

- 需求：当用户修改大模型配置后，**统计口径默认重置到“新配置”**，但历史数据需要保留。
- 设计：对每次调用记录写入一个 `configHash`（由当前 LLMConfig 的关键字段计算出的 hash，例如：mode + endpointRole + baseUrl + model 的组合）。
  - UI 默认只展示“最新 `configHash`”的统计数据（等价于重置）。
  - 用户可在 UI 中选择旧的 `configHash` 查看历史。

---

### 需要新增的 DB 表（建议）

> 说明：下面为设计草案，字段名与类型以 Drizzle/SQLite 实际落地为准。

#### 1) `llm_usage_events`（事实表：每一次 LLM/Embedding 调用一行）

- `id`（PK）
- `ts`（number，毫秒时间戳）
- `capability`：`'vlm' | 'text' | 'embedding'`
- `operation`：
  - `vlm_analyze_shard`（VLM shard 级）
  - `text_expand`（TextLLM expand）
  - `text_merge`（TextLLM merge）
  - `embedding_node`（context node embedding）
  - 允许扩展
- `status`：`'succeeded' | 'failed'`
- `errorCode`（可空；失败时写入内部错误分类，不写敏感信息）

- **模型与路由维度**
  - `provider`（可选：`'openai_compatible' | 'unknown'`）
  - `configMode`：`'unified' | 'separate'`（来自 LLMConfig）
  - `endpointRole`：`'unified' | 'vlm' | 'text' | 'embedding'`（来自 LLMConfig）
  - `baseUrlHash`（string；对 baseUrl 做 hash，避免直接暴露私有域名；也便于聚合）
  - `model`（string；例如 `gpt-4o-mini`/`text-embedding-3-large`）
  - `configHash`（string；用于配置变更后的口径“重置”与历史保留）

- **用量字段（尽量与 OpenAI usage 对齐，允许为空）**
  - `promptTokens`（number|null）
  - `completionTokens`（number|null）
  - `totalTokens`（number|null）
  - `embeddingTokens`（number|null；embedding 场景可用）
  - `inputImageCount`（number|null；VLM 场景可用）
  - `inputChars`（number|null；可选，便于后续 tokenizer 估算/回归）
  - `outputChars`（number|null；可选）
  - `usageStatus`：`'present' | 'missing'`

- **幂等/关联字段（可选但推荐）**
  - `traceId`（string；一次高层任务贯穿多次调用，如 batchId/shardId/vectorDocumentId）
  - `refTable/refId`（可选：`'batches'|'vector_documents'|'context_nodes'` + id）

- **索引建议**
  - `idx_llm_usage_events_ts`
  - `idx_llm_usage_events_capability_ts`
  - `idx_llm_usage_events_model_ts`
  - `idx_llm_usage_events_status_ts`

#### 2) `llm_usage_daily_rollups`（聚合表：按天汇总，避免每次打开 UI 都扫全表）

- `day`（string，例如 `YYYY-MM-DD`，PK 或 unique）
- `capability`（同上）
- `model`（string）
- `endpointRole`（同上）
- `requestCountSucceeded` / `requestCountFailed`
- `promptTokensSum` / `completionTokensSum` / `totalTokensSum` / `embeddingTokensSum`
- `updatedAt`

---

### 聚合策略（何时写 rollup）

推荐两级策略：

- **写事件**：每次调用结束（成功/失败）立刻写入 `llm_usage_events`。
- **写 rollup**（可选实现方式）：
  - 方式 A（简单）：打开 Settings 页面时按需聚合“最近 N 天”，并缓存写入 `llm_usage_daily_rollups`。
  - 方式 B（更稳）：`ReconcileLoop` 或独立轻量 `UsageRollupService` 定时（例如每 10 分钟）增量聚合。

MVP 推荐方式 A，减少后台任务复杂度。

---

### IPC 设计（主进程提供给渲染进程）

改动文件：`shared/ipc-types.ts` + 新增 handlers（与 `llm-config-handlers` 同风格）。

#### 新增 channels（示例命名）

- `USAGE_GET_SUMMARY: "usage:get-summary"`
- `USAGE_GET_DAILY: "usage:get-daily"`
- `USAGE_GET_BREAKDOWN_BY_MODEL: "usage:get-breakdown-by-model"`
- `USAGE_GET_BREAKDOWN_BY_CAPABILITY: "usage:get-breakdown-by-capability"`
- `USAGE_EXPORT_CSV: "usage:export-csv"`（可选；也可在 renderer 端导出）

#### Payload/DTO（建议）

- `UsageTimeRange`：`{ fromTs: number; toTs: number; timezone?: string }`
- `UsageSummary`：
  - `totalTokens?`
  - `succeededCount` / `failedCount`
- `UsageBreakdownItem`：
  - `model`
  - `capability`
  - `totalTokensSum?`
  - `succeededCount` / `failedCount`

IPC 返回统一使用 `IPCResult<T>`。

---

### Renderer UI（Settings 页面）

设计建议：

- 在 `Settings` 页面新增入口卡片：
  - 标题：`LLM Usage`
  - 描述：`Track token usage by model`
  - 点击进入详情页（推荐新增 route：`/settings/usage`）

详情页（`UsagePage`）展示内容：

- 顶部汇总：今日 / 近 7 天 / 本月
- Breakdown：
  - 按 model
  - 按 capability
- 失败统计：失败数 + 最近错误类型（不暴露敏感错误）
- 导出：CSV（可选）

i18n：在 `shared/locales/en.json` 与 `zh-CN.json` 增加 `usage.*` 文案。

---

### Tray 展示

目标：在 tray 菜单中增加一行可读信息，快速查看当前用量。

- 示例：
  - `Usage today: 12.4k tokens`
  - 若 tokens 缺失：`Usage today: 18 requests`

交互：

- 点击该项打开 `/#/settings/usage`（或直接打开 Settings 并定位到 usage 区块）。

---

### 隐私、安全与数据保留

- 不保存：prompt、response、图片内容、OCR 原文（这些已有各自的存储路径；usage 只记录计量信息）。
- `baseUrl` 不明文存储在 usage 表（存 `baseUrlHash`）。
- 错误信息只存“错误码/分类”，避免把 provider 返回的敏感信息落库。
- 数据保留策略（建议）：
  - `llm_usage_events`：保留 90 天（可配置）
  - `llm_usage_daily_rollups`：长期保留

---

### 验收标准（DoD）

- Settings 页面可查看：
  - 今日/近 7 天/本月的用量汇总
  - 按 model 的用量排行
  - 按 capability 的用量拆分
- Tray 菜单可显示“今日用量（tokens 优先，其次次数）”，并可点击跳转。
- 记录口径清晰：
  - VLM/Text/Embedding 三类调用均会产生日志事件
  - usage 缺失时不会阻塞主流程
- 不落库任何敏感内容（prompt/response/图片）。

---

## Milestone 6 — Activity Monitor（20min summary + 长事件标记 + event details + 搜索 + 设置）

### 目的

- 把 `Home.tsx` 变成主界面：展示最近 24 小时的时间线 + 每 20 分钟的 activity summary。
- summary 由 LLM 分析生成（prompt 设计见「Summary 生成」）；右侧同时展示该 20min window 内的事件列表（一个 window 可能包含多个事件；events 来源于 `activity_events` 的时间重叠查询）。
- “长事件”标记不让 LLM 直接判断：后端根据事件在 DB 中的聚合时间跨度计算（例如 `durationMs >= 30min`），用于时间线 marker。
- 长事件点击进入 details 界面（details 由 LLM 分析生成；推荐按需生成）。
- 顶部支持自然语言搜索，复用 `context:search`，支持可选 Deep Search；不做 24h 限制（UI 可默认 `timeRange=last24h` 作为快捷过滤）。右上角 Settings 按钮，点击打开 Settings 页面。
- 后台自动生成与推送：每 20 分钟生成/补齐窗口 summary，并通过 IPC 推送前端增量更新。

### DB 设计（重新设计并新增表）

- **改动文件**：`electron/database/schema.ts`

- **[改造] `activity_summaries`（一行一个 20min window）**
  - 目标：成为 Activity Monitor 的 source of truth（窗口级 summary + 左侧 24h timeline block 的最小展示单元）。
  - 字段建议：
    - `id`
    - `windowStart` / `windowEnd`（毫秒时间戳）
    - `idempotencyKey`（建议：`<windowStart>-<windowEnd>`；如需口径隔离可叠加 `configHash`）
    - `title`（一句话标题；用于左侧 timeline block 展示）
    - `summary`（正文，建议用 markdown）
    - `highlights`（可选 JSON：bullets/tags）
    - `stats`（可选 JSON：`{ topApps[], topEntities[], nodeCount, screenshotCount, threadCount }` 等；用于左侧展示“活跃 app name”等）
    - `status/attempts/nextRunAt/errorCode/errorMessage`
    - `createdAt/updatedAt`

- **[新增] `activity_events`（跨窗口事件 session：marker + details）**
  - 目标：支撑 24h 时间线上的事件展示与“长事件标记”，并承载 details 的生成状态。
  - 核心原则：
    - `isLong` 不能由 LLM 直接输出；必须由后端按数据规则计算（例如 `durationMs >= 30min`）。
  - 字段建议：
    - `id`
    - `eventKey`（string；unique；事件 session 的幂等键；建议：`hash(<threadId> + ':' + <sessionStartWindowStart>)`；同一 `threadId` 在一天内允许产生多个 session）
    - `startTs` / `endTs`（毫秒时间戳）
    - `durationMs`（冗余字段，便于排序/过滤）
    - `title`（短标题）
    - `kind`（string；例如 `focus/work/meeting/break/unknown`，先不强枚举）
    - `confidence` / `importance`（0-10 或 0-100，口径与 `context_nodes` 保持一致即可）
    - `threadId`（可选：来自 `context_nodes.threadId`；用于跨 window 聚合与证据回溯）
    - `nodeIds`（可选 JSON：关联 `context_nodes.id[]`，用于证据回溯）
    - `isLong`（boolean；由后端按 `durationMs` 计算，用于 UI marker）
    - `detailsStatus/detailsAttempts/detailsNextRunAt/detailsErrorCode/detailsErrorMessage`
    - `details`（可选：markdown/json；如担心字段过大可拆表，见下一条）
    - `createdAt/updatedAt`

- **（可选）[新增] `activity_event_details`**
  - 如果担心 `activity_events` 频繁更新大字段/多版本，建议把 details 独立拆表（`eventId` + `details` + `metadata` + timestamps）。

- **索引建议**
  - `idx_activity_summaries_window(windowStart, windowEnd)`
  - `idx_activity_events_time(startTs, endTs)`
  - `idx_activity_events_event_key(eventKey)`（unique）
  - `idx_activity_events_thread(threadId, startTs)`（可选）
  - `idx_activity_events_is_long(isLong, startTs)`

### 后端逻辑（生成、存储、推送、查询）

- **改动/新增文件（建议）**
  - `electron/services/screenshot-processing/config.ts`：把 `activitySummaryConfig.generationIntervalMs` 改为 `20min = 1200000`
  - `electron/services/screenshot-processing/reconcile-loop.ts`：把 activity summary / event details 纳入 reconcile 状态机（避免新的“重任务执行引擎”）
  - 新增服务（命名建议二选一，避免拆散逻辑）：
    - `electron/services/activity-monitor/activity-monitor-service.ts`
    - 或放在 `electron/services/screenshot-processing/activity-monitor-service.ts`
  - 新增 handlers：`electron/ipc/activity-monitor-handlers.ts`
  - `electron/main.ts`：注册 handlers
  - `electron/preload.ts`：暴露 `activityMonitorApi`

- **窗口划分**
  - 对齐到 20min 边界（使用本地时区；需要在 payload 中提供 `nowTs/timezone` 给 LLM 时明确）。
  - 只处理 `windowEnd <= now - safetyLagMs` 且未 `succeeded` 的窗口；支持补齐漏跑窗口。

- **Summary 生成（LLM，20min window）**
  - 说明：summary 必须由 LLM 生成；prompt 需要稳定产出可解析 JSON（严格 schema），参考 `realtime_activity_monitor` 的写法（字段约束 + 强制 JSON-only）。
  - 输入（基于现有数据能力）：
    - window 时间信息：`windowStart/windowEnd/nowTs/timezone`
    - window 内 `context_nodes`（建议不要只传 `kind='event'`；至少要把 window 内所有「可能成为证据」的 nodes 都传入，且每个 node 必须包含 `kind` 字段，便于 LLM 分类到不同 section）：
      - 最小字段：`{ id, kind, title, summary, threadId?, eventTime?, entities?, importance?, confidence? }`
      - 若希望 `summary` 的 **Documents** section 可落地（不编造），强烈建议额外提供可引用的文档证据字段（如果你现有 node schema 已有就直接透传；没有的话由后端预聚合一个 `documents` 列表也可以）：
        - `documents[]`（可选，后端预聚合；来自 document/file 类型 nodes 或截图 OCR 命中的文件名/URL）：`{ title, ref, nodeId, sourceApp? }`
        - 推荐构建方式（你在 `vlm-processor.ts` 已经要求浏览器场景必须抽取 URL，因此这里可以稳定落地）：
          - 从 VLM 输出的 `segments[].derived.knowledge[]` 中抽取：如果 `knowledge.summary` 包含形如 `Source URL: <url>` 的子串，则 `ref=<url>`，`title=knowledge.title`。
          - `sourceApp` 可来自同 batch 的 `screenshots[].app_guess.name`（例如 `Google Chrome`/`Arc`），用于 UI 展示“来源 app”。
          - `nodeId` 必须指向输入 `context_nodes.id` 中对应的 knowledge/document/file node（若当前还没有把 derived.knowledge 落成 node，则建议后端先落库生成 node，再把 nodeId 透传给 summary LLM；否则不要把该 documents item 传给 LLM，避免无法引用）。
        - 约束：LLM 只能在 Documents section 引用该 `documents[]` 或 `kind='document'`/`kind='file'` 的 nodes；不得凭空生成文件名/链接。
    - window 内聚合统计（由代码预聚合，不依赖 LLM 推断）：
      - `topApps`（建议来自 `screenshots.appHint`）
      - `topEntities`（来自 `context_nodes.entities` 或 `screenshots.detectedEntities` 的聚合）
      - `nodeCount/screenshotCount/threadCount`
  - 输出（严格 JSON schema；不要输出任何解释文字）：
    - `title`（<= 30 chars；用于左侧 timeline block）
    - `summary`（markdown；用于右侧详情；必须使用下述固定结构，保证 UI 稳定渲染与可读性）：
      - 必须按顺序包含且仅包含这四个一级分区（建议用 `##` 标题）：
        - `## Core Tasks & Projects`
        - `## Key Discussion & Decisions`
        - `## Documents`
        - `## Next Steps`
      - 每个分区必须是 bullet list；若该分区没有可靠证据，输出单条 `- None`（不要省略标题，也不要编造）。
      - 强约束（防幻觉）：除 `stats` 里的聚合项外，`summary` 内每一条 bullet 必须至少引用一个输入里的 `context_nodes.id`（例如在末尾加 `(node: <id>)`），否则输出 `- None`。
    - `highlights`（string[]；可选）
    - `stats`（object；推荐透传/轻量纠错，不要编造 app/entity）
    - `events[]`（该 20min window 内事件列表；一个 window 可能包含多个事件）：
      - item schema：`{ title, kind, startTs, endTs, threadId?, nodeIds?, confidence?, importance? }`
      - 约束：
        - `startTs/endTs` 必须落在 `[windowStart, windowEnd]`
        - `nodeIds` 必须来自输入的 `context_nodes.id`
        - `threadId` 必须来自输入的 `context_nodes.threadId`（如无可不填）
      - 注意：不要输出 `isLong`；长事件由后端按 DB 聚合后的 `durationMs` 计算（例如 `>= 30min`）。
  - 失败处理：使用 `extractAndParseJSON` + zod 强校验；失败时进入 failed 重试（避免写入不可解析文本导致口径不一致）。
  - Prompt 草案（示例，参考 `realtime_activity_monitor` 结构）：
    - `activity_summary_window_20min.system`：
      - 角色：专业的活动分析助手
      - 分析维度：Application Usage / Content Interaction / Goal Behavior / Activity Pattern / Event extraction
      - 强约束：输出必须且只能是 JSON；不得输出任何解释文字；字段必须满足下方规范；不得编造 app/entity/nodeId/threadId/document
      - 你只能使用输入中提供的 `context_nodes`、`documents`、`stats` 作为事实来源；如果证据不足，输出 `None`。
      - `summary` 字段必须严格遵循四分区 markdown 模板（见 user prompt 中的模板）。
    - `activity_summary_window_20min.user`：
      - 提供 `{current_time}/{window_start}-{window_end}/{timezone}`
      - 提供 window 内 `context_nodes` +（可选）`documents` + 预聚合 `stats`
      - 要求按 schema 返回 JSON（无解释文本）
      - 建议直接把以下内容作为 user prompt 模板（其中 JSON schema 用于约束输出结构；markdown 模板用于约束 `summary` 格式）：
        - JSON schema（概念性；实现中用 zod 强校验即可）：
          - `{ title: string, summary: string, highlights?: string[], stats?: object, events: Array<{ title: string, kind: string, startTs: number, endTs: number, threadId?: string, nodeIds?: string[], confidence?: number, importance?: number }> }`
        - `summary` markdown 模板（必须严格一致，且每条 bullet 尾部带 node 引用）：
          - `## Core Tasks & Projects`\n`- <...> (node: <id>)`\n`## Key Discussion & Decisions`\n`- <...> (node: <id>)`\n`## Documents`\n`- <title> — <ref> (node: <id>)` 或 `- None`\n`## Next Steps`\n`- <...> (node: <id>)` 或 `- None`

- **事件聚合（DB 规则；跨 window 聚合为 session）**
  - LLM 只负责产出「该 window 内的事件候选列表」；事件是否跨窗口、是否为长事件，都由后端规则完成。
  - 对每个 `events[]` item（window 内事件片段）：
    - 设置 `mergeGapMs`（建议 5min）：仅当新片段与同一 `threadId` 的最近 session 满足连续性（例如 `event.endTs >= item.startTs - mergeGapMs`）时才进行跨 window 合并，避免把同主题但不连续的活动误合并。
    - 生成 `eventKey`（session 幂等键）：
      - 若有 `threadId`：
        - 先尝试查找可续写的 session：`threadId=item.threadId AND endTs >= item.startTs - mergeGapMs`（取 endTs 最大的一条）
        - 若找到：复用该 session 的 `eventKey`
        - 若未找到：新建 session，`eventKey = hash(threadId + ':' + windowStart)`（或直接拼接；必要时 hash）
      - 若无 `threadId`：不做跨 window 合并，`eventKey = hash(normalize(kind + title) + ':' + windowStart)`
    - upsert `activity_events`（按 `eventKey`）：
      - 若 `eventKey` 已存在：
        - `startTs = min(old.startTs, item.startTs)`
        - `endTs = max(old.endTs, item.endTs)`
        - `nodeIds` 取并集（可做去重/裁剪）
      - 若不存在：创建新 event
    - 计算并写回：
      - `durationMs = endTs - startTs`
      - `isLong = durationMs >= 30min`

- **长事件详情（LLM）**
  - 推荐策略：lazy on-demand（用户点击事件时才生成），写回 `activity_events.details*`。
  - 输入：event 的 `nodeIds/threadId` 反查 nodes + evidence packs（严格裁剪/脱敏；复用 Deep Search 的裁剪策略）。
  - 输出：details markdown + citations（`nodeId/screenshotId`）。

- **Push（renderer 实时更新）**
  - 当 summary / event details 状态变化后：main 进程 `webContents.send("activity-monitor:updated", payload)`。
  - renderer 订阅后增量刷新 timeline/当前窗口内容。

- **查询 API（IPC）**
  - `activity:get-timeline({ fromTs, toTs })`：返回指定时间范围内的 20min window 列表（用于左侧 24h timeline）+ long event markers。
    - window 最小字段建议：`{ windowStart, windowEnd, title, stats.topApps }`
    - long event markers：查询 `activity_events` 中 `isLong=true` 且与 `[fromTs,toTs]` 有重叠的 events（建议返回 `id/title/startTs/endTs/durationMs/kind`）。
  - `activity:get-summary({ windowStart, windowEnd })`：返回该 window 的 summary（右侧详情）+ 该 window 内 events 列表。
    - events 列表建议按「时间重叠」查询 `activity_events`，并在返回时做 window clamp：
      - `segmentStartTs = max(event.startTs, windowStart)`
      - `segmentEndTs = min(event.endTs, windowEnd)`
      - `isLong` 直接取 DB 中按规则计算后的结果（`durationMs >= 30min`）。
  - `activity:get-event-details({ eventId })`：返回 event details（如未生成可触发生成并返回 running 状态）。
  - 搜索：复用 `context:search`（Milestone 3），支持可选 `timeRange` 过滤但不做时间硬限制；UI 可默认 `timeRange=last24h` 作为快捷范围，并允许清除/自定义；支持 `deepSearch` toggle。

### 前端（Home.tsx 主界面 + details route）

- **改动/新增文件（建议）**
  - `src/pages/Home.tsx`：Activity Monitor 主界面
  - `src/router/index.tsx`：新增 route（例如：`/activity/events/:eventId`）
  - 新增页面（可选）：`src/pages/ActivityEventDetails.tsx`
  - 复用现有 `/settings` 页面；Home 顶部齿轮按钮跳转到 `/settings`

- **布局（参考目标截图）**
  - 顶部：Search bar（自然语言） + Deep Search toggle（可选） + 右上角 Settings。
  - 主体：左右分栏
    - 左：24h timeline（只展示 24h；窗口可点击；长事件 marker 可点击）。
      - 每个 20min block 展示：`时间范围 + summary.title + 活跃 app name（来自 stats.topApps，取 top1~top3）`
    - 右：选中窗口的详细展示内容：
      - `summary`（markdown）+ `highlights/stats`（如有）
      - events 列表（一个 window 可能有多个 events）
        - 每个 event 展示：`title/kind/segment 时间范围`，并通过查询 DB 得到 `durationMs/isLong`
        - `isLong=true` 的 event 展示“查看详情”（进入 details route 或在右侧进一步展开）

### 验收标准

- 运行中每 20 分钟自动生成一条 summary（或补齐缺失窗口），写入 DB，且 Home 页面无需刷新即可看到更新。
- 24h timeline 可展示窗口与长事件标记；点击长事件可进入 details 页面并看到 LLM 生成内容（允许首次为 loading）。
- 搜索框支持自然语言检索，不做时间硬限制（UI 可默认 `timeRange=last24h`，并允许清除/自定义）：
  - 关闭 deepSearch：返回 nodes/evidence
  - 开启 deepSearch：返回 answer/citations（失败可回退不影响 nodes/evidence）
- DB 迁移后可正常读写，不影响既有 reconcile-loop 主流程。

---

## Milestone 7 — 性能监控与诊断面板（本地 Dashboard + 实时推送 + AI 错误实时页）

### 目的

- 为 Electron **主进程（Main Process / 主线程 event loop）**提供可视化、可解释的性能与健康度监控，帮助快速定位卡顿、内存暴涨、队列堆积、以及 AI 调用失败的根因。
- 提供一个可以用浏览器访问的本地页面：`http://127.0.0.1:<port>`（仅监听 localhost），实时展示性能数据与错误数据。

### 范围与原则（必须明确，避免隐私与开销失控）

- 只采集**性能与状态指标**，不采集/不展示 prompt、response、截图图像、OCR 全量正文等敏感内容。
- 指标采样频率默认较低（例如 1s/2s），并支持开关与“降采样”（避免监控本身造成性能问题）。
- 监控 server 默认只绑定 `127.0.0.1`，不对局域网暴露。

### 性能开销控制（必须：监控与展示不能影响项目本身性能）

#### A. 采集层：低频采样 + 聚合优先

- **默认采样间隔**：以秒级为主（例如 1s/2s），严禁毫秒级高频采样作为默认。
- **聚合优先**：能用计数器/滑动窗口统计（p50/p95、近 1min 错误率）的，不推送原始明细。
- **避免阻塞主线程**：任何采集/序列化/写盘都不应在关键路径同步执行；监控逻辑必须可随时关闭。

#### B. 推送层：背压 + 丢弃策略（不允许“慢客户端拖垮主进程”）

- **每连接 buffer 上限**：SSE/WS 对每个连接设置发送队列上限，超过则丢弃旧数据并累计 `droppedFrames`。
- **慢客户端处理**：当浏览器 tab 后台/网络慢时，允许“只保留最新一帧”或直接断开重连；不能无限堆积。
- **动态节流**：当 event loop lag/ELU 达到阈值时自动降低采样频率与推送频率（例如从 1s 降到 5s）。

#### C. UI 层：图表点数上限 + 渲染降采样

- **时间窗固定**：默认只渲染最近 5~15 分钟，不允许无限追加点。
- **点数上限**：对每条曲线设置最大点数（例如 300~900 点），超过则做抽样/聚合（min/max/avg）。
- **渲染节流**：UI 更新频率与推送频率解耦（例如 UI 1s 刷新一次，即使后端更高频）。

#### D. 默认关闭 + 显式启用（可选但强烈建议）

- 监控服务默认关闭或以“轻量模式”运行；只有用户显式打开面板/打开开关时才进入实时推送。
- 监控 server 启动失败或推送异常时，必须自动降级并不影响主流程。

### 1) 主进程需要加入性能监控的点（埋点位置）

#### A. 全局健康度（无需业务语义，主进程通用）

- `electron/main.ts`
  - 主进程启动/ready 时间
  - 监控服务启动、端口选择、异常保护（server 启动失败不影响主功能）

#### B. 业务关键链路（建议按“阶段耗时 + 产量 + 队列积压”埋点）

- 屏幕捕获
  - `electron/services/screen-capture/screen-capture-module.ts`
  - `electron/services/screen-capture/capture-scheduler.ts`
  - 关注：capture tick 的抖动、截图写盘耗时、单张大小、失败率

- 截图处理（重任务状态机）
  - `electron/services/screenshot-processing/reconcile-loop.ts`
  - `electron/services/screenshot-processing/batch-builder.ts`
  - 关注：每次 reconcile 扫描耗时、处理条数、各状态机队列长度（pending/running/failed）、backoff 情况

- AI 调用阶段（强烈建议复用/对齐 Milestone 5 的口径）
  - `electron/services/screenshot-processing/vlm-processor.ts`
  - `electron/services/screenshot-processing/text-llm-processor.ts`
  - `electron/services/screenshot-processing/embedding-service.ts`
  - 关注：请求耗时（p50/p95）、超时/限流、失败率、熔断状态（如已存在 `ai-failure-circuit-breaker`）

- 索引与存储
  - `electron/services/screenshot-processing/vector-index-service.ts`（如 Milestone 2 引入）
  - `electron/database/*`
  - 关注：flush 耗时、索引文件大小、DB 查询耗时（抽样）、DB 文件大小增长

### 2) 适合主线程的性能监控指标（建议以“用户能理解”为第一优先级）

#### A. 主进程健康度（实时曲线 + 状态灯）

- `event loop` 健康：
  - Event Loop Lag（ms，p50/p95）
  - Event Loop Utilization（ELU，0~1）
- CPU：主进程 CPU usage（%）
- 内存：RSS / heapUsed / heapTotal（MB）
- GC（可选）：近一分钟 GC 次数与耗时（ms）

#### B. 处理吞吐与延迟（让用户知道“为什么慢”）

- 截图吞吐：`screenshots/min`、平均单张大小（MB）
- Pipeline 延迟（端到端）：capture → 入库 → batch ready → VLM → TextLLM → embedding → index succeeded
- 各阶段耗时分布：VLM/TextLLM/Embedding/Index 的 p50/p95

#### C. 队列与积压（最直接的“卡住了”信号）

- `batches`：pending/running/failed 数
- `vector_documents`：embedding pending/running/failed、index pending/running/failed 数
- （如有）activity summary / event details 等后台任务的 pending/running/failed 数

#### D. 错误与稳定性

- 未捕获异常计数：`uncaughtException`、`unhandledRejection`
- AI 调用错误：按 capability（VLM/Text/Embedding）与 errorCode 聚合
- 熔断器状态（如适用）：open/half-open/closed + 最近一次打开原因

### 3) 本地监控 Server（localhost 可访问）

#### 功能

- 提供一个本地 HTTP server：
  - `GET /`：监控首页
  - `GET /performance`：性能面板（也可作为首页）
  - `GET /ai-errors`：AI 错误实时面板
  - `GET /health`：server 自检（给脚本/诊断使用）

#### 初始化时机与生命周期（推荐约定）

- **初始化时机**：主进程 `app.whenReady()` 之后尝试启动（不允许阻塞主流程；失败只记日志并自动降级）。
- **空闲运行**：server 即使启动成功，在没有 dashboard 客户端连接时也应保持“轻量/近乎零开销”状态：
  - 不开启高频采样
  - 不做大对象序列化
  - 不维持无限内存缓存
- **按需激活采样/推送**：只有当有客户端订阅（SSE/WS connected）时，才启动采样与推送；最后一个客户端断开后自动回到空闲状态。
- **退出行为**：应用退出时关闭 server；不要求优雅 flush（因为默认不落库）。

#### 数据存储口径（默认不落库）

- **默认**：性能监控数据不写入 DB，仅使用 **内存环形缓冲（ring buffer）**保存最近 N 分钟（用于页面刷新/重连后补齐曲线）。
- **错误数据**：
  - 若 Milestone 5 已实现 `llm_usage_events`：错误聚合/历史展示优先从 DB 查询（可控、可追溯）。
  - 实时推送仍可使用内存队列（带背压/丢弃），避免高频写 DB。
- **可选增强**：若后续需要离线诊断/导出，可新增“轻量持久化”开关（仅保存聚合后的 1s/5s rollup，且默认关闭）。

#### 前端是否需要关心 server 初始化（建议：不阻塞主页面）

- 本地监控页面在浏览器打开时：
  - 可以用 `/health` 做 readiness probe（如不可访问则显示 loading 并重试）。
  - **不建议**把 `/health` 作为“进入应用主页面”的前置条件（避免监控影响主体验）。
- 如果未来把监控面板做成应用内 route：
  - 只在进入监控页面时检查 `/health` 并做 loading；应用其它页面不依赖该 server。

#### 端口策略（建议写清楚）

- 优先尝试固定端口（例如 23333）；冲突则自动递增或随机可用端口。
- 将最终端口输出到日志，并在 App 内提供“打开性能面板”的入口（可选）。

### 4) 实时数据推送方案（你提到 WebSocket；这里给出更优建议）

#### 方案 A（推荐，单向更简单）：SSE（Server-Sent Events）

- 浏览器使用 `EventSource` 订阅 `GET /stream`。
- 优点：
  - 单向推送天然匹配“指标流”场景
  - 自动重连、实现简单
  - 更容易在代理/调试环境下工作

#### 方案 B（可选，双向更灵活）：WebSocket

- 适合后续需要“订阅选择/过滤/远程触发 dump（例如请求导出 trace）”的场景。

#### MVP 建议

- MVP 先做 SSE（性能数据流 + 错误事件流），如后续需要交互能力再加 WebSocket。

### 5) 页面 1：实时性能数据（通俗易懂 + 页面精美）

#### 展示目标

- 让用户一眼看懂：
  - “现在应用健康吗？”
  - “卡在哪里？”（event loop / AI 调用 / 队列堆积 / IO）
  - “最近 5 分钟趋势如何？”

#### 页面结构（建议）

- 顶部 Health Cards（红黄绿）
  - Event Loop（Lag/ELU）
  - CPU
  - Memory
  - Queue Backlog（pending 总数）
- 中部实时图表（滚动窗口 5~15 分钟）
  - Lag/ELU 曲线
  - 内存曲线
  - 关键阶段耗时（VLM/Text/Embedding）
- 底部“系统状态”表格
  - 各队列 pending/running/failed
  - 最近一次 reconcile 执行时间、耗时、处理条数
  - DB / index 文件大小（可选）

### 6) 页面 2：VLM / LLM / Embedding 错误实时数据

#### 数据来源建议（与现有里程碑对齐）

- **优先复用 Milestone 5 的 `llm_usage_events`**：
  - `status='failed'` 作为错误事件
  - `capability/operation/model/configHash/errorCode/ts` 做聚合与展示
- 对于主进程自身异常：额外上报 `uncaughtException/unhandledRejection` 为独立 error stream。

#### 页面结构（建议）

- 顶部：最近 1min/5min 错误率（按 capability 拆分）
- 中部：错误码 Top 列表（可点选过滤）
- 底部：实时错误流（最近 N 条）
  - 每条只展示：时间、capability、operation、model、errorCode、retryable（如有）、traceId（如有）
  - 明确不展示敏感内容（不展示 prompt/response）

### 7) 可额外展示的数据（建议项，按价值排序）

- “端到端可用性”指标：`search ready`（从 capture 到可检索的平均/95 分位耗时）
- “数据规模”指标：DB 大小、索引大小、context_nodes/vector_documents 总量
- “质量/异常”指标：
  - pending 长时间不下降的队列（疑似卡死）
  - running 超时计数（stale recovery 触发次数）
  - screenshot 写盘失败/权限错误计数

### 验收标准（DoD）

- 浏览器可访问 `http://127.0.0.1:<port>`，并实时看到主进程性能数据刷新。
- 性能面板的核心指标可用且易理解：event loop、CPU、内存、队列积压、关键阶段耗时。
- AI 错误面板能实时看到 VLM/Text/Embedding 的失败事件，并支持按 capability/model/errorCode 过滤。
- 默认不采集敏感内容，且 server 仅绑定 localhost。
- 监控开启后不会明显影响主流程：
  - 监控推送/页面关闭时不会造成队列堆积（具备背压与丢弃策略）
  - 监控逻辑出现异常可自动降级/关闭，不阻塞 capture/reconcile/AI pipeline
- 监控 server 的启动失败/未就绪不会影响应用主页面与主流程：
  - `/health` 仅用于监控页面自身 readiness，不作为应用启动/页面进入的 gating 条件

---

## Milestone 8 — ReconcileLoop 根本调和优化 + VLM/LLM 稳定性 + AI Request Trace（不入库）

### 目的

- 从根本优化 `electron/services/screenshot-processing/reconcile-loop.ts` 的调和与并发，做到：
  - VLM 慢不会拖垮 embedding/index/merge/activity 等其它队列
  - 并发可控（不会把 provider/本机拖死），且具备“公平调度”
  - 各任务的状态机更清晰（尤其是 batch 内 VLM 与 Text LLM 的“部分成功”）
- 提升 VLM/Text LLM 的**结构化输出稳定性**与“防截断/防慢”的工程治理（schema + prompt + max token + timeout）。
- 在 Monitoring Dashboard 中加入**最近 20 条** VLM / Text LLM / Embedding 请求的：
  - 耗时
  - 成功响应（JSON pretty 展示）
  - 失败 error（含 errorCode/message 与关键上下文）
  - 明确：这些数据**不入库**，只保存在内存环形缓冲中。

### A) ReconcileLoop：调和与并发调度（核心改造）

- **[改造] “claim + worker pool” 调度模型**
  - 目标：避免“扫一批然后串行处理/粗粒度并行”导致的饥饿与不可控并发。
  - 为每种任务类型增加“claim 阶段”与“处理阶段”分离：
    - claim：挑选 due items，并用 **条件 update** 抢占（把 `status` 从 `pending/failed` 原子地置为 `running`；更新 `updatedAt`）。
    - 处理：只处理 claim 成功的 items；处理结束再写回 `succeeded/failed`。
  - 需要解决的问题：避免同一条任务在同一进程的并发分支（或未来多进程）被重复处理。

- **[新增] 各队列独立并发配置（可控且可调）**
  - `batchConcurrency`（已有）：控制 batch-level VLM/TextLLM 任务并发。
  - 新增建议：
    - `mergeConcurrency`
    - `vectorEmbeddingConcurrency`
    - `vectorIndexConcurrency`
    - `activitySummaryConcurrency`
    - `eventDetailsConcurrency`

- **[新增] 外部 AI 调用的“全局 semaphore”**
  - 背景：目前 `vlmConcurrency` 仅限制 shard 内并发，不限制“跨 batch 的总体并发”。
  - 方案：增加 capability-level semaphore：
    - `vlmGlobalConcurrency`
    - `textGlobalConcurrency`
    - `embeddingGlobalConcurrency`
  - 目标：即使 reconcile-loop 并发调度打开，也不会把 provider 拉爆或触发严重排队/限流。

- **[改造] Batch 状态机拆分（避免 Text LLM 失败后 batch 被标记 succeeded 且无法重试）**
  - 问题：VLM 成功但 Text LLM 失败时，若直接将 `batches.status` 标为 `succeeded`，会导致 graph 永久缺失且无法补偿。
  - 方案选一（推荐 B，状态机更清晰）：
    - A) 在 `batches` 上新增 `textStatus/textAttempts/textNextRunAt/textError*` 字段。
    - B) 新增 `batch_tasks` 表（`batchId + taskType(vlm|text)` 作为幂等键），以更通用方式承载“同一 batch 的多阶段任务”。

- **[改造] Index flush 策略（避免每次 upsert 都 sync flush 导致卡顿）**
  - 方案：
    - 在 reconcile-loop 内对 index upsert 做批处理：处理 N 条或到达时间阈值才 `flush()`。
    - 或在 VectorIndexService 内部引入 debounce 定时 flush。
  - 目标：降低磁盘 IO 对 event loop 的影响，提升吞吐。

- **[改造] VectorIndexService 初始化 singleflight + 读写互斥（防并发初始化/并发读写）**
  - 背景：search 与 index 可能并发触发 `load()`；且 upsert/flush 与 search 可能交错。
  - 方案：
    - `loadPromise` singleflight：并发调用共享一次 load。
    - `mutex`（轻量 promise lock）：序列化 upsert/flush；search 可允许并发或与写互斥（按库安全性决定）。

### B) VLM/Text LLM：稳定输出 + 防慢/防截断治理（schema + prompt + tokens）

- **[改造] Schema：尽量“纠错/降级”而不是“硬失败”**
  - 目标：减少 `NoObjectGeneratedError` 触发频率，让系统进入“可恢复的低质量输出”，而不是整批失败。
  - 建议：
    - `merge_hint`：当 `decision='MERGE'` 但缺少 `thread_id` 时，processed schema 将其**降级为 `NEW`**（而不是 refine 抛错）。
    - 对可控上限字段（segments/derived/entities/snippets）用 `.max(...)` 提示模型，并在 processed schema 再做截断兜底。

- **[改造] Prompt：控制输出体积（减少慢与截断的根因）**
  - VLM 侧：
    - 不强制每张图都输出长 `ocr_text`；默认只输出 `ui_text_snippets`（高信号、短）。
    - `ocr_text` 仅在“明显是文本密集文档/网页/日志”时输出，并要求尽量短。
    - 进一步减少重复说明与过长示例，避免 prompt 体积膨胀。
  - Text LLM 侧：
    - 已把 batch-level `vlmIndex.entities` 明确传入，这有利于 entity 稳定；继续保持。
    - 增加明确的字段长度预算（而不仅仅是“<=200 chars”），避免模型过度输出。

- **[新增] 统一 timeout + retry 策略（AbortController）**
  - 为 `generateObject`/`embed` 增加 abortSignal：
    - VLM shard：例如 60-120s 超时
    - Text LLM：例如 30-60s 超时
    - Embedding：例如 15-30s 超时
  - 超时后的降级：
    - VLM：重试时提示“只输出 segments/event/merge_hint，省略 screenshots.ocr_text/ui_text_snippets”等可选字段。
    - Text LLM：失败则回退到 direct conversion（当前已具备）。

- **[可选增强] 图像预处理以降低 VLM latency**
  - 将输入图片在本地做：resize（例如最长边 1024/1280）+ JPEG 压缩（质量 60~80），显著降低上传与模型视觉编码成本。
  - 注意：需要评估 Electron 打包与 native 依赖（如 `sharp`）风险；如不希望引入 native，可先做最小 resize（或通过现有依赖实现）。

### C) Monitoring：最近 20 条 VLM/Text/Embedding 请求 trace（不入库）

- **[新增] In-memory `AIRequestTraceBuffer`（RingBuffer）**
  - 仅存最近 N 条（N=20 或每 capability 20）：
    - `ts`
    - `capability`（vlm/text/embedding）
    - `operation`（如 `vlm_analyze_shard`/`text_expand`/`text_merge`/`embedding_node`/`deep_search_understand_query` 等）
    - `model`
    - `durationMs`
    - `status`（succeeded/failed）
    - `responsePreview`（成功时：JSON stringify pretty + 字符预算截断）
    - `errorPreview`（失败时：errorCode/message +（可选）finishReason 等）
  - 严格限制体积：每条 trace 的 response/error 做字符预算（例如 12k chars），避免监控本身造成内存问题。

- **[集成点] 统一在 AI 调用封装处埋点**
  - VLM：`vlm-processor.ts`（shard 级）
  - Text：`text-llm-processor.ts`（expand/merge） + `deep-search-service.ts`（understand/synthesize）
  - Embedding：`embedding-service.ts`
  - 目标：trace 的口径与 `llmUsageService` 对齐，但 trace 不入库。

- **[监控 server] 增加 API 与 SSE 推送**
  - 新增 route：
    - `GET /api/ai-requests`：返回最近 traces（按 capability 分组）
  - 新增 SSE message type：`ai_request`（实时推送新增 trace；用于页面实时刷新）
  - 保持现有背压/丢弃策略（不能让慢浏览器拖垮主进程）。

- **[监控 UI] 新增 AI Requests 面板**
  - 展示：最近 20 条请求列表（capability/operation/model/duration/status）
  - 点击展开：
    - 成功：pretty JSON
    - 失败：errorCode/message +（如有）finishReason
  - 明确“不入库”：刷新页面/重启应用数据丢失属于预期。

### 验收标准（DoD）

- ReconcileLoop：
  - 慢 VLM 不会阻塞 embedding/index/merge/activity 的推进。
  - 并发可控（全局 semaphore 生效），不会出现明显的 provider 排队/限流雪崩。
  - batch 内 VLM 与 Text LLM 的阶段失败可重试，不会出现“VLM 成功但 Text LLM 永久缺失”的不可恢复状态。
- VLM/Text：
  - `NoObjectGeneratedError`（特别是 length/truncation）显著下降；即使发生也能通过降级 prompt 自动恢复。
  - 输出 JSON 字段更稳定（长度/数量约束一致，且 processed schema 可兜底截断/修正）。
- Monitoring：
  - 面板可看到最近 20 条 VLM/Text/Embedding 请求的耗时与响应/错误详情（JSON pretty）。
  - 不写 DB；关闭/刷新面板不影响主流程。

# 必须的重构点清单（为了实现 MVP，不能跳过）

- **单一编排**：禁止任何绕过 `ReconcileLoop` 的 VLM/TextLLM/Embedding/Index 执行路径。
- **PendingRecord 扩展**：必须支持 `vector_documents` 的 `embedding` 与 `index` 两类 subtask。
- **VectorDocuments 统一生成**：只对 `context_nodes` upsert（MVP 决策 1A）。
- **Index MVP**：`hnswlib-node`（HNSW/ANN）+ 索引文件持久化（MVP 决策 2A）。

---

# 需要补齐/新增的测试（最小集合）

- `electron/services/screenshot-processing/reconcile-loop.test.ts`
  - `vector_documents embedding pending -> succeeded`
  - `vector_documents index pending -> succeeded`
  - `vector_documents embedding failed -> retry/backoff`
  - stale recovery：running 超时回滚 pending
- `ContextSearchService`（单测或集成测试）
  - `search()`：mock embedding + 构造 index + 确认证据回溯正确
  - （新增）`search(deepSearch=true)`：mock DeepSearchService 同时产出 `queryPlan + answer`，验证：
    - `embeddingText` 生效
    - `filtersPatch` 合并（且不会覆盖 UI 的 `threadId`）
    - `answer + citations` 被透传
  - （新增）DeepSearchService understand/synthesize 任一步骤失败：验证自动回退且不影响 nodes/evidence

---

# 交付/验收 Checklist（MVP）

- **采集**：截图持续入库、批次持续生成
- **VLM**：batch VLM 完成并产出可用 index
- **图谱**：TextLLM 产出 nodes/edges/links；merge 可完成
- **向量**：vector_documents 产生；embedding/index 状态机闭环
- **检索**：IPC search 可返回 nodes + evidence
- **恢复**：中途 kill/restart 后可从 DB 状态恢复继续跑

---

# 后续增强路线（记录：非 MVP）

## 增强 1（1B）：增加 screenshot snippets / batch summary 的向量化以提升召回

- 新增 `vector_documents.docType = screenshot_snippet | batch_summary`（以 schema enum 为准）
- 为每个 screenshot 生成 1~N 个片段文本（来自 OCR / UI snippet / VLM index fragment）
- 检索策略：
  - 先检索 snippet（召回证据）
  - 再聚合归因到 context_node（按时间窗口、threadId、已存在 links、实体重叠等）
- UI 展示仍以 node 为中心，snippet 作为证据补充

## 增强 2（2B）：hnswlib-node 工程化与规模化（在 ANN 已引入的前提下）

- 当 `vector_documents` 达到数万/十万级，需要进一步工程化优化：
  - flush 策略（批量落盘、崩溃恢复窗口）
  - 参数调优（HNSW M/efConstruction/efSearch 等；以 `hnswlib-node` 实际 API 为准）
  - 全量重建与碎片整理（支持 delete/overwrite 不完善时尤为重要）
  - 版本兼容与迁移（索引文件 schema/version 标记；必要时自动 rebuild）
  - 召回/延迟回归测试（固定评测集）

## 增强 3：更强的去重/聚合与质量评估

- snippet/节点检索结果去重（同一 thread/segment 的合并展示）
- 质量指标：召回率、重复率、平均证据数、平均延迟
- 对高价值节点做更强的 merge/summary（例如 activity summary）
