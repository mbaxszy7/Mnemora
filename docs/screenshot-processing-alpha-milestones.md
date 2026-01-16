# Screenshot Processing — Milestone Implementation Plan

> 基于：
>
> - [Implementation plan](alpha-implementation-plan.md)
> - [Prompt templates](alpha-prompt-templates.md)

---

## 命名与目录迁移规则（必须遵守）

本计划中的 “alpha” **只代表临时目录名**，不代表任何代码层面的命名。

- **[临时目录]** 新实现将放在 `screenshot-processing-alpha/` 目录下（用于与旧版 `screenshot-processing/` 并存开发）。
- **[文档路径口径]** 本文中出现的代码路径（例如 `electron/services/screenshot-processing/...`）默认以**最终目录名** `screenshot-processing/` 为准；在实现阶段可先落在 `screenshot-processing-alpha/` 下，待全部 Milestones 完成后通过目录重命名完成对齐。
- **[最终目录]** 全部 Milestones 完成后：
  - 删除旧的 `screenshot-processing/` 目录（旧 pipeline 全量移除）
  - 将 `screenshot-processing-alpha/` 重命名为 `screenshot-processing/`
- **[代码命名禁用 alpha]** 在代码设计与命名中，禁止出现 `alpha` 字样，包括但不限于：
  - 模块/类/函数/类型/接口名（禁止 `Alpha*`）
  - IPC channel 名称
  - DB 表/字段/JSON key
  - config key（例如 `processingConfig.*`）
  - monitoring/queue/status 相关字段与 UI label
- **[说明]** 本文引用的权威文档文件名包含 `alpha`（如 `docs/alpha-implementation-plan.md`、`docs/alpha-prompt-templates.md`），这是文档命名，不应反向影响代码命名。

## 核心决策（已确认）

- `context_edges` 表物理删除/停用（不再写入/不再读取）
- 历史数据不迁移，新 pipeline 重新开始
- 本地 OCR 为准（VLM 不再产出 `ocr_text`）

---

## 目标与 DoD（Definition of Done）

- Capture → screenshots 入库
- Batch：每个 source buffer 触发（2 张或 60 秒）
- VLM：每张截图产出 1 个 Context Node
- Thread：跨窗口延续；长事件：≥25min（排除 gap>10min）
- OCR：仅对 knowledge 且语言 en/zh 做本地 OCR
- Search/Activity：不依赖 context_edges
- 鲁棒性：stale recovery + retry（全局配置：maxAttempts=2，delayMs=60s） + 幂等
- 可观测：LLMUsage + trace + **Event Bus (推荐用于调度与数据状态观测)**

---

## 现有代码基线（强复用清单）

- `electron/services/screenshot-processing/base-scheduler.ts`
- `electron/services/llm-usage-service.ts`
- `electron/services/monitoring/ai-request-trace.ts`
- `electron/services/ai-runtime-service.ts`
- `electron/services/screenshot-processing/vector-document-scheduler.ts`
- `electron/services/screenshot-processing/activity-timeline-scheduler.ts`

---

## 截图文件生命周期（Image Lifecycle）

> [!IMPORTANT]
> 截图文件仅在 VLM/OCR 处理期间临时保留，处理完成后立即删除以节省磁盘空间。
> 使用现有 `screenshots.filePath` 和 `screenshots.storageState` 字段追踪文件状态。

此机制横跨 M2（VLM）和 M3（OCR），是 pipeline 的核心存储策略。

### Schema 字段说明

```typescript
// electron/database/schema.ts
filePath: text("file_path"),                      // 截图文件路径
storageState: text("storage_state", {
  enum: ["ephemeral", "persisted", "deleted"],    // 存储状态
}),
```

| storageState | 含义                     | 何时设置             |
| ------------ | ------------------------ | -------------------- |
| `ephemeral`  | 临时文件，待处理         | 截图入库时初始值     |
| `deleted`    | 文件已删除               | VLM/OCR 处理完成后   |
| `persisted`  | 用户主动保留（可选功能） | 预留扩展，当前不使用 |

### 生命周期阶段图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Screenshot Image Lifecycle                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  [Capture Service]                                                           │
│       │                                                                      │
│       ▼ 保存图片到临时目录                                                    │
│  ┌──────────────────────────────────────────────────────────┐               │
│  │ 临时文件: captures/<timestamp>_<hash>.webp               │               │
│  │ • filePath 存入 SourceBuffer (内存)                       │               │
│  └──────────────────────────────────────────────────────────┘               │
│       │                                                                      │
│       │ pHash 去重                                                           │
│       ▼                                                                      │
│  ┌─────────┐                                                                 │
│  │ 重复?   │──是──▶ [立即删除] safeDeleteCaptureFile()                       │
│  └────┬────┘                                                                 │
│       │ 否                                                                   │
│       ▼                                                                      │
│  [screenshots 表入库]                                                        │
│       │ filePath = 实际路径                                                  │
│       │ storageState = "ephemeral"                                           │
│       ▼                                                                      │
│  [SourceBuffer] 积累截图                                                     │
│       │                                                                      │
│       │ 触发 Batch（2 张或 60 秒）                                            │
│       ▼                                                                      │
│  [Batch 创建]                                                                │
│       │ 从 screenshots.filePath 读取图片                                     │
│       ▼                                                                      │
│  ┌──────────────────────────────────────────────────────────┐               │
│  │ VLM 处理 (M2)                                             │               │
│  │ • Base64 编码图片发送给 VLM                               │               │
│  │ • 判断截图是否包含 knowledge (需要 OCR)                   │               │
│  │ • 提取 text_region 坐标（用于 OCR 裁剪）                  │               │
│  └──────────────────────────────────────────────────────────┘               │
│       │                                                                      │
│       ├──────────────────────────────────────────────────────┐               │
│       │                                                      │               │
│       ▼                                                      ▼               │
│  ┌──────────────────────┐                  ┌──────────────────────────────┐ │
│  │ 需要 OCR？           │                  │ 不需要 OCR                   │ │
│  │ (knowledge 且 en/zh) │                  │ (其他语言或无 knowledge)     │ │
│  └──────────┬───────────┘                  └──────────────┬───────────────┘ │
│             │                                              │                 │
│             ▼                                              ▼                 │
│  ┌──────────────────────────────────┐      ┌──────────────────────────────┐ │
│  │ OCR 处理 (M3)                    │      │ ✅ VLM 完成后删除 (M2)       │ │
│  │ • 从 filePath 读取图片           │      │    storageState = "deleted"  │ │
│  │ • 裁剪 text_region               │      │    safeDeleteCaptureFile()   │ │
│  │ • Tesseract.js OCR               │      └──────────────────────────────┘ │
│  │ • ocr_text 存入 screenshots 表   │                                       │
│  └──────────────────────────────────┘                                       │
│             │                                                                │
│             ▼                                                                │
│  ┌──────────────────────────────────┐                                       │
│  │ ✅ OCR 完成后删除 (M3)            │                                       │
│  │    storageState = "deleted"      │                                       │
│  │    safeDeleteCaptureFile()       │                                       │
│  └──────────────────────────────────┘                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 关键设计决策

| 设计点                | 决策                                           | 理由                                              |
| --------------------- | ---------------------------------------------- | ------------------------------------------------- |
| **filePath 入库**     | `screenshots.filePath = 实际路径`              | 需要在 VLM/OCR 处理时从 DB 读取文件位置。         |
| **storageState 追踪** | 使用 `ephemeral → deleted` 状态转换            | DB 记录文件是否已删，避免重复删除或读取已删文件。 |
| **删除时机**          | VLM 成功后（无 OCR）或 OCR 成功后（有 OCR）    | 确保图片在被需要时可用，用完即删。                |
| **删除失败容错**      | `safeDeleteCaptureFile()` 静默失败，不阻断流程 | 删除失败仅记录日志，依赖后续 cleanup 机制。       |

### 与 Cleanup Loop 的关系

> [!NOTE]
> 新 pipeline **不再依赖周期性 cleanup loop**。图片删除由处理流程主动触发，而非等待 TTL 过期。

| 场景                | 处理方式                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| VLM 成功 + 无 OCR   | VLM 完成后立即删除，设置 `storageState = "deleted"`                                                     |
| VLM 成功 + 需要 OCR | OCR 完成后立即删除，设置 `storageState = "deleted"`                                                     |
| VLM 失败            | 图片保留（`storageState = "ephemeral"`），VLM 重试时需要；达到 `failed_permanent` 后由兜底 cleanup 清理 |
| OCR 失败            | 图片保留（`storageState = "ephemeral"`），OCR 重试时需要；达到 `failed_permanent` 后由兜底 cleanup 清理 |
| App 崩溃            | 下次启动时，扫描 `storageState = "ephemeral"` 且 `createdAt` 过久的记录，执行兜底清理                   |

### 兜底 Cleanup（Fallback Cleanup）

为处理异常情况（崩溃、永久失败等），保留一个兜底清理机制：

```typescript
// 启动时或定期执行
async fallbackCleanup(): Promise<void> {
  const maxAgeMs = 24 * 60 * 60 * 1000; // 24 小时
  const now = Date.now();

  // 查找过期的 ephemeral 文件
  const staleScreenshots = await db.select()
    .from(screenshots)
    .where(
      and(
        eq(screenshots.storageState, "ephemeral"),
        lt(screenshots.createdAt, now - maxAgeMs),
        isNotNull(screenshots.filePath)
      )
    );

  for (const ss of staleScreenshots) {
    await safeDeleteCaptureFile(ss.filePath);
    await db.update(screenshots)
      .set({ storageState: "deleted", updatedAt: now })
      .where(eq(screenshots.id, ss.id));
  }
}
```

---

# Milestones（按实现顺序）

- M0 — DB Schema/Migrations + shared types/IPC 适配（移除 edges，引入 threads，补 OCR 状态）
- M1 — Pipeline 落地方式与入口切换（只启动 schedulers）
- M2 — BatchScheduler(VLM)：batch → VLM (Stateless) → 单图单 node 入库 + **图片删除（无 OCR 场景）**
- M3 — OCRScheduler：knowledge(en/zh) → 本地 OCR (Region optimized) + **图片删除（OCR 场景）** → 与 M4 并行执行
- M4 — ThreadScheduler：thread assignment + continuity tracking + snapshot → 与 M3 并行执行
- M5 — Vector/Search：vector_documents + embedding + index + evidence 回溯（无 edges）
- M6 — ActivityTimeline：20min summary + long events + details 触发
- M7 — Monitoring/Queue Inspector：dashboard 适配新状态机
- M8 — Hardening：幂等/崩溃恢复/清理策略（含兜底 Cleanup）与回归 checklist

