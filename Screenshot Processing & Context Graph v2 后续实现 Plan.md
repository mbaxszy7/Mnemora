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
- 通过实体（entity）可反查：
  - 输入一个名字/缩写/别名
  - 返回相关 `event`（以及可选的 thread 聚合）
  - 并可继续回溯到 `screenshots` 证据

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

## Milestone 4 — Entities 归一化：entity_profile + aliases + event_mentions_entity（必须）

### 目标

让 “entities” 从当前的 JSON 字段（`screenshots.detectedEntities` / `context_nodes.entities`）升级为**可索引、可消歧、可反查**的能力。

核心要求：最终你能通过一个 entity（例如人名/项目名/工单号/产品名）反查到：

- 相关 `event`（时间线）
- 相关 `screenshot`（证据）

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

#### 2) `EntityQueryService`（实体反查）

- **新增文件**：`electron/services/screenshot-processing/entity-query-service.ts`
- **职责**：
  - `findEntities(query: string)`：根据 alias/title 做匹配，返回候选 entity_profile
  - `getEventsByEntity(entityId: number, options?: { limit?: number; timeRange?: [number, number] }): Promise<ContextNodeRecord[]>`
  - `getEvidenceByEntity(entityId: number): Promise<ScreenshotEvidence[]>`

- **实现要点（SQL）**：
  - `entity_aliases(alias=normalized(query)) -> entityId[]`
  - `context_edges(where edge_type='event_mentions_entity' and to_node_id in entityId[]) -> from_node_id(eventId)`
  - `context_screenshot_links(where node_id in eventIds) -> screenshotIds`

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

#### 4) IPC：暴露实体反查接口（用于产品目标）

- **改动文件**：`shared/ipc-types.ts`
- **新增 channels（建议）**：
  - `CONTEXT_FIND_ENTITIES: "context:find-entities"`
  - `CONTEXT_GET_EVENTS_BY_ENTITY: "context:get-events-by-entity"`
  - `CONTEXT_GET_EVIDENCE_BY_ENTITY: "context:get-evidence-by-entity"`
- **新增 handler**：`electron/ipc/entity-handlers.ts`
- **main 注册**：`electron/main.ts`

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

## Milestone 5 — LLM 用量统计（按模型）+ Settings 页面展示 + Tray 展示（必须）

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
