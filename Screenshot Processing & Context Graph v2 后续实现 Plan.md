 # Screenshot Processing & Context Graph v2 — 后续实现 Plan（MVP=1A+2A）
 
 本文档描述在当前代码基础上，将「截图处理 → VLM → Text LLM → Context Graph → Embedding → 本地向量检索 → IPC」打通为一个可恢复、可重试、可回溯证据的完整闭环。
 
 ## MVP 决策（已确认）
 
 - **决策 1（1A）**：只对 `context_nodes` 生成向量文档并做 embedding（不做 screenshot snippet / batch summary 的向量化）。
 - **决策 2（2A）**：本地索引使用 **朴素 cosine 相似度** 的精确检索（不引入 ANN 第三方库）。
 
 这些决策的直接后果：
 
 - **检索结果**以结构化的 `context_nodes` 为主（event/knowledge/state_snapshot/procedure/plan/entity_profile）。
 - **可回溯证据链**固定为：`vector_documents -> context_nodes -> context_screenshot_links -> screenshots`。
 - **实现复杂度最低**，先确保状态机闭环、幂等与恢复机制正确，再做增强。
 
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
 
 ## Milestone 0 — 单一编排：ReconcileLoop 成为唯一重任务执行者（必须）
 
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
 
 ## Milestone 1 — v2 MVP：只对 context_nodes 生成 VectorDocuments（必须）
 
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
 
 ## Milestone 2 — Embedding + Index（2A：朴素 cosine）并补齐 ReconcileLoop（必须）
 
 ### 目的
 
 完成 MVP 可检索闭环：把 `vector_documents` 的文本嵌入并写入本地索引（文件）以支持向量检索。
 
 ### 需要新增的类/模块
 
 #### 1) `EmbeddingService`
 
 - **新增文件**：`electron/services/screenshot-processing/embedding-service.ts`
 - **依赖**：`AISDKService.getEmbeddingClient()`
 - **public 方法**
   - `embed(text: string): Promise<Float32Array>`
 
 #### 2) `VectorIndexService`（2A：朴素 cosine 精确检索）
 
 - **新增文件**：`electron/services/screenshot-processing/vector-index-service.ts`
 - **存储**：复用 `vectorStoreConfig.indexFilePath`
 - **内存结构（MVP）**：
   - `Map<vectorId, Float32Array>`
   - 可选：缓存 `norm` 加速 cosine
 - **public 方法（MVP 最小集合）**
   - `load(): Promise<void>`
   - `flush(): Promise<void>`
   - `upsert(vectorId: string, embedding: Float32Array): Promise<void>`
   - `remove(vectorId: string): Promise<void>`
   - `search(queryEmbedding: Float32Array, topK: number): Promise<Array<{ vectorId: string; score: number }>>`
 
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
   - `VectorIndexService.upsert(vectorId, embedding)`
   - `VectorIndexService.flush()`（MVP 先简单每次 flush）
   - 标记 `indexStatus=succeeded`
   - 失败：写入 `indexStatus=failed`/`failed_permanent`，更新 `indexNextRunAt`
 
 ### 数据编码约定（embedding blob）
 
 - `Float32Array -> BLOB`：`Buffer.from(float32Array.buffer)`
 - `BLOB -> Float32Array`：`new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)`
 
 ### 验收标准
 
 - `vector_documents.embeddingStatus` 与 `indexStatus` 均可从 pending→running→succeeded，并支持失败重试。
 - index 文件生成并可 `load()` 恢复。
 
 ---
 
 ## Milestone 3 — IPC：Search / Traverse / Evidence 接入主功能（必须）
 
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
 
 # 必须的重构点清单（为了实现 MVP，不能跳过）
 
 - **单一编排**：禁止任何绕过 `ReconcileLoop` 的 VLM/TextLLM/Embedding/Index 执行路径。
 - **PendingRecord 扩展**：必须支持 `vector_documents` 的 `embedding` 与 `index` 两类 subtask。
 - **VectorDocuments 统一生成**：只对 `context_nodes` upsert（MVP 决策 1A）。
 - **Index MVP**：朴素 cosine + 文件持久化（MVP 决策 2A）。
 
 ---
 
 # 需要补齐/新增的测试（最小集合）
 
 - `electron/services/screenshot-processing/reconcile-loop.test.ts`
   - `vector_documents embedding pending -> succeeded`
   - `vector_documents index pending -> succeeded`
   - `vector_documents embedding failed -> retry/backoff`
   - stale recovery：running 超时回滚 pending
 - `ContextSearchService`（单测或集成测试）
   - `search()`：mock embedding + 构造 index + 确认证据回溯正确
 
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
 
 ## 增强 2（2B）：引入 ANN（近似最近邻）以支持更大规模向量
 
 - 当 `vector_documents` 达到数万/十万级，朴素 cosine O(N) 会成为瓶颈
 - 可替换 `VectorIndexService` 底层为 ANN（例如 HNSW），但需要评估：
   - Electron 打包/原生依赖风险
   - index 持久化格式与兼容性
   - 近似导致的 recall 变化（需回归测试）
 
 ## 增强 3：更强的去重/聚合与质量评估
 
 - snippet/节点检索结果去重（同一 thread/segment 的合并展示）
 - 质量指标：召回率、重复率、平均证据数、平均延迟
 - 对高价值节点做更强的 merge/summary（例如 activity summary）