> 📁 **截图文件生命周期**：详见上方 [截图文件生命周期（Image Lifecycle）](#截图文件生命周期image-lifecycle) 章节，横跨 M2 和 M3。

---

## M0 — DB Schema/Migrations + shared types/IPC 适配

### 目的

新 screenshot-processing pipeline 的数据与 API 基座改造，目标是：

- **[删除]** 彻底移除 `context_edges`（表 + schema export + 所有读写路径）
- **[新增]** 引入 `threads` 作为连续性的一等公民（替代边关系）
- **[新增]** 为 OCR/Thread LLM/Batch 推进补齐状态机字段（pending/running/failed/failed_permanent + attempts + next_run_at）
- **[兼容]** 让主进程、IPC、renderer 的类型与 API 在“无 edges”情况下仍能编译与运行

> 说明：用户已确认 **不迁移历史数据**。新 pipeline 从当前 schema 演进后开始写入新字段/新表。

### 需要改动的文件

- `electron/database/schema.ts`
- `shared/context-types.ts`
- `electron/ipc/context-graph-handlers.ts`
- `electron/preload.ts`

> 以及：任何直接引用 `contextEdges` / `EdgeType` / traverse 的 renderer 代码（按 TS 报错点逐个修正）。
> 说明：drizzle migration 会自动生成 SQL，无需手动创建 migration 文件。

### 数据库 Schema 改动清单（以 drizzle schema 为准）

#### 1) 删除 `context_edges`

- **[schema.ts]** 删除 `export const contextEdges = ...` 及其相关 `EDGE_TYPE_VALUES` 依赖（如存在）
- **[代码]** 删除/改写所有 `contextEdges` 的 insert/select（主要集中在 `ContextGraphService`、IPC traverse、以及可能的 merge/derived node 写入路径）

验收要点：`rg "contextEdges"` / `rg "context_edges"` 结果应为 0（除 migration SQL 外）。

#### 2) 新增 `threads` 表

在 `electron/database/schema.ts` 新增 `threads` 表（字段与 implementation plan 对齐，且满足现有 UI/Activity 聚合需求）：

- `id`（TEXT PK，uuid）
- `title`（TEXT NOT NULL）
- `summary`（TEXT NOT NULL）
- `currentPhase`（TEXT，可空）
- `currentFocus`（TEXT，可空）
- `status`（TEXT NOT NULL，enum: `active|inactive|closed`，默认 `active`）
- `startTime`（INTEGER NOT NULL）
- `lastActiveAt`（INTEGER NOT NULL）
- `durationMs`（INTEGER NOT NULL DEFAULT 0）
- `nodeCount`（INTEGER NOT NULL DEFAULT 0）
- `appsJson`（TEXT NOT NULL DEFAULT '[]'）
- `mainProject`（TEXT，可空）
- `keyEntitiesJson`（TEXT NOT NULL DEFAULT '[]'）
- `milestonesJson`（TEXT，可空）
- `createdAt/updatedAt`（INTEGER NOT NULL）

推荐索引：

- `idx_threads_last_active_at(last_active_at)`（用于“最近活跃 threads”）
- `idx_threads_status(status)`（用于活跃过滤）

#### 3) `batches`：增加 Thread LLM 状态机字段

按 implementation plan 执行（彻底重构替换）：

- **[VLM 状态字段]** `vlm_status/vlm_attempts/vlm_next_run_at/vlm_error_message`
  - enum: `pending|running|succeeded|failed|failed_permanent`
- **[Thread LLM 状态字段]** `thread_llm_status/thread_llm_attempts/thread_llm_next_run_at/thread_llm_error_message`
  - enum: `pending|running|succeeded|failed|failed_permanent`

#### 4) `screenshots`：增加 OCR 状态机字段

现有 `screenshots` 已有 `ocr_text` 字段，但缺少“是否在跑/是否失败/何时重试”。新 pipeline 需要 OCR scheduler 可靠推进：

- **[新增]** `ocrStatus`（TEXT，enum: `pending|running|succeeded|failed|failed_permanent`，允许为 null/空表示“不需要 OCR”）
- **[新增]** `ocrAttempts`（INTEGER NOT NULL DEFAULT 0）
- **[新增]** `ocrNextRunAt`（INTEGER，可空）
- **[新增]** `ocrErrorCode/ocrErrorMessage`（TEXT，可空）

约束：

- `ocr_text` 仍限制长度（≤8000 字符），写入时强制 truncate。

#### 4.5) `screenshots_fts`：FTS5 全文搜索虚拟表（OCR keyword search）

为了支持对 OCR 文本的**精确关键词检索**（例如错误码、类名、工单号），在 DB migration 中创建 FTS5 虚拟表 `screenshots_fts`（External Content 模式），并通过 trigger 与 `screenshots.ocr_text` 保持同步：

- **[新增]** `screenshots_fts`（FTS5 virtual table）
- **[新增]** `screenshots_fts_insert/update/delete` triggers

备注：FTS5 虚拟表通常不直接写入 `schema.ts` 的 `sqliteTable(...)` 导出，而是以 SQL migration 形式创建（drizzle migrations 仍在同一条链路执行）。

#### 5) `context_nodes`：增加 `batchId`（推荐）并明确幂等键

“单截图单 node”要做到幂等，推荐把 `origin_key` 固化为 `screenshot:<screenshotId>`：

- **[约定]** `context_nodes.origin_key = screenshot:<id>`（利用现有 unique index `idx_context_nodes_origin_key_unique`）

另外，为了让 Thread scheduler 能“按 batch 拉取 nodes”，推荐新增：

- `context_nodes.batch_id`（INTEGER references `batches.id`，并加索引 `idx_context_nodes_batch_id`）
- **[新增]** `context_nodes.thread_snapshot_json`（TEXT，存储 Thread LLM 分配时的 thread 快照，确保 Activity Summary 数据一致性）
  - Schema: `{ title, summary, durationMs, startTime, currentPhase?, mainProject? }`

备注：如果不加 `batch_id`，也能通过 `context_screenshot_links -> screenshots.enqueued_batch_id` 反查，但会显著增加调度器扫描复杂度与查询开销。

### 数据集策略（无独立 DB / 无启动清库）

本次是**彻底重构**：不再保留旧 screenshot-processing pipeline 的并行/回滚路径，也不引入独立 DB 文件或 DB variant。

- **[单一 schema]** 数据库 schema 仍统一维护在 `electron/database/schema.ts`，通过 drizzle migrations 演进。
- **[无自动重置]** 不在启动时自动 drop/recreate 或 delete（避免误伤用户数据）。
- **[无历史迁移]** 不要求迁移旧 pipeline 的历史数据；新 pipeline 从当前 schema 演进后开始写入新字段/新表。

### IPC / shared types 适配（无 edges）

#### 1) shared types

- `shared/context-types.ts`
  - **[删除]** `EdgeType` 与 `GraphTraversalResult.edges`
  - **[保留]** `ExpandedContextNode/SearchQuery/SearchResult`（search 仍然需要）
  - **[新增]** Thread DTO（建议新增 `Thread`/`ThreadSummary` 类型，供 UI 与 IPC 使用）

#### 2) IPC handlers

- `electron/ipc/context-graph-handlers.ts`
  - **[保留]** `search` / `getEvidence` / `getThread`（若已有）
  - **[移除/禁用]** `traverse`：
    - 直接移除 IPC channel 与 preload API

- `electron/preload.ts`
  - 同步删除/调整 renderer 暴露的 `contextGraph.traverse()` 等方法

### 验收标准（DoD）

- migrations 在空 DB 上可完整执行，应用可启动
- `context_edges` 不存在（表已 drop，schema 无 export，代码无引用）
- `threads` 表存在且可写入/查询
- TS 编译通过：IPC/preload/shared types 不再依赖 edges

### Review Checklist

- **[Schema]** `context_nodes.origin_key` 是否能稳定表达“单截图单 node”的幂等性
- **[索引]** `threads.last_active_at` 与 `context_nodes.batch_id/thread_id` 是否有索引
- **[兼容]** traverse API 的移除是否会影响现有 UI 路径（需要在 PR 内标注受影响功能）
- **[State]** `state_snapshot_json` 是否包含 `issue` 检测结构（`detected/type/description/severity`）
- **[FTS5]** `screenshots_fts` 是否按 External Content + triggers 正确同步 `screenshots.ocr_text`

---

## M1 — Pipeline 落地方式与入口切换

### 目的

建立新 screenshot-processing pipeline 的工程落地方式（模块边界、入口、启动/停止路径），明确这是**彻底重构替换**：

- 新实现将**完全取代**旧 screenshot-processing pipeline（不保留 feature flag / 并行运行 / 回滚分支）
- scheduler 体系可以按 milestone 逐步落地（M2/M3/M4 逐个接入）
- 对外部依赖（`screen-capture`、IPC、UI）的入口保持清晰、可审查

### 方案选择（推荐）

**推荐：直接在 `electron/services/screenshot-processing/` 内实现新 pipeline**（目录可重组，但不引入并行 pipeline 的选择逻辑）。

- 优点：
  - 可以直接复用copy现有的 `SourceBufferRegistry/BatchBuilder/BaseScheduler/aiRuntimeService/llmUsageService`
  - `ScreenCaptureModule -> ScreenshotProcessingModule` 的集成点保持稳定
  - 避免“双 pipeline/双 schema/双开关”带来的长期维护成本

- 目录建议（按需落地，不强制）：
  - `electron/services/screenshot-processing/schedulers/`
  - `electron/services/screenshot-processing/services/`
  - `electron/services/screenshot-processing/types.ts`
  - `electron/services/screenshot-processing/config.ts`

### 需要改动的文件

- `electron/services/screenshot-processing/screenshot-processing-module.ts`
  - `initialize()` 启动新 pipeline 的 schedulers
  - `dispose()` stop 对应 schedulers

- 新增（仅骨架，M2/M3/M4 再填充细节）：
  - `electron/services/screenshot-processing/schedulers/batch-vlm-scheduler.ts`
  - `electron/services/screenshot-processing/schedulers/ocr-scheduler.ts`
  - `electron/services/screenshot-processing/schedulers/thread-scheduler.ts`

- （自适应背压）`electron/services/screen-capture/screen-capture-module.ts`
  - 引入 BackpressureMonitor：基于 pending batch 数量动态调整采集间隔
  - **[策略]**：
    - Level 0 (pending < 4): 1x interval (3s), Hamming 8
    - Level 1 (pending 4-7): 1x interval (3s), Hamming 9
    - Level 2 (pending 8-11): 2x interval (6s), Hamming 10
    - Level 3 (pending >= 12): 4x interval (12s), Hamming 11
    - **[恢复策略]** pending 降到阈值以下且保持 30 秒 → 恢复上一级

### 具体实现清单

#### 1) ScreenshotProcessingModule：只负责“落库 + 唤醒”与“启动正确的 schedulers”

复用现有逻辑：

- `onPersistAcceptedScreenshot()`：截图入库（仍写 `screenshots`）
- `onCaptureComplete()`：将 capture result 送入 `SourceBufferRegistry`
- `onBatchReady()`：仍调用 `BatchBuilder.createAndPersistBatch(...)`

同时必须**保留 active source 管理与 preference 联动**（来自 `SourceBufferRegistry`）：

- `onPreferencesChanged()` 必须继续调用 `sourceBufferRegistry.setPreferences(preferences)`，使 active sources 与 `selectedScreens/selectedApps` 同步
- `SourceBufferRegistry` 的 `activeSources/gracePeriod` 语义保持不变：不对非 active source 接收截图；inactive 超过 grace period 丢弃 buffer。没大问题的话SourceBufferRegistry应该是整体copy的。

启动逻辑（无开关）：

- 启动：`batchVlmScheduler.start()` / `ocrScheduler.start()` / `threadScheduler.start()`
- 保留：`activityTimelineScheduler.start()` 与 `vectorDocumentScheduler.start()`（后续在 M6/M5 逐步适配）

唤醒机制（复用现有事件总线语义）：

- 在 `onBatchPersisted()`：
  - wake `batchVlmScheduler.wake()`

#### 2) Schedulers：先建骨架（BaseScheduler + start/stop/wake），再在后续 milestone 补齐状态机

骨架要求：

- class extends `BaseScheduler`
- `start()/stop()/wake()` 语义与现有 `VectorDocumentScheduler` 对齐
- `computeEarliestNextRun()`：先返回 `null` 或扫描对应表的 nextRunAt（M2/M3/M4 逐步补齐）
- `runCycle()`：空实现/仅 recoverStaleStates

#### 3) 运行时保护：避免残留旧 scheduler 被启动

在本 milestone 内应删除/替换旧 pipeline 的 scheduler 启动路径，避免 import side-effect 或遗留初始化导致旧逻辑仍在跑。

### 可直接复用的代码（copy 指引）

- **[scheduler 模板]** 直接参考并复制：
  - `vector-document-scheduler.ts` 的 start/stop/wake 结构
  - `BaseScheduler.scheduleNext()` + `computeEarliestNextRun()` 的实现方式

- **[唤醒事件]** 复用 `screenshotProcessingEventBus`：
  - `batch:persisted` 作为 batch VLM 推进入口

### 验收标准（DoD）

- 应用启动后：
  - 新 schedulers 会启动且可被 `wake()`
  - capture → screenshot 入库 → batch 入库链路不变

### Review Checklist

- **[单一执行引擎]** 是否存在任何旧 pipeline 的“隐式 start()”（例如在别处 import 即启动）
- **[事件路由]** `batch:persisted` 是否稳定唤醒 batch VLM scheduler
- **[Preferences]** preferences 改变后 active sources 是否即时更新（`SourceBufferRegistry.setPreferences()`）
- **[背压]** pending batch 增多时采集 interval 与 pHash 阈值是否按设计动态调整

---

## M2 — BatchScheduler(VLM)

### 目的

把“截图 → batch → VLM → 单图单 Context Node”跑通，作为新 pipeline 主链路的第一阶段产物。

该 Milestone 完成后：

- `batches` 能稳定推进 VLM 状态机（pending/running/succeeded/failed/failed_permanent）
- VLM 输出会落到：
  - `batches`：VLM 子任务状态与 raw 输出（例如 `indexJson`）
  - `screenshots`：仅写入截图元数据与 OCR 队列字段（`app_hint/window_title/...` + `ocr_*`），不存 VLM 证据字段
  - `context_nodes`：**每张截图 1 条**，`origin_key = screenshot:<id>`，`thread_id` 暂为空，`thread_snapshot_json` 待填
  - `context_screenshot_links`：建立可回溯证据链
- 为后续 M3/M4 提供输入：
  - OCR scheduler 读取“是否需要 OCR + language”
  - Thread scheduler 读取 batch 的 nodes

### 依赖

- M0：DB schema 已具备（至少包含：删除 edges、OCR 状态字段、`batches.thread_llm_*` 字段、threads 表等）
- M1：batch/vlm/ocr/thread schedulers 骨架已就位

### 需要改动/新增的文件

- `electron/services/screenshot-processing/config.ts`
  - 将目标对齐：
    - `processingConfig.batch.batchSize = 2`
    - `processingConfig.batch.batchTimeoutMs = 60_000`

- `electron/services/screenshot-processing/schedulers/batch-vlm-scheduler.ts`（新增）
- `electron/services/screenshot-processing/services/vlm-service.ts`（新增，可选；也可以直接复用现有 `vlm-processor.ts`）
- `electron/services/screenshot-processing/prompt-templates.ts`
  - 增加 VLM prompt（严格遵循 `docs/alpha-prompt-templates.md`）：
    - **[Stateless]** 不再包含 `history_pack` 或近期活动上下文，VLM 仅负责从图中提炼事实
    - **[OCR Optimization]** 包含 `text_region` 坐标提取要求
    - **[Issue Detection]** 包含 `state_snapshot.issue` 检测要求
    - **[不产出 ocr_text]** 仅产出结构化字段

- `electron/services/screenshot-processing/schemas.ts`
  - 增加 VLM 输出 schema（每张截图 1 个对象）

- 新增 `electron/services/screenshot-processing/context-node-service.ts`
  - 新增/调整：`upsertNodeForScreenshot(...)`（仅写 node + link，不写 edges，不做 merge/derived nodes）

### TODO（Implementation Checklist）

- [ ] 实现 `BatchVlmScheduler.computeEarliestNextRun()`：按 `vlm_status/attempts/next_run_at` 扫描 due 任务并返回最早 next run。
- [ ] 实现 `runCycle()` 主流程：stale recovery → scan → claim → process（含 lanes + concurrency）。
- [ ] VLM 调用必须复用：`aiRuntimeService.acquire("vlm")` + llmUsage + trace + timeout/abort。
- [ ] 落库映射完成：
  - `context_nodes`：单图单 node（`origin_key = screenshot:<id>`）+ 字段拆分写入（`app_context_json/knowledge_json/state_snapshot_json/ui_text_snippets_json/keywords_json/...`）
  - `context_screenshot_links`：upsert 证据链
  - `batches.vlm_status` 推进到 `succeeded/failed/failed_permanent`，并在成功后置 `thread_llm_status=pending`
- [ ] OCR gatekeeper：仅 `knowledge` 且语言 `en/zh` 才置 `screenshots.ocrStatus=pending`，其余置 `null`。
- [ ] 图片删除：VLM 成功后删除 **不需要 OCR** 的截图文件并更新 `storageState="deleted"`。

### Batch VLM 状态机

使用 `batches.vlm_*` 字段作为 VLM 子任务状态机：

- `pending` → `running` → `succeeded`
- 失败：`failed`（可重试）→ 超过阈值 `failed_permanent`

线程子任务状态机由 M4 接管：

- 当 VLM 成功落库后：将 `batches.thread_llm_status` 置为 `pending`（并 wake thread scheduler）

### 调度器实现（BatchVlmScheduler）

#### 1) 启动与 wake

参考 `vector-document-scheduler.ts`，实现：

- `start()`：注册 event listener（或仅 scheduleSoon）
- `wake(reason?)`：尽快跑一轮
- `stop()`：清 timer

触发来源：

- `ScreenshotProcessingModule.onBatchPersisted()`：`batchVlmScheduler.wake("batch:persisted")`

#### 2) computeEarliestNextRun()

查询 `batches` 中 VLM due 的最早 `vlm_next_run_at`：

- `vlm_status in (pending, failed)`
- `vlm_attempts < maxAttempts`
- `vlm_next_run_at is null OR vlm_next_run_at <= now`

返回 `min(vlm_next_run_at ?? now)`。

#### 3) runCycle()（核心流程）

参考 `vector-document-scheduler.ts` 的结构：

1. **recoverStaleStates**：
   - `batches.vlm_status == running` 且 `updated_at < now - staleRunningThresholdMs` → 回滚 `pending`（vlm_next_run_at=null）

2. **scanPendingRecords**：
   - newest+oldest 双向扫描（realtime/recovery）

3. **processInLanes**：
   - `laneWeights`: `{ realtime: 3, recovery: 1 }`
   - `concurrency`: 建议 1~min(vlmLimit, N)（首版保守，避免 OCR/Thread 还没接入时产生堆积）

4. **processOneBatch(batchId)**：
   - claim（`UPDATE ... WHERE vlm_status in (pending, failed)`）置 `running` 并 bump `vlm_attempts`
   - 读取 batch 的 screenshotIds，加载对应 screenshot 行
   - 读取图片文件并 base64（复用现有 `vlm-processor.ts` 的读取策略）
   - 调用 VLM（见下一节）
   - 落库（见“持久化映射”）
   - 更新 batch `vlm_status=succeeded`（或失败写 `failed/vlm_next_run_at/vlm_error_message`）

### VLM 调用与输出 Schema

#### 1) 输入（request）

建议保持与现有 `VLMProcessor.buildVLMRequest()` 结构一致，便于复用错误处理与 degraded 重试：

- system prompt：VLM system prompt（来自 `docs/alpha-prompt-templates.md`）
- user content：
  - 结构化元信息（每张截图的 `screenshotId/ts/sourceKey/appHint?/windowTitle?`）
  - 时间上下文字段（localTime/timeZone/utcOffset/nowTs/todayStart...）
  - images：按截图顺序附带
  - **[Stateless]** 移除 HistoryPack (不带近期上下文)，连贯性交由 Thread LLM 独立处理

硬规则（与用户决策对齐）：

- **VLM 不产出 `ocr_text`**
- VLM 只负责“结构化提取 + 判断是否需要 OCR + language + **text_region**”
- **[Issue Detection]** 检测 `state_snapshot.issue` (error/bug/blocker)

#### 2) 输出（response）

**严格复用** `docs/alpha-prompt-templates.md` 的 VLM 输出 schema（字段名与结构不得自行改写）。

- 输出整体为 `{ "nodes": VLMContextNode[] }`
- 每个输入截图必须对应 exactly 1 个 `VLMContextNode`（One-to-One Mapping）
- `screenshot_index` 为 **1-based**，必须与输入截图顺序严格对应

落库时保留 raw JSON：仅写入 `batches.indexJson`（或同等字段），不在 `screenshots` 中新增/复用 VLM 证据字段。

### 持久化映射（DB 写入点）

#### 1) 写 `screenshots`

对 batch 内每张截图：

- `appHint/windowTitle`：
  - window capture：优先使用 capture 元数据
  - screen capture：使用 VLM 识别出的 app/window 信息
  - 落库时合并（避免把已有非空字段覆盖为 null）

- **设置 OCR 队列字段（为 M3 准备）**：
  - 若 `knowledge` 存在且 `language in (en, zh)`：`ocrStatus = pending`；否则 `ocrStatus = null`
  - 需要 OCR 的截图应延长 `retentionExpiresAt`（至少覆盖 OCR 重试窗口），避免文件提前被 cleanup loop 删除

#### 2) 写 `context_nodes`（单图单 node）

建议新增 ContextGraphService API（或直接在 batch scheduler 内写 DB）：

- 幂等键：`originKey = screenshot:<screenshotId>`（复用现有 unique index）
- `kind = "event"`（统一用 event；knowledge/stateSnapshot 作为 payload 字段）
- `threadId = null`（由 M4 写入）
- `eventTime = screenshots.ts`
- `title/summary/keywords/entities/importance/confidence`：来自 VLM
- 按 `docs/alpha-implementation-plan.md` 拆字段写入：
  - `app_context_json`：写入 VLM 的 `app_context`
  - `knowledge_json`：写入 VLM 的 `knowledge`（不含 OCR 文本）
  - `state_snapshot_json`：写入 VLM 的 `state_snapshot`
  - `ui_text_snippets_json`：写入 VLM 的 `ui_text_snippets`
  - `keywords_json`：写入 VLM 的 `keywords`
  - （如 schema 已存在）`entities_json`：写入 VLM 的 `entities`
  - （如 schema 已存在）`action_items_json`：写入 VLM 的 `action_items`

若实现了 M0 中推荐的 `context_nodes.batch_id`：同时写入 `batchId`，便于后续按 batch 拉取 nodes。

#### 3) 写 `context_screenshot_links`

- upsert `(nodeId, screenshotId)`（复用唯一索引 `idx_csl_unique`）

#### 4) 更新 `batches`

- `vlm_status = succeeded`
- `indexJson = JSON.stringify(vlmOutput)`（可选，便于 debug；若体积过大可只存摘要或禁用）
- `thread_llm_status = pending`（为 M4 链路做准备）

并在成功后触发（**并行执行**）：

- wake `ocrScheduler`（如果存在任何 `ocrStatus=pending`）
- wake `threadScheduler`（batch.thread_llm_status=pending）

#### 5) 删除不需要 OCR 的截图图片

> [!IMPORTANT]
> 图片文件仅在 VLM/OCR 处理期间临时保留，用完即删。

对 batch 内每张截图：

- **不需要 OCR**（`ocrStatus = null`）：VLM 成功后立即删除
  - `await safeDeleteCaptureFile(screenshot.filePath)`
- **需要 OCR**（`ocrStatus = pending`）：保留图片，由 M3 OCRScheduler 处理后删除

```typescript
// VLM 成功后，删除不需要 OCR 的图片并更新 storageState
for (const ss of screenshotRecords) {
  if (ss.ocrStatus === null && ss.storageState !== "deleted") {
    await safeDeleteCaptureFile(ss.filePath);
    await db
      .update(screenshots)
      .set({ storageState: "deleted", updatedAt: Date.now() })
      .where(eq(screenshots.id, ss.id));
  }
}
```

### 可直接复用的代码（copy 指引）

- **[调度器骨架]** `vector-document-scheduler.ts` 的：
  - stale recovery
  - newest+oldest scan
  - claim 模式

- **[VLM 调用与容错]** `vlm-processor.ts` 的：
  - `aiRuntimeService.acquire("vlm")`
  - Abort/timeout
  - `NoObjectGeneratedError`/degraded prompt 重试
  - `llmUsageService.logEvent` + `aiRequestTraceBuffer.record`

- **[Batch 构建]** `batch-builder.ts`：截图聚合（不再构建/注入 history pack；保持 VLM stateless）

### 验收标准（DoD）

- 连续截图能触发 batch（2 张或 60s），并由 BatchVlmScheduler 推进为 succeeded
- 每张截图在 `context_nodes` 中最多 1 条（以 `origin_key` 保证幂等）
- `context_edges` 没有任何读写
- VLM 子任务状态被正确推进（以 `batches.vlm_status` 为准）
- `context_nodes.*_json` 拆字段被正确写入（`app_context_json/knowledge_json/state_snapshot_json/ui_text_snippets_json/keywords_json/...`）
- 对需要 OCR 的截图能正确置 `ocrStatus=pending`（但 OCR 逻辑由 M3 完成）
- VLM 请求有 llmUsage 与 trace 记录
- **不需要 OCR 的截图图片在 VLM 成功后被删除，`storageState` 更新为 `"deleted"`**

### Review Checklist

- **[幂等]** 重复运行同一个 batch（或崩溃恢复后重跑）不会产生重复 node/link
- **[字段覆盖策略]** 不会把 capture 提供的 app/window 信息覆盖成 null
- **[文件生命周期]** 需要 OCR 的截图保持 `storageState = "ephemeral"`，等待 M3 处理后删除
- **[输出约束]** VLM prompt 与 schema 确保"不产出 ocr_text"且"单图单对象"
- **[Stateless]** VLM 是否不再依赖 `history_pack` (近期上下文)
- **[OCR Optimized]** 是否产出了 `text_region`
- **[图片删除]** 不需要 OCR 的图片是否在 VLM 成功后立即删除并更新 `storageState`

---

## M3 — OCRScheduler

### 目的

实现混合 OCR：

- **[Gatekeeper]** 由 M2/VLM 决定“是否需要 OCR”与语言：仅 `en` 或 `zh` 触发；`other` 强制跳过
- **[Region Optimized]** 使用 VLM 返回的 `text_region` 对图像进行精准裁剪，减少 UI 噪声
- OCR 调度器只对满足条件的截图执行本地 OCR（Tesseract.js），写入 `screenshots.ocr_text`
- OCR 的执行必须具备：可恢复、可重试、可观测、不会与图片清理产生竞态

> 与用户决策对齐：VLM **不再产出** `ocr_text`，OCR 文本只由本地 OCR 生成。

### 依赖

- M2 已在截图行上设置 `ocrStatus=pending`（或 null 表示不需要 OCR）
- DB 已包含 OCR 状态机字段（M0）
- `tesseract.js` 与 `sharp` 已在 `package.json` 依赖中存在（可复用 demo）

### 需要改动/新增的文件

- `electron/services/screenshot-processing/config.ts`
  - 增加 `processingConfig.ocr`：
    - `maxChars: 8000`
    - `languages: "eng+chi_sim"`（初版可固定；后续可按 VLM language 选择）
    - `supportedLanguages: ["en","zh"]`
    - `initOnSplash: boolean`（可选：app 启动时预热 worker）
    - `concurrency: number`（建议 1~2）

- `electron/services/screenshot-processing/schedulers/ocr-scheduler.ts`（新增）
- `electron/services/screenshot-processing/services/ocr-service.ts`（新增）
  - 封装 worker lifecycle、图像预处理、识别与截断

- （可选）`electron/services/screenshot-processing/services/ocr-worker-pool.ts`（新增）
  - 如需并发 >1，维护多 worker；否则可单 worker

### TODO（Implementation Checklist）

- [ ] 实现 `OcrService`：worker 复用（避免每张图 create/terminate），并明确 `workerPath/corePath/langPath` 策略。
- [ ] 实现基于 `text_region` 的 region optimized 裁剪（无 region 时 fallback 全图）。
- [ ] 实现 `OcrScheduler.computeEarliestNextRun()` + `runCycle()`：stale recovery → scan → claim → OCR → 状态推进。
- [ ] OCR 成功：写 `screenshots.ocrText`（≤8000 chars）+ `ocrStatus=succeeded`，并删除图片文件 + `storageState="deleted"`。
- [ ] OCR 失败：写 `ocrStatus=failed` + `ocrNextRunAt=now+delayMs`；超过 `maxAttempts` → `failed_permanent`。

### OCR Worker 实现（OcrService）

优先复用 `demo/ocr-demo.ts` 的关键逻辑：

- **图像预处理**：`sharp(...).greyscale().normalize().sharpen().linear(...).toBuffer()`
- **识别**：`createWorker(lang, 1, { logger })` + `worker.recognize(processedBuffer)`

生产化必要补充：

- **worker 复用**：避免每张图 `createWorker/terminate`（成本极高）。
  - 推荐：按语言维护单例 worker（`eng` / `chi_sim` / `eng+chi_sim`）
  - 或固定使用 `eng+chi_sim` 单 worker（实现最简单）

- **路径配置**（Electron 打包注意点）：
  - 明确 `tesseract.js` 的 `workerPath/corePath/langPath` 策略
  - 初版可接受“首次运行下载 traineddata 到 userData”（需要网络）；
    若要求离线，则需要把 `eng.traineddata/chi_sim.traineddata` 作为资源打包并在运行时指向本地路径
  - 本 Milestone 的 DoD 要求：至少在 dev 环境可稳定运行；打包离线策略可放到 M8 加固项

- **输出截断**：统一 `text.slice(0, processingConfig.ocr.maxChars)`，并 `trim()`

### OCR 状态机（screenshots 表）

使用 M0 增加的字段：

- `ocrStatus`: `pending|running|succeeded|failed|failed_permanent`（或 null = 不需要 OCR）
- `ocrAttempts/ocrNextRunAt/ocrErrorCode/ocrErrorMessage`

推进规则：

- due 条件：`ocrStatus in (pending, failed)` 且 attempts < maxAttempts 且（nextRunAt is null 或 <= now）且 `filePath is not null` 且 `storageState != deleted`
- 成功：`ocrStatus=succeeded`, `ocrText=...`, `ocrNextRunAt=null`, 清 error
- 失败：写 `failed` + `ocrNextRunAt`（固定延迟=processingConfig.retry.delayMs）；达到上限后 `failed_permanent`

### OCR 调度器实现（OcrScheduler）

实现方式与现有 `vector-document-scheduler.ts` 对齐：

1. **recoverStaleStates**：
   - `ocrStatus=running` 且 `updatedAt < now - staleRunningThresholdMs` → 回滚 `pending`

2. **scanPendingRecords**：
   - newest+oldest 双向扫描（realtime/recovery）

3. **processInLanes**：
   - `concurrency = processingConfig.ocr.concurrency`（初版建议 1）

4. **claim + processOneScreenshot**：
   - claim：`UPDATE screenshots SET ocrStatus='running', ocrAttempts=ocrAttempts+1 ... WHERE ...`
   - **图像裁剪**：基于 `knowledge.text_region.box` 进行裁剪（如有）
   - 调用 `ocrService.recognize(filePath, lang)`
   - 更新 DB：`ocrText/ocrStatus/...`

### 与图片清理（cleanup loop）的竞态处理

当前 cleanup loop 的删除条件遵循现有截图生命周期策略（例如 `storageState=ephemeral` 且 `retentionExpiresAt <= now`），**不得依赖 screenshots 上的 VLM 证据字段**。

为避免 OCR 还未执行图片就被删除：

- **不需要 OCR 的截图**：已在 M2 中被删除（`storageState = "deleted"`）
- **需要 OCR 的截图**：保持 `storageState = "ephemeral"`，直到 OCR 完成

#### 5) OCR 成功后删除图片

> [!IMPORTANT]
> OCR 完成后立即删除图片文件，并更新 `storageState = "deleted"`。

```typescript
// OCRScheduler: OCR 成功后
async processOneScreenshot(ss: ScreenshotRecord): Promise<void> {
  // 检查文件是否可用
  if (ss.storageState === "deleted" || !ss.filePath) {
    throw new Error("Screenshot file not available");
  }

  // 1. 读取并裁剪图片
  const imageBuffer = await loadAndCropImage(ss.filePath, ss.textRegion);

  // 2. OCR
  const ocrText = await ocrService.recognize(imageBuffer);

  // 3. 更新 screenshots.ocr_text 和 ocrStatus
  // 4. 删除图片并更新 storageState
  await db.update(screenshots)
    .set({
      ocrText,
      ocrStatus: "succeeded",
      storageState: "deleted",
      updatedAt: Date.now(),
    })
    .where(eq(screenshots.id, ss.id));

  await safeDeleteCaptureFile(ss.filePath);
}
```

### 联动点

- **输入来源**：M2 写入 `ocrStatus=pending`
- **输出消费**：
  - `ContextSearchService.getEvidence`（通过 `screenshots.ocrText` 提供证据回溯）
  - UI/Deep Search（可选）显示 OCR 文本

### 可直接复用的代码（copy 指引）

- `demo/ocr-demo.ts`：
  - `preprocessImage()` 与 `performOCR()` 的核心实现可以直接迁移到 `ocr-service.ts`
- `vector-document-scheduler.ts`：
  - stale recovery / due scan / claim / retry 结构

### 验收标准（DoD）

- 对 `ocrStatus=pending` 且 `storageState != "deleted"` 的截图：OCR scheduler 能推进到 `succeeded` 并写入 `ocrText`
- OCR 文本长度被限制在 8000 字符以内
- OCR 失败会进入 `failed` 并按 nextRunAt 重试；达到阈值进入 `failed_permanent`
- **OCR 成功后图片被删除，`storageState` 更新为 `"deleted"`**

### Review Checklist

- **[性能]** worker 是否复用；首次 OCR 延迟是否可接受（是否需要 initOnSplash）
- **[资源]** sharp 预处理是否导致内存峰值过高（必要时降级预处理流程）
- **[打包]** traineddata 路径策略是否明确（离线/在线）
- **[一致性]** OCR 文本是否只来源于本地 OCR（无任何 VLM ocr_text 写入路径）
- **[Gatekeeper]** `other` 语言是否被正确过滤
- **[裁剪]** 是否正确应用了 `text_region` 裁剪
- **[图片删除]** OCR 成功后是否立即删除图片并更新 `storageState`

---

## M4 — ThreadScheduler

### 目的

实现 Thread 机制（替代 `context_edges/event_next`）：

- **[分配]** 对每个 VLM 成功的 batch 执行 Thread LLM，给 batch 内新节点分配 `threadId`
- **[Stateless 补偿]** 由于 VLM 无状态化，Thread LLM 现在独立负责维护活动的连贯性
- **[维护]** 写入/更新 `threads` 表（title/summary/current_phase/current_focus/milestones 等）
- **[Snapshot]** 在分配时，将 Thread 当前状态快照存入 `context_nodes.thread_snapshot_json`，确保后续 Activity Summary 的数据一致性
- **[统计]** 跨窗口累计 `threads.durationMs`（**排除 gap>10min**），并维护 `lastActiveAt/nodeCount/apps/keyEntities`
- **[生命周期]** `active → inactive`（超过 `inactiveThresholdMs` 未活跃）

> 约束：本 Milestone 完成后，Thread 连续性只能通过 `context_nodes.threadId + eventTime` 表达，任何 `context_edges` 读写都应被移除/禁用。

### 依赖

- M0：`threads` 表 + `batches.thread_llm_*` 字段已就位
- M2：每张截图已落为 1 条 `context_nodes`（`origin_key = screenshot:<id>`），且 batch 的 VLM 子任务可推进到 `succeeded`
- （推荐）`context_nodes.batch_id` 已存在，便于 ThreadScheduler 直接按 batch 拉取 nodes

### 需要改动/新增的文件

- `electron/services/screenshot-processing/config.ts`
  - 增加 `processingConfig.thread`（inactive/gap/longEvent/maxActiveThreads/recentNodesPerThread 等）
- `electron/services/screenshot-processing/prompt-templates.ts`
  - 增加 Thread LLM 的 system/user prompts（对齐 `docs/alpha-prompt-templates.md`）
- `electron/services/screenshot-processing/schemas.ts`
  - 增加 Thread LLM output zod schema（`assignments/thread_updates/new_threads`）
- `electron/services/screenshot-processing/schedulers/thread-scheduler.ts`（新增）
- `electron/services/screenshot-processing/services/thread-llm-service.ts`（新增）
- `electron/services/screenshot-processing/services/thread-repository.ts`（新增，可选：把 threads 的 upsert/统计/里程碑 append 封装起来）

### TODO（Implementation Checklist）

- [ ] 实现 Thread LLM prompt + schema（严格对齐 `docs/alpha-prompt-templates.md`），并接入 llmUsage + trace。
- [ ] 实现 `ThreadScheduler`：按 `batches.thread_llm_*` 扫描 due、claim、推进状态机（含 stale recovery + retry）。
- [ ] 落库必须单事务：创建新 thread + 更新 nodes.threadId + 写 `thread_snapshot_json` + 更新 threads 统计 + 更新 batch 状态。
- [ ] durationMs 计算按 gap 排除规则实现，并补单测覆盖 gap>10min。
- [ ] thread assignment 成功后触发 vector docs dirty（或逐 node upsert），确保 threadId 变更能进入 search/index。

### 配置项（`processingConfig.thread`）

在 `electron/services/screenshot-processing/config.ts` 增加（值对齐 implementation plan，可先 hardcode，后续再暴露到 UI 配置）：

- **[inactiveThresholdMs]** `4 * 60 * 60 * 1000`（4 小时无活动 → `inactive`）
- **[gapThresholdMs]** `10 * 60 * 1000`（超过该间隔不计入 `durationMs`）
- **[longEventThresholdMs]** `25 * 60 * 1000`（后续给 ActivityTimeline 做 long event 判定用）
- **[maxActiveThreads]** `3`（Thread LLM prompt 中最多带 3 个活跃 thread）
- **[fallbackRecentThreads]** `1`（无活跃 thread 时，带最近 1 个）
- **[recentNodesPerThread]** `3`（每个 thread 仅带最近 3 个节点）

### `batches.thread_llm_status` 状态机（Thread LLM 子任务）

ThreadScheduler 只推进 `batches.thread_llm_*` 字段，不触碰 VLM 的 `batches.vlm_*`：

- `pending` → `running` → `succeeded`
- 失败：`failed`（固定延迟=processingConfig.retry.delayMs 后重试）→ 达到 `maxAttempts` → `failed_permanent`

触发点（与 M2 联动）：

- BatchVlmScheduler 在 batch VLM 成功、nodes 落库后：
  - `UPDATE batches SET thread_llm_status='pending', thread_llm_next_run_at=NULL ... WHERE id=?`
  - 调用 `threadScheduler.wake("batch:vlm:succeeded")`

### 调度器实现（`ThreadScheduler`）

调度器模板与 error/retry/stale recovery 结构直接复制：

- `electron/services/screenshot-processing/vector-document-scheduler.ts`
- `electron/services/screenshot-processing/activity-timeline-scheduler.ts`

建议实现要点：

#### 1) due 任务扫描条件

ThreadScheduler 处理条件（以 `batches` 为中心）：

- `batches.vlm_status == 'succeeded'`（VLM 已成功落库）
- `thread_llm_status in ('pending','failed')`
- `thread_llm_attempts < maxAttempts`
- `thread_llm_next_run_at is null OR thread_llm_next_run_at <= now`

#### 2) claim（避免并发重复处理）

参考 `vector-document-scheduler.ts` 的“claim then process”模式：

- `UPDATE batches SET thread_llm_status='running', thread_llm_attempts=thread_llm_attempts+1, updated_at=now WHERE id=? AND thread_llm_status IN ('pending','failed')`
- 仅当 `changes == 1` 才继续执行（否则跳过）

#### 3) stale recovery

回收卡死的 `running`（逻辑与 `vector_documents` 一致）：

- `thread_llm_status == 'running'` 且 `updated_at < now - staleRunningThresholdMs`
  - 回滚到 `pending`（或 `failed`），并清掉 `thread_llm_next_run_at` 以尽快重跑

#### 4) 并发与 lane

首版建议保守：

- `concurrency = 1`
- `laneWeights = { realtime: 3, recovery: 1 }`

原因：Thread LLM prompt 需要聚合 threads + nodes，且一次处理一个 batch 更易保证幂等与可解释日志。

### Thread LLM（Prompt / Schema / Usage Trace）

#### 1) IO schema（对齐 `docs/alpha-prompt-templates.md`）

输入（user prompt args）必须包含：

- `activeThreads: ThreadSummary[]`
- `threadRecentNodes: Map<string, ContextNode[]>`
- `batchNodes: ContextNode[]`
- 时间上下文：`localTime/timeZone/nowTs/todayStart/todayEnd/yesterdayStart/yesterdayEnd/weekAgo`

输出（Thread LLM output）必须包含：

- `assignments: Array<{ node_index; thread_id; reason }>`
- `thread_updates: Array<{ thread_id; title?; summary?; current_phase?; current_focus?; new_milestone? }>`
- `new_threads: Array<{ title; summary; current_phase?; node_indices; milestones }>`

实现上建议复用当前代码库已有的“schema + processedSchema”模式：

- `deep-search-service.ts`（`generateObject` + `...ProcessedSchema.parse` + `llmUsageService.logEvent` + `aiRequestTraceBuffer.record`）
- `activity-monitor-service.ts`（`parseJsonSafe` 的容错模式可复制）

#### 2) Prompt 模板

在 `prompt-templates.ts` 增加：

- `getThreadLlmSystemPrompt()`
- `getThreadLlmUserPrompt(args: ThreadLLMUserPromptArgs)`

Hard rules（在 system prompt 中明确）：

- 必须输出 JSON（不能夹带 markdown）
- `assignments.node_index` 必须覆盖 batchNodes 中所有节点（不允许遗漏）
- 只允许返回 `thread_id` 为现有 UUID 或 "NEW"

#### 3) 输入数据准备（由 `ThreadLLMService` 完成）

1. **拉取 batchNodes**

- `SELECT * FROM context_nodes WHERE kind='event' AND batch_id=? ORDER BY event_time ASC`
- 若暂未落 `batch_id`：fallback 方案（仅作为过渡）：
  - `batches.screenshotIds -> context_screenshot_links -> context_nodes`（按 `event_time` 排序后去重）

2. **选择 activeThreads**

- `SELECT * FROM threads WHERE status='active' ORDER BY last_active_at DESC LIMIT maxActiveThreads`
- 如果结果为空：取 `fallbackRecentThreads` 个最近线程（`status != 'closed'`）

3.  **时间上下文**

时间字段计算方式直接复制 `activity-monitor-service.ts` 的 window 计算逻辑：

- `nowTs = Date.now()`
- `todayStart/todayEnd/yesterdayStart/yesterdayEnd/weekAgo` 用本地时区算边界（避免 UTC 造成错判）

#### 4) LLM usage & trace

Thread LLM 调用必须进入现有监控体系：

- `llmUsageService.logEvent({ capability: 'text', operation: 'thread_assign', ... })`
- `aiRequestTraceBuffer.record({ capability: 'text', operation: 'thread_assign', ... })`

（可选）把 threadLlm 的 `batchDbId/batchId` 作为 `operationMetadata` 或日志字段写入，便于 dashboard 关联。

### 落库与幂等（`ThreadRepository`）

Thread LLM 输出应用到 DB 时要做到“可重试 + 不产生重复 threads + 不反复改写已分配节点”。建议约束如下：

- **[只补不改]** 对 batchNodes：仅对 `threadId IS NULL` 的节点写入 `threadId`；已存在 `threadId` 时保持不变
- **[Snapshot]** 写入 `thread_snapshot_json`：在分配节点到 thread 时，捕获并存入 thread 的当前状态快照
- **[事务]** “创建新 thread + 写入节点 threadId/snapshot + 更新 thread 统计 + 更新 batch.thread_llm_status”必须在一个事务内完成
- **[强校验]** LLM 输出缺失/越界/重复/不一致时直接 fail（进入 `failed` 并 retry），禁止 partial apply

推荐的事务步骤（伪流程）：

1.  `BEGIN`
2.  **校验输出**：
    - `assignments.length == batchNodes.length`
    - `node_index` 覆盖 `[0..batchNodes.length-1]` 且无重复
    - `new_threads[].node_indices` 必须是有效索引，且不允许同一 node 同时属于多个 new thread
3.  **创建新 threads**：
    - 为每个 `new_threads[i]` 生成 `threadId = uuid()`
    - 插入 `threads`：`title/summary/currentPhase/currentFocus/status/startTime/lastActiveAt` 等
    - `milestonesJson`：把 `new_threads[i].milestones` 以 JSON array 字符串写入（为空则 `[]`）
4.  **构造 node_index → finalThreadId 映射**：
    - `assignment.thread_id != "NEW"`：直接使用现有 threadId
    - `assignment.thread_id == "NEW"`：必须能通过 `new_threads[].node_indices` 唯一定位到某个新 threadId
5.  **写入 context_nodes.thread_id（只补不改）**：
    - `UPDATE context_nodes SET thread_id=?, updated_at=now WHERE id=? AND thread_id IS NULL`
6.  **应用 thread_updates**：
    - `title/summary/currentPhase/currentFocus`：有值则覆盖
    - `new_milestone.description`：append 到 `milestonesJson` 数组尾部
7.  **更新 threads 统计**（见下一节）
8.  `UPDATE batches SET thread_llm_status='succeeded', thread_llm_error_message=NULL, updated_at=now WHERE id=?`
9.  `COMMIT`

### Thread 统计计算（durationMs / nodeCount / lastActiveAt）

该 Milestone 的关键产物是 `threads.durationMs`：它必须按 gap 规则计算，供后续 M6 长事件判定与跨窗口聚合使用。

#### 1) gap 排除规则（必须写到单测里）

对同一 thread 内按 `eventTime` 升序的事件序列：

- 若 `delta = t[i] - t[i-1]` 且 `delta <= gapThresholdMs`：累计 `durationMs += delta`
- 若 `delta > gapThresholdMs`：该段不计入 duration（视为新的 session）

同时：

- `startTime = min(eventTime)`
- `lastActiveAt = max(eventTime)`
- `nodeCount = count(events)`

#### 2) 首版推荐实现：受影响 threads 做全量重算

首版优先正确性：每次 thread 写入新节点后，对该 thread 全量重算一次即可：

- `SELECT event_time FROM context_nodes WHERE kind='event' AND thread_id=? ORDER BY event_time ASC`
- 计算并写回 `startTime/lastActiveAt/durationMs/nodeCount/updated_at`

受影响 threads 集合：

- 所有 `assignments` 涉及的 threadId（包含 newly created threads）
- 所有 `thread_updates.thread_id`

#### 3) appsJson / keyEntitiesJson（首版可弱化）

首版只要求“可用”，允许后续 milestone 再优化：

- `appsJson`：从 thread nodes 的 `app_context_json.appHint` 去重聚合（必要时限制最近 N=50 条节点）
- `keyEntitiesJson`：从 nodes 的 `entities` 聚合 Top-K（按出现次数或 importance 权重）

### 生命周期：active → inactive

ThreadScheduler 每轮 `runCycle()` 可附带一次轻量维护：

- `UPDATE threads SET status='inactive', updated_at=now WHERE status='active' AND last_active_at < now - inactiveThresholdMs`

（可选）若未来需要 `inactive → active`：当 thread 被再次分配新节点时，把 status 拉回 `active`。

### 联动点

- **输入来源**：M2 在 batch VLM 成功并落库后把 `batches.thread_llm_status` 置为 `pending`
- **输出消费**：
  - M6 ActivityTimeline：用 `context_nodes.threadId` 做跨窗口聚合；用 `threads.durationMs` 做 long event 判定（排除 gap）
  - M5 Vector/Search：`vector_documents.metaPayload.thread_id` 需要包含 threadId（threadId 从 null → 有值时要触发 doc dirty）

推荐在 thread assignment 成功后：

- 对 batchNodes 逐个调用 `VectorDocumentService.upsertForContextNode(nodeId)`，或 emit `vector-documents:dirty`

### 可直接复用的代码（copy 指引）

- **[scheduler 模板]** `vector-document-scheduler.ts`（claim / stale recovery / retry / lane）
- **[usage/trace]** `deep-search-service.ts`（`llmUsageService.logEvent` + `aiRequestTraceBuffer.record`）
- **[时间计算]** `activity-monitor-service.ts`（本地时间窗口边界计算）

### 验收标准（DoD）

- ThreadScheduler 能把 due batch 从 `thread_llm_status=pending/failed` 推进到 `succeeded`
- batch 内所有新 `context_nodes` 都获得 `threadId`
- 创建新 thread 时：`threads` 表有新行，且写入 `title/summary/currentPhase/currentFocus/milestonesJson`
- `threads.durationMs` 按 gapThresholdMs 规则计算（构造 gap>10min 的数据验证）
- `threads` 能按 `inactiveThresholdMs` 自动从 active → inactive
- `llm_usage_events` 中可看到 `operation=thread_assign` 的成功/失败事件

### Review Checklist

- **[幂等]** 同一 batch 重跑是否会创建重复 threads（应避免）
- **[一致性]** `NEW` 映射是否严格依赖 `new_threads[].node_indices`（避免歧义）
- **[统计]** durationMs 的 gap 排除规则是否与 config 一致（10min）
- **[联动]** threadId 写入后是否触发 vector docs dirty（避免 search 过滤不生效）

---

## M5 — Vector/Search

### 目的

让 Vector/Search 在 **不依赖 `context_edges`** 的前提下可用，并把“上下文展开”从 graph traversal 改为基于 **`threadId + eventTime`** 的邻域扩展：

- **[无 edges]** 不再读写 `context_edges`，也不再依赖 `event_next`
- **[搜索可用]** keyword/entity SQL fallback + vector semantic search + screenshot evidence 回溯保持可用
- **[FTS5 keyword]** OCR keyword search 使用 `screenshots_fts`（FTS5）做精确匹配，并可回溯到截图与对应 context nodes
- **[issue detection]** 将 `context_nodes.state_snapshot_json.issue` 纳入 search 的 ranking/filter（例如优先返回 `issue.detected=true` 的结果）
- **[替代 traverse]** `CONTEXT_TRAVERSE` 语义改为 _thread/time neighborhood_（兼容返回结构，`edges=[]`）
- **[thread 过滤]** `SearchFilters.threadId` 在 keyword 与 semantic 两条路径都生效

### 依赖

- M0：`context_edges` 已删除/停用（schema + migration + 代码读写路径）
- M2：`context_nodes`（单图单 node）与 `context_screenshot_links` 已可回溯证据
- M4：`context_nodes.threadId` 已可用（连续性来源成立）

### 需要改动/新增的文件

- `electron/services/screenshot-processing/context-search-service.ts`
- 删除对 `contextGraphService.traverse()` 的依赖
- 把 search 的 temporal expansion 与 IPC traverse 都改为 thread/time 邻域扩展
- keyword 路径中引入 `screenshots_fts`（FTS5）检索：`MATCH` + `bm25/snippet`，并 join 回 screenshots/context_screenshot_links
- 从 `context_nodes.state_snapshot_json` 提取 `issue`，用于过滤/排序（至少保证可观测）
- `electron/services/screenshot-processing/context-node-service.ts`
- M5 目标是“Search/Vector 无 edges”，因此这里的 `traverse()` 应被移除或不再被调用
- `electron/ipc/context-graph-handlers.ts`
- `handleTraverse()` 保留 channel，但返回的 `edges` 恒为空数组（或改成兼容期专用返回类型）
- `electron/services/screenshot-processing/vector-document-service.ts`
  - 调整 `metaPayload` 更新策略：threadId 变化时仍能刷新（见下文）

### TODO（Implementation Checklist）

- [ ] 彻底移除所有 `context_edges` 读写与 `event_next` 依赖（含 `batch-builder.ts.queryOpenSegments()` 等残留点）。
- [ ] 实现 thread/time neighborhood expansion：search 与 IPC traverse 统一改为 thread 邻域（`edges=[]`）。
- [ ] keyword search 集成 `screenshots_fts`（FTS5）：MATCH + snippet/bm25，并可回溯到 screenshots/node。
- [ ] `SearchFilters.threadId` 在 keyword + semantic 两条路径都必须生效。
- [ ] Vector meta 刷新：`textHash` 命中时也更新 `vector_documents.metaPayload`（尤其 threadId），但不重置 embedding/index 状态机。

（建议同 Milestone 一起修掉的残留引用）

### 设计：thread/time 邻域扩展（替代 edges）

- `electron/services/screenshot-processing/batch-builder.ts`
  - `queryOpenSegments()` 当前通过 `event_next` edge 判断 open segment（会残留 `context_edges` 依赖），需要改为 thread/time 判断

### 设计：thread/time 邻域扩展（替代 edges）

#### 1) 邻域扩展规则

对 pivot node（必须是 `kind='event'`）：

- 若 pivot 有 `threadId + eventTime`：
  - **[thread 邻近]** 取同 thread 前后 N 条事件（按 `eventTime` 排序）
- 若 pivot 缺失 `threadId`（过渡期）或 `eventTime` 缺失：
  - **[全局时间窗 fallback]** 取 `eventTime±temporalWindowMs` 的事件

建议参数（首版可 hardcode，后续再入 `processingConfig.search`）：

- `threadNeighborBefore = 3`
- `threadNeighborAfter = 3`
- `temporalWindowMs = 2 * 60 * 1000`

#### 2) `ContextSearchService.search()`：替换 temporal expansion

现状：对 top pivots 做全局 `eventTime±120s` 扩展。

改为：

1. pivots：取最终 `nodes` 的前 3-5 条（或 `combinedNodeMap` 前 3-5 条）
2. 对每个 pivot：
   - 若 pivot 有 `threadId`：用 **thread 邻近** 扩展
     - SQL 方案 A（窗口）：
       - `WHERE thread_id=? AND event_time BETWEEN a AND b ORDER BY event_time LIMIT ...`
     - SQL 方案 B（推荐，前后 N）：
       - `<= pivotTs`：`ORDER BY event_time DESC LIMIT threadNeighborBefore`
       - `>= pivotTs`：`ORDER BY event_time ASC LIMIT threadNeighborAfter`
   - 若 pivot 无 `threadId`：fallback 到全局时间窗
3. 扩展 nodes 合并回集合，并继续走 `applyFilters()`

关键约束：

- **[filters.threadId]** 用户指定 threadId 时，扩展必须强制限定在该 thread 内
- **[去重]** 仍用 nodeId map 去重

#### 3) `CONTEXT_TRAVERSE`（IPC）语义改造

现状链路：`handleTraverse()` → `contextSearchService.traverse()` → `contextGraphService.traverse()`（依赖 edges）。

兼容优先的方案：

- IPC 入参仍为 `{ nodeId, edgeTypes?, depth }`（减少 renderer 改动面）
- 后端忽略 `edgeTypes/depth`，改为：
  - 查 pivot node（`SELECT * FROM context_nodes WHERE id=?`）
  - 做 thread/time 邻域扩展
  - 回填 `screenshotIds`（复用现有 `getScreenshotIdsByNodeIds()`）
- 返回 `GraphTraversalResult`：
  - `nodes`: ExpandedContextNode[]
  - `edges`: `[]`（恒空）
  - `screenshotIds`: number[]

后续 milestone（M7/M8）再清理：把 API rename 为 neighborhood，并移除 `edgeTypes/depth`。

### Vector 文档与 threadId 变化的刷新策略

ThreadScheduler（M4）会在 batch 后写入 `context_nodes.threadId`。为了让 Search/Debug 能及时看到 threadId：

- **[推荐]** M4 在事务提交后，对 batchNodes 调用 `vectorDocumentService.upsertForContextNode(nodeId)`（或 emit `vector-documents:dirty`）

同时注意现状：`VectorDocumentService.upsertForContextNode()` 若 `textHash` 不变会直接 return，导致：

- `vector_documents.metaPayload.threadId` 可能长期停留在旧值（或 null）

因此建议在 `textHash` 命中时也更新 meta（不重置 embedding/index 状态机）：

- `UPDATE vector_documents SET metaPayload=?, updatedAt=? WHERE id=?`

### 可直接复用的代码（copy 指引）

- **[search 主流程]** `ContextSearchService.search()` 的 keyword + semantic + ranking + evidence 回填结构
- **[evidence 回填]** `getScreenshotIdsByNodeIds()` + `getEvidenceForScreenshotIds()`
- **[vector 入队幂等]** `vector-document-service.ts` 的 `vectorId=node:<id>` + `textHash` 模式

### 验收标准（DoD）

- `electron/services/screenshot-processing` 内不再引用 `contextEdges/context_edges`
- Search：
  - keyword/entity fallback 正常
  - vector semantic search 正常（HNSW → vector_documents → context_nodes）
  - thread 邻域扩展能补全同 thread 前后事件，并 respects `filters.threadId`
- IPC traverse：`CONTEXT_TRAVERSE` 可用，且 `edges=[]` 时 renderer 可降级展示
- threadId 更新后，vector metaPayload 能及时刷新（或至少触发 dirty 让后续链路可观测）

### Review Checklist

- **[彻底移除]** 是否仍存在任何 `context_edges` 读写路径（含 `batch-builder.ts` / entity 相关逻辑）
- **[过滤正确性]** thread filter 存在时，邻域扩展是否引入其它 thread 噪声
- **[性能]** thread 邻域 SQL 是否需要索引（至少评估 `context_nodes(thread_id,event_time)`）
- **[兼容性]** renderer 若仍依赖 edges，`edges=[]` 是否能正常展示
- **[FTS5]** 是否正确集成 `screenshots_fts` 做精确关键词检索
- **[Issue]** 是否支持按 `context_nodes.state_snapshot_json.issue` 进行过滤/排序

---

## M6 — ActivityTimeline

### 目的

把 ActivityTimeline 做成首版可用形态：

- **[20min 窗口]** 周期性产出 `activity_summaries`（windowStart/windowEnd = 20min）
- **[窗口事件]** 从窗口内 `context_nodes` 生成 1-3 个“窗口内事件候选”（用于 UI 展示，不承担跨窗口连续性）
- **[长事件]** **Thread 维度**判定 long event：当 `threads.durationMs >= 25min`（排除 gap>10min）时，在 **Activity Event** 级别标记为长事件（`is_long=1`），并触发 details
- **[强制生成]** 如果窗口内有 context node 属于超过 25 分钟的 thread，**必须**生成对应的 activity event
- **[解耦]** Activity Summary **不依赖 Thread 边界**：窗口内 nodes 可属于多个 thread；thread 仅用于长事件识别与连续性上下文
- **[可观测]** 复用现有 `llmUsageService` + `aiRequestTraceBuffer` + `activityAlertBuffer`

### 依赖

- M2：窗口内 screenshots 与 `context_nodes` 可回溯（至少 `context_screenshot_links` 已写）
- M4：大部分 event nodes 已有 `threadId`（用于 long thread 标记与 details 证据聚合）
- M5：Search 无 edges（ActivityTimeline 也不得依赖 edges）

### 需要改动/新增的文件

- `electron/services/screenshot-processing/activity-timeline-scheduler.ts`
  - 保留为独立 scheduler（与 pipeline 解耦），但改造“窗口触发条件/等待 VLM 完成”的逻辑以适配新 pipeline
- `electron/services/screenshot-processing/activity-monitor-service.ts`
  - summary/event/details 的 LLM 输入数据结构改为对齐 `docs/alpha-prompt-templates.md`
  - long event 判定规则从“纯 end-start”改为使用 thread 的 gap 排除时长（见下文）
- `electron/services/screenshot-processing/prompt-templates.ts`
  - 对齐新增/调整：`getActivitySummarySystemPrompt/getActivitySummaryUserPrompt`
  - 对齐新增/调整：`getActivityEventDetailsSystemPrompt/getActivityEventDetailsUserPrompt`
- `electron/services/screenshot-processing/schemas.ts`
  - 确保 `ActivityWindowSummaryLLMProcessedSchema` / `ActivityEventDetailsLLMProcessedSchema` 与 prompt schema 一致

### TODO（Implementation Checklist）

- [ ] 适配窗口 seed 与等待策略：窗口生成与处理不应被 processing 卡死（nextRunAt/attempts 策略明确）。
- [ ] Summary/Event/Details 的 prompt 与 schema 对齐 `docs/alpha-prompt-templates.md`，并接入 llmUsage + trace + activityAlert。
- [ ] long event：基于 `threads.durationMs >= 25min`（gap 排除）派生并 upsert `eventKey=thr_<threadId>`。
- [ ] details 严格 on-demand（用户请求时生成），重试/失败口径与 `maxAttempts` 对齐。

### 设计要点

#### 1) Window seeding（20min）

复用 `ActivityTimelineScheduler.seedPendingWindows()` 的整体机制，但明确首版的窗口生成策略：

- **[窗口边界]** `generationIntervalMs = 20 * 60 * 1000`
- **[seed 范围]**
  - `from = floorToWindow(appStartedAt - backfillMs)`（例如回填 2h）
  - `to = floorToWindow(now - safetyDelayMs)`（例如延迟 2min，避免截断当前窗口）
- **[幂等]** `activity_summaries.idempotencyKey = win_<windowStart>`（已是 unique）

建议配置（首版可复用/微调现有 `processingConfig.activitySummary`）：

- `generationIntervalMs = 20min`
- `seedBackfillMs = 2h`
- `seedSafetyDelayMs = 2min`

#### 2) 生成 summary 的输入数据：以“窗口内截图”为准

沿用当前实现的关键原则（强烈建议保留）：

- **先按 window 选 screenshots**（`screenshots.ts in [windowStart, windowEnd)`）
- 再通过 `context_screenshot_links` join 回 `context_nodes`

原因：即使未来发生 node merge / link 扩散，summary 仍应严格以“窗口内发生的截图证据”为准，避免跨窗口污染。

对齐 `docs/alpha-prompt-templates.md`（Activity Summary 输入 schema）：

- `window_start/window_end`
- **[Long Thread Context]** `long_threads: LongThreadContext[]`：
  - 数据来源：从窗口内 context_nodes 的 `thread_snapshot_json` 聚合而成（非实时查询 threads 表，确保数据一致性）
- `context_nodes: ContextNode[]`
  - 映射建议：
    - `node_id` = node.id
    - `title/summary/event_time/thread_id/importance` = 来自 `context_nodes`
    - `app_hint`：来自窗口内 screenshots 去重后的主 app（或取 node 对应 screenshots 的 top app）
    - `entities/keywords`：从 JSON 字段 parse 并做小上限截断
    - `knowledge_json/state_snapshot_json`：从 `context_nodes.knowledge_json` / `context_nodes.state_snapshot_json` 提取对应字段
- `stats: { top_apps; top_entities; thread_count; node_count }`
- `nowTs/todayStart/todayEnd/yesterdayStart/yesterdayEnd/weekAgo`：本地时区计算（复用现有 time window helpers）

输入裁剪（避免 prompt 过大）：

- `context_nodes` 限制 maxN（例如 50）；按 `importance DESC, event_time ASC` 取样
- 每个节点的 `summary/title` 截断（例如 300/120 chars）

#### 3) Summary 输出落库

LLM 输出对齐 prompt schema：

- `title`（≤100 chars）
- `summary`（markdown，固定 4 sections）
- `highlights`（max 5）
- `stats`（必须与输入一致，不可引入新 app/entity）
- `events`（1-3 candidates）

落库：

- `activity_summaries.title/summary/highlights/stats/status`

并触发：

- `emitActivityTimelineChanged(windowStart, windowEnd)`（现有逻辑）

#### 4) 窗口事件（Window Events，不跨窗口）

对齐你的动机第 3 点：**Activity Summary 不依赖 Thread 边界**。因此这里的 events 只用于“窗口内可视化”，不承担跨窗口连续性（跨窗口连续性由 Thread 提供）。

实现建议：

- 仍使用 Activity Summary LLM 输出的 `events: ActivityEventCandidate[]` 作为窗口内事件候选（1-3 个）
- 事件的 `start/end` 仅在窗口内（offset 0-20min），不尝试与其它窗口 merge
- 可把这些窗口事件写入 `activity_events` 表，但需要明确它们是 window-scoped：
  - `eventKey = win_<windowStart>_evt_<idx>_<hash>`（稳定幂等）
  - `threadId` 可写可不写：
    - 如果该事件的 `node_ids` 的 primary node 有 threadId，则写入，便于 UI 做“属于哪个 thread”的展示
- `is_long = 0`（普通窗口事件）

> 说明：如果不希望 `activity_events` 混入窗口事件，也可以只把 events 存进 `activity_summaries`（新增 json 字段）。但这会涉及 schema 变更；首版可先沿用现有表。

#### 5) 长事件（Long Event = Long Thread）

**核心逻辑变更**：`is_long` 标记现在位于 **Activity Event** 级别，而非 Summary 级别。

对齐你的动机第 2 点：**长事件判定来自 Thread.duration_ms（排除 gap>10min）**。

因此长事件不应该由“窗口事件跨窗口 merge”推导，而应该从 `threads` 派生：

- 当 `threads.durationMs >= processingConfig.thread.longEventThresholdMs`（25min）时：
  - upsert 一条 long event 记录（建议仍落在 `activity_events`，用于 timeline marker 与 details 入口）

建议 eventKey 与字段：

- `eventKey = thr_<threadId>`（1 thread 对应 1 条 long event 记录；thread inactive 后仍保留）
- `threadId = <threadId>`
- `startTs = threads.startTime`
- `endTs = threads.lastActiveAt`
- `durationMs = threads.durationMs`（注意：这里的语义是 gap 排除后的累计时长，优先满足你的动机）
- `is_long = 1`
- `title/kind/confidence/importance`：
  - `title` 可直接用 `threads.title`
  - `kind` 初版可默认 `work`（后续再从窗口事件/统计中学习更精确的 kind）
  - `confidence/importance` 可设为常量（例如 6/6）或从 thread 的最近 nodes 聚合
- `nodeIds`：可写入该 thread 的 nodes（建议 cap，例如最近 200 条；用于 details 证据）

触发时机：

- 在 `ActivityTimelineScheduler.runCycle()` 中：每轮在处理完 pending summaries 后执行一次 `syncLongEventsFromThreads()`
  - 扫描 `threads.status='active'` 且 `durationMs >= threshold`
  - upsert long event rows
  - 仅负责 upsert `is_long=1` 的 long event 记录；`details` 由用户点击触发生成（沿用当前 on-demand 实现）

#### 6) details 按需触发（长事件）

现状：

- `getEventDetails(eventId)` 对 `is_long && details==null` 会直接调用 `generateEventDetails(eventId)`（即时生成）
- details 仅在用户点击/请求时生成（不在调度中自动生成）

首版建议：

- **[只对 long event]** 只有 `is_long=1` 才允许进入 details LLM（即由长 thread 产生的 activity event）
- **[输入证据]** details 的 `context_nodes` 应以 thread 为中心聚合：
  - `SELECT * FROM context_nodes WHERE kind='event' AND thread_id=? ORDER BY event_time ASC`
  - 结合 `context_screenshot_links -> screenshots` 补齐 `appHint/ocrText/sourceUrl` 等证据字段
  - 对 nodes 做 cap（例如最近 60-120 条，或按 importance 采样），避免 prompt 过大
- **[Markdown 结构]** 严格遵循三段式大纲：
  1. **Session Activity** (本阶段工作)
  2. **Current Status & Progress** (当前最新进度)
  3. **Future Focus & Next Steps** (后续关注)
- **[Prompt 对齐]** 对齐 `docs/alpha-prompt-templates.md` 的 Activity Event Details 输入/输出 schema

details 输入裁剪：

- nodeIds 取 Top-K（例如 60）：按 `eventTime` 或 importance 采样
- 对每个 node 只携带必要字段（title/summary/knowledge/stateSnapshot/entities/appHint/eventTime）

details 输出落库：

- `activity_events.details`（markdown）
- `detailsStatus/detailsAttempts` 仅用于记录 on-demand 生成结果（succeeded/failed/failed_permanent）；不由 scheduler 驱动

#### 7) 阻塞条件：等待 VLM/Thread 基本就绪

现有实现对窗口内“VLM 仍在跑”会把 summary 置为 `Processing` 并自适应 nextRunAt。

首版保留该机制，但判定条件需更贴合新 pipeline：

- 只要窗口内关联的 `batches.vlm_status in (pending,running)` 或 `failed but retryable`，就保持 Processing
- **不等待 thread assignment**：threadId 缺失不阻塞窗口 summary（符合“summary 不依赖 thread 边界”）；长事件会在 threadId 补齐后由 `syncLongEventsFromThreads()` 追补

### 可直接复用的代码（copy 指引）

- **[scheduler 模板]** `activity-timeline-scheduler.ts`（seed + stale recovery + due 扫描 + nextRunAt）
- **[LLM 调用结构]** `activity-monitor-service.ts` 已完整具备：
  - `generateObject` + zod processed schema
  - `llmUsageService.logEvent` + `aiRequestTraceBuffer.record`
  - semaphore + timeout + circuit breaker
- **[窗口事件落库]** 当前 `generateWindowSummary()` 内的 `upsertEvent()` 写入路径可继续复用（但事件不跨窗口 merge）
- **[长事件派生]** 新增 `syncLongEventsFromThreads()`：从 `threads.durationMs/startTime/lastActiveAt` upsert `eventKey=thr_<threadId>` 的 long event

### 验收标准（DoD）

- Scheduler 能周期性 seed 窗口并推进 `activity_summaries` 到 `succeeded`
- summary 的 prompt/schema 与 `docs/alpha-prompt-templates.md` 对齐（字段名与硬规则一致）
- 窗口事件能写入 `activity_events`（window-scoped，不跨窗口 merge；`eventKey=win_<windowStart>_...` 幂等）
- long event 能从 `threads` 派生并 upsert 到 `activity_events`（`eventKey=thr_<threadId>`，`durationMs=threads.durationMs`）
- long event 判定与规则一致（25min，gap 排除；以 `threads.durationMs` 为准；并写入 `activity_events.durationMs`）
- long event 的 details：
  - UI 请求时可即时生成
  - 不在 scheduler 中自动生成
- 生成过程有 llmUsage + trace + activityAlert（timeout/overdue 等）记录

### Review Checklist

- **[边界一致性]** window 内 evidence 是否严格来自 window 内 screenshots（避免跨窗口污染）
- **[数据一致性]** `long_threads` 是否从 `thread_snapshot_json` 聚合（而非实时查询 threads 表，确保数据一致性）
- **[长事件规则]** `is_long` 是否标记在 Event 级别，且 `durationMs` 遵循 gap 排除规则
- **[强制生成]** 是否为窗口内所属长 thread 的节点生成了对应的 activity event
- **[Markdown 结构]** Details 输出是否符合严格的三段式大纲
- **[幂等]** 同一 window 重跑不会生成重复窗口事件（`eventKey=win_<windowStart>_...` 稳定）
- **[幂等]** 同一 thread 重跑不会生成重复 long event（`eventKey=thr_<threadId>` 稳定）
- **[裁剪]** prompt size 是否可控（nodes cap / 字段截断是否合理）
- **[等待策略]** Processing 分支是否会把窗口卡死（attempts 回滚/nextRunAt 自适应是否合理）

---

## M7 — Monitoring/Queue Inspector

### 目的

把监控面板（Performance Monitor / AI Monitor）与 `QueueInspector` 适配到新状态机与队列结构，做到“出了问题能一眼看出卡在哪一段”。

- **[队列可见性]** 展示 pipeline 的关键 backlog：
  - `batches.vlm_status`（VLM 队列）
  - `screenshots.ocrStatus`（OCR 队列，M0 增加）
  - `batches.thread_llm_status`（Thread LLM 队列，M4 增加）
  - `vector_documents.embeddingStatus/indexStatus`（已存在）
  - `activity_summaries.status`（已存在）
  - （可选）`activity_events.detailsStatus`（用户点击生成 long event details 后的状态）
- **[健康指标准确]** `Queue Backlog` 的 pending 统计覆盖新队列
- **[兼容演进]** 保持本地只读、低开销（每 5s groupBy），但字段可持续扩展

### 依赖

- M0：`screenshots.ocrStatus` / OCR retry 字段已落 schema（否则无法统计 OCR queue）
- M4：`batches.thread_llm_*` 已落 schema
- M6：long event 以 `threads.durationMs` 派生 `activity_events.is_long=1`（可选统计 detailsStatus）

### 需要改动/新增的文件

- `electron/services/monitoring/monitoring-types.ts`
  - 扩展 `QueueStatus` 类型，加入新队列字段
- `electron/services/monitoring/queue-inspector.ts`
  - 新增对 `screenshots`/`batches.thread_llm_status`/（可选）`activity_events.detailsStatus` 的统计
  - 更新 `getTotalPendingCount()` 的累计逻辑
- `electron/services/monitoring/static/dashboard.html`
  - Queue Status 表格新增行 + i18n 文案 + JS 显示绑定

### TODO（Implementation Checklist）

- [ ] 扩展 `monitoring-types.QueueStatus`：新增 VLM/OCR/Thread LLM（可选 details）队列字段。
- [ ] `QueueInspector.getQueueStatus()`：补齐新队列 groupBy 统计；`getTotalPendingCount()` 纳入 pending+running。
- [ ] dashboard.html：新增 DOM 行 + en/zh-CN 文案 + 前端绑定（/api/queue + SSE）。

（通常无需改动）

- `electron/services/monitoring/monitoring-server.ts`
  - `GET /api/queue` 与 SSE 已通用；只要 `QueueStatus` 扩展即可自动生效

### 设计与实现细节

#### 1) 扩展 `QueueStatus`（类型层）

在 `monitoring-types.ts` 把 `QueueStatus` 扩展为（示意）：

- `batchesVlm: { pending; running; failed }`
- `screenshotsOcr: { pending; running; failed }`
- `batchesThreadLlm: { pending; running; failed }`
- （可选）`activityEventDetails: { pending; running; failed }`

失败口径沿用现有约定：`failed + failed_permanent`。

#### 2) `QueueInspector.getQueueStatus()`：新增统计项

复用 `countByStatus(db, table, statusColumn)`（已有 try/catch，不会让监控直接崩）。

- **Batches VLM**：`countByStatus(db, batches, "vlm_status")`
- **Screenshots OCR**：`countByStatus(db, screenshots, "ocrStatus")`
- **Batches Thread LLM**：`countByStatus(db, batches, "thread_llm_status")`
- （可选）**Activity Event Details**：`countByStatus(db, activityEvents, "detailsStatus")`
  - 注意：这不是后台队列，只是“用户触发 details 后是否卡住/失败”的诊断指标

然后映射成 `pending/running/failed`。

#### 3) `getTotalPendingCount()`：纳入新队列

为了让 Health 卡片 `Queue Backlog` 能反映真实积压，把以下项加入总和：

- `batchesVlm.pending + batchesVlm.running`
- `screenshotsOcr.pending + screenshotsOcr.running`
- `batchesThreadLlm.pending + batchesThreadLlm.running`
- （可选）`activityEventDetails.pending + activityEventDetails.running`

#### 4) Dashboard（UI）队列表格与文案

在 `monitoring/static/dashboard.html`：

- Queue table 增加行与 DOM id：
  - `queue-batch-vlm-pending/running/failed`
  - `queue-screenshot-ocr-pending/running/failed`
  - `queue-batch-thread-llm-pending/running/failed`
  - （可选）`queue-event-details-pending/running/failed`
- i18n translations 增加 key：
  - `monitoring.queue.batchVlm`
  - `monitoring.queue.screenshotOcr`
  - `monitoring.queue.batchThreadLlm`
  - （可选）`monitoring.queue.eventDetails`
- JS 更新逻辑：从 `/api/queue` 与 SSE `queue` 消息写入对应 DOM。

#### 5) AI Monitor（可选增强）

AI Monitor 主要依赖 `llm_usage_events` 与 `aiRequestTraceBuffer` 的 `operation` 命名。建议确保以下 operation 命名一致，方便过滤排查：

- `thread_assign`
- `vlm_index`
- `ocr_extract`
- `text_expand`
- `text_summary`
- `activity_event_details`

### 可直接复用的代码（copy 指引）

- **[统计模板]** `QueueInspector.countByStatus()`
- **[SSE 推送]** `MonitoringServer.broadcastMessage({type:"queue"})`（无需重写）
- **[i18n 结构]** `dashboard.html` 内 `translations.en` / `translations["zh-CN"]`

### 验收标准（DoD）

- Dashboard 的 Queue Status 表格展示新增 3 条队列：VLM / OCR / Thread LLM
- `GET /api/queue` 与 SSE 的 `queue` payload 包含新增字段，且 UI 正常更新
- `Queue Backlog`（健康卡片）数值包含新增队列的 pending/running
- 当人为制造积压（例如大量 pending screenshots）时，监控能准确显示“卡在 VLM / OCR / Thread LLM 哪一段”

### Review Checklist

- **[类型一致]** `monitoring-types.QueueStatus` 与 `queue-inspector` 返回结构一致，避免前端读 undefined
- **[失败口径]** failed 是否合并 `failed_permanent`
- **[开销]** 监控查询仍保持轻量（每 5s 多几条 groupBy，不引入高频全表扫描）
- **[i18n]** 新增行在 en/zh-CN 文案齐全

---

## M8 — Hardening

### 目的

把新 pipeline 从“能跑”提升到“可长期稳定运行、可恢复、可诊断”，重点解决：

- **[幂等]** 任何 scheduler / LLM 调用 / upsert 在 crash 或重跑后不会制造重复数据
- **[崩溃恢复]** `running` 卡死可自动回收、重试窗口清晰、不会吞任务
- **[资源清理]** 临时截图文件、trace buffer、无用记录按策略清理
- **[回归清单]** 明确“必须不坏”的核心链路

### 依赖

- M0-M7：各队列/状态机已接入

### 需要改动/新增的文件

- `electron/services/screenshot-processing/*-scheduler.ts`
  - 对齐统一的 stale recovery / claim / retry 口径
- `electron/services/screenshot-processing/*-repository.ts`（若已有/新增）
  - 抽出关键写入的“单事务 + 幂等”封装
- `electron/services/screenshot-processing/config.ts`
  - 增加 hardening 相关配置（cleanup、stale 阈值、cap 上限等）
- `electron/services/monitoring/*`
  - 确保错误/告警能覆盖所有新状态机

### TODO（Implementation Checklist）

- [ ] 统一 stale recovery：覆盖 VLM/OCR/Thread/Vector/ActivitySummary（以及 on-demand details 的“状态修复”）。
- [ ] 统一 retry 策略：`maxAttempts=2`、`delayMs=60s`，并确保 `failed_permanent` 不再被调度。
- [ ] 兜底 cleanup：扫描过久的 `storageState="ephemeral"` 文件并删除（崩溃/永久失败场景）。
- [ ] 队列膨胀保护：每轮 scan/claim 增加 cap（避免大表扫描/长事务）。
- [ ] 处理 BatchBuilder 幂等性：评估并落地稳定的 content-based `idempotencyKey`（避免崩溃恢复产生重复 batch）。

### 设计与实现细节

#### 1) 幂等契约（按表/写入点列清楚）

1. **`batches`**
   - `idempotencyKey` 必须稳定（sourceKey + tsStart/tsEnd + screenshotIds hash）
   - 重跑同一 batch：
     - 不重复创建 batch
     - shardStatus/indexJson 可以覆盖更新
   - Thread LLM：写入 `thread_llm_status`/`thread_llm_attempts`/`thread_llm_next_run_at` 必须遵循“claim 后才能变 running”

2. **`screenshots`**
   - VLM/OCR 相关字段更新必须只由对应状态机推进
   - 对于 OCR：只要 `ocrText` 已存在且 `ocrStatus=succeeded`，不得重复跑 OCR

3. **`context_nodes`**
   - `originKey`（若启用）保持唯一：避免重复插入同一截图对应 node
   - `mergeStatus/embeddingStatus` 的推进必须幂等：重复执行只会重复写相同结果，不会产生新 node
   - `threadId` 与 `thread_snapshot_json` 写入：ThreadScheduler 必须原子化写入这两个字段；允许 null → id/snapshot，禁止覆盖已有值。
   - `threadId` 写入：ThreadScheduler 允许覆盖 null→id，但禁止 id→另一个 id（除非明确的 reassign policy）

4. **`vector_documents`**
   - `vectorId=node:<nodeId>` 唯一
   - `textHash` 命中时允许刷新 `metaPayload`（尤其 threadId），但不重置 embedding/index 状态

5. **`activity_summaries`**
   - `idempotencyKey=win_<windowStart>` 唯一
   - 重跑同一 window：summary 可覆盖更新；不得制造重复窗口记录

6. **`activity_events`**（语义）
   - window event：`eventKey=win_<windowStart>_evt_<idx>_<hash>` 唯一
   - long event：`eventKey=thr_<threadId>` 唯一；`activity_events.durationMs` **语义固定为** gap 排除的 `threads.durationMs`
   - details：**严格 on-demand** 生成（用户点击/请求时生成），重复点击复用同一条 event row，仅更新 details/status/attempts

#### 2) Crash/Stale Recovery（统一口径）

目标：任意 scheduler crash 后重启，最多在 `staleRunningThresholdMs` 后恢复。

统一规则：

- 任何任务进入 `running` 必须写 `updated_at=now`（或同等字段）
- scheduler 每轮优先执行 `recoverStaleStates()`：
  - `status='running' AND updated_at < now - staleRunningThresholdMs` → 回滚到 `pending`（或 `failed`）
  - 清空 `*_next_run_at`（让其尽快被再次 claim）

需要覆盖的状态机：

- **Batch VLM**：`batches.vlm_status` + shards 状态（如果 shard 局部 running，需要整体回滚策略）
- **OCR**：`screenshots.ocrStatus`
- **Thread LLM**：`batches.thread_llm_status`
- **Vector Docs**：`vector_documents.embeddingStatus/indexStatus`（已有 pattern）
- **Activity Summaries**：`activity_summaries.status`（已有 pattern）
- **Activity Event Details（on-demand）**：`activity_events.detailsStatus`
  - 不由 scheduler 推进生成
  - 但需要“卡死自愈”：若 `detailsStatus='running'` 且 `updated_at` 超过 `staleRunningThresholdMs`，在下一次用户请求 details 时先重置为 `failed`/`pending`（只做状态修复，不做生成）

#### 3) Retry / Permanent Failure 的统一策略

复用 `processingConfig.retry`：

- `maxAttempts`
- `delayMs`

约定：

- `failed`：可重试（attempts++，\*\_next_run_at=now + delayMs）
- `failed_permanent`：不再重试（同时在 monitoring 中计入 failed）

补充（on-demand details 特例）：

- `activity_events.detailsStatus` 不走 scheduler 的 `nextRunAt`；仅在用户触发时尝试生成
- 达到 `maxAttempts` 后将 details 标记为 `failed_permanent`（避免无限点击触发重试）

#### 4) Cleanup（资源与数据的生命周期）

1. **临时截图文件**
   - 复用现有 retention/cleanup loop（模块内已有 cleanup 机制）
   - 核心不变量：
     - 只在 `storageState` 允许时删除
     - 删除后更新 `storageState=deleted` 并记录 `retentionExpiresAt`

2. **兜底 Cleanup（Fallback Cleanup）**

   > [!IMPORTANT]
   > 为处理异常情况（崩溃、永久失败等），保留一个兜底清理机制。
   > 详见上方 [截图文件生命周期（Image Lifecycle）](#截图文件生命周期image-lifecycle) 章节。

   ```typescript
   // 启动时或定期执行
   async fallbackCleanup(): Promise<void> {
     const maxAgeMs = 24 * 60 * 60 * 1000; // 24 小时
     const now = Date.now();

     // 查找过期的 ephemeral 文件
     const staleScreenshots = await db.select()
       .from(screenshots)
       .where(
         and(
           eq(screenshots.storageState, "ephemeral"),
           lt(screenshots.createdAt, now - maxAgeMs),
           isNotNull(screenshots.filePath)
         )
       );

     for (const ss of staleScreenshots) {
       await safeDeleteCaptureFile(ss.filePath);
       await db.update(screenshots)
         .set({ storageState: "deleted", updatedAt: now })
         .where(eq(screenshots.id, ss.id));
     }
   }
   ```

3. **队列膨胀保护**
   - 为每类队列增加 cap：
     - 例如单次扫描最多 claim N 个（避免大表扫描 + 长事务）
   - 为 `aiRequestTraceBuffer` / `activityAlertBuffer` 已是 ring buffer，无需额外清理

4. **老数据清理（可选）**
   - `llm_usage_events` 可按天聚合/裁剪（若增长过快）
   - `vector_documents` 可提供“重建索引”路径（不在 M8 强制做，但要写出操作手册）

#### 5) 观测与诊断（最少但够用）

- 所有 LLM 调用必须：
  - `llmUsageService.logEvent()`（成功/失败）
  - `aiRequestTraceBuffer.record()`（响应预览/错误预览）
- 所有队列卡住/超时/长等待必须：
  - `activityAlertBuffer.record()` 或等价告警
- Monitoring（M7）必须能看到：
  - VLM/OCR/Thread LLM/Vector/ActivitySummary 的 pending/running/failed

### 回归清单（Regression Checklist，执行顺序）

1. **Capture → Batch → VLM**
   - 连续截图进入 batch
   - VLM 成功后 batches.vlm_status 进入 succeeded

2. **Batch → Context Node**
   - 每张截图只产生 1 个 context node
   - node 与 screenshot link 可回溯

3. **OCR（只在需要时）**
   - 只对满足条件的截图 OCR
   - 失败可重试，超过 maxAttempts 进入 failed_permanent

4. **ThreadScheduler**
   - threadId 正确写回 nodes
   - threads.durationMs 规则正确（gap 排除）

5. **Vector Docs**
   - metaPayload.threadId 在 thread 变更后能刷新
   - embedding/index 状态机可恢复

6. **ActivityTimeline**
   - window summary 按 20min 生成
   - long event（thr\_<threadId>）能派生，且 durationMs=threads.durationMs
   - details 用户点击可生成（重复点击幂等）

7. **Monitoring**
   - Queue Status 反映真实积压
   - AI Monitor 能看到关键 operation

### 验收标准（DoD）

- 任意时刻强制退出 app 并重启：
  - 所有 stuck `running` 状态在 `staleRunningThresholdMs` 后自动恢复
  - 不会制造重复 batch / event / long event
- 大量数据下（>10k screenshots 级别）监控与队列扫描仍可接受（不出现明显卡顿）
- 所有新路径的失败都能在 `llm_usage_events` 与 monitoring 中定位

### Review Checklist

- **[幂等]** 每个表的 unique key 与 upsert 行为是否与实现一致
- **[事务]** 关键写入是否在单事务内完成（特别是 thread assign + node 更新 + long event upsert）
- **[恢复]** stale recovery 是否覆盖所有新增状态机（OCR / thread_llm_status）
- **[清理]** 任何 cleanup 都不应影响证据可回溯（links 仍可用/或降级明确）
- **[Batch IdempotencyKey]** Alpha 版本 `batch-builder.ts` 将 `idempotencyKey`（content-based hash）改为 `batchId`（UUID）：
  - 旧版：`idempotencyKey = vlm_batch:<sourceKey>:<tsStart>-<tsEnd>:<screenshotIdsHash>`，保证相同内容的 batch 不会重复入库
  - 新版：使用 `crypto.randomUUID()` 生成 `batchId`，通过 `batchId` 判断冲突
  - **Concern**：崩溃恢复场景下，如果 `SourceBufferRegistry` buffer 已 drain 但 `persistBatch` 未完成，重启后可能产生重复 batch（新 UUID ≠ 旧 UUID）
  - **当前保护**：`screenshots.batchId` 检查可防止同一 screenshot 被分配到多个 batch，但无法防止创建空 batch 或部分重叠的 batch
  - **建议**：评估是否需要恢复 content-based idempotencyKey（例如基于 screenshotIds hash），或确认 buffer drain + screenshot 检查组合足够
