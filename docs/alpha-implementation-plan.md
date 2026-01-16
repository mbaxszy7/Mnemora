# Screenshot Processing Alpha - Implementation Plan

## 目标

重构 screenshot-processing 模块，简化数据模型和处理流程：
- **简化**：每个截图产生一个 Context Node（而非多类型多节点）
- **简化**：移除 context_edges，用 Thread 表达连续性
- **新增**：Thread 机制，跨窗口追踪用户活动
- **优化**：混合 OCR 策略（本地 OCR + VLM 结构化提取）

---

## 重构动机

### 1. 简化数据模型
- **现状**：当前每个截图可能产生多种类型、多个节点（如 activity、entity、knowledge 等），数据结构复杂。
- **目标**：**每个截图产生一个 Context Node**，所有信息（实体、知识、状态快照等）作为该节点的字段，而非独立节点。

### 2. 移除 context_edges，用 Thread 表达连续性
- **现状**：使用 `context_edges` 表来表达节点之间的关系，增加了图操作的复杂性。
- **目标**：引入 **Thread 机制**，跨时间窗口追踪用户活动的连续性。Thread 作为一等公民，替代复杂的边关系。

### 3. 优化 OCR 策略
- **现状**：OCR 在截图后立即执行，无论是否需要。
- **目标**：采用 **混合 OCR 策略**：
  - VLM 先分析截图，判断是否包含 `knowledge` 类内容（文档/博客/教程）。
  - 仅对 VLM 识别为 `knowledge` 且语言为中/英文的截图执行本地 OCR（Tesseract.js）。
  - 减少不必要的 OCR 调用，节省资源。

### 4. Thread 跨窗口追踪与长事件检测

**核心需求**：Thread 可以跨越多个 Activity Summary 窗口，当 Thread 的时间跨度 ≥ 25 分钟时，识别为"长事件"。

**具体示例**：

```
时间轴
├── Activity Summary 窗口 1 (00:00 - 00:20)
│   ├── Context Node: a, b, c, d
│   ├── Thread 1: 包含 a, c
│   └── Thread 2: 包含 b, d
│
└── Activity Summary 窗口 2 (00:20 - 00:40)
    ├── Context Node: e, f, g, h, i
    ├── Thread 2: 包含 e, f  ← 延续自窗口 1 的 Thread 2
    └── Thread 3: 包含 g, h, i  ← 新识别的 Thread
```

**说明**：
1. **Thread 2 跨窗口延续**：
   - 窗口 1 中的节点 `b, d` 属于 Thread 2。
   - 窗口 2 中的节点 `e, f` 被 Thread LLM 识别为与 Thread 2 相关，因此归入 Thread 2。
   - Thread 2 现在跨越了两个窗口，时间跨度可能超过 25 分钟。

2. **长事件判定与 Activity Event 生成**：
   - `Thread.duration_ms` 累计计算（排除超过 10 分钟的 gap）。
   - 当 `Thread.duration_ms >= 25 分钟` 时，在 **Activity Event** 中将其标记为"长事件"（`is_long = 1`）。
   - **强制生成规则**：如果窗口内有 context node 属于超过 25 分钟的 thread，**必须**生成对应的 activity event。
   - Activity LLM 同时分析其余 context nodes，生成关键 activity events 的总结。
   - Activity Event 落库后，对超 25 分钟 thread 对应的 event 设置 `is_long = 1`。
   - 长事件的 `details` 是**按需生成**的（用户点击时触发），不在 Summary 阶段生成。

3. **Activity Summary 流程**：
   - Activity Summary 按固定 20 分钟窗口生成。
   - 每 20 分钟获取该时间窗口内的 context nodes。
   - 检查这些 context nodes 是否有属于超过 25 分钟的 thread 时间线。
   - **数据一致性保证**：长事件 thread 信息从 **context_nodes.thread_snapshot_json** 读取，而非实时查询 threads 表。
     - Thread 快照在 Thread LLM 分配节点时捕获，反映当时的 thread 状态。
     - 避免 Activity Summary 延迟执行时读取到超前的 thread 信息。
   - **LongThreadContext**（从 context_nodes.thread_snapshot_json 聚合）：
     ```typescript
     interface LongThreadContext {
       thread_id: string;
       title: string;
       summary: string;
       duration_ms: number;            // 快照时刻的 duration
       start_time: number;
       last_active_at: number;         // 窗口内最后活跃时间（从 context_nodes.event_time 取最大值）
       current_phase?: string;         // 可选
       main_project?: string;          // 可选
       node_count_in_window: number;   // 当前窗口内属于此 thread 的节点数
     }
     ```
   - LLM 返回后：Activity Summary 落库 → Activity Events 落库 → 对长事件设置 `is_long = 1`。

---


## 数据库 Schema 设计

> [!NOTE]
> 所有新表在原有 `electron/database/schema.ts` 中实现，不创建独立文件。

### 1. screenshots 表

```sql
CREATE TABLE screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL,         -- screen:<id> 或 window:<id>
  ts INTEGER NOT NULL,              -- 截图时间戳 (ms)
  phash TEXT NOT NULL,              -- 感知哈希 (16 字符 hex)
  
  -- 元数据（不存储 filePath，VLM 后删除图片）
  -- 按 app 截图时：来自截图元数据
  -- 按 screen 截图时：由 VLM 根据 popular app 配置提取
  app_hint TEXT,
  window_title TEXT,
  width INTEGER,
  height INTEGER,
  
  -- OCR 文本（VLM 判断需要后由本地 OCR 提取，最多 8000 字符）
  ocr_text TEXT,
  ocr_status TEXT,                  -- null|pending|running|succeeded|failed
  
  -- Batch 关联
  batch_id INTEGER REFERENCES batches(id),
  
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_screenshots_source_key ON screenshots(source_key);
CREATE INDEX idx_screenshots_ts ON screenshots(ts);
CREATE INDEX idx_screenshots_batch_id ON screenshots(batch_id);
```

---

### 1.1 截图文件生命周期（Image Lifecycle）

> [!IMPORTANT]
> 截图文件仅在 VLM/OCR 处理期间临时保留，处理完成后立即删除以节省磁盘空间。
> 使用现有 `screenshots.filePath` 和 `screenshots.storageState` 字段追踪文件状态。

#### Schema 字段说明

```typescript
// electron/database/schema.ts
filePath: text("file_path"),                      // 截图文件路径
storageState: text("storage_state", {
  enum: ["ephemeral", "persisted", "deleted"],    // 存储状态
}),
```

| storageState | 含义 | 何时设置 |
|--------------|------|----------|
| `ephemeral` | 临时文件，待处理 | 截图入库时初始值 |
| `deleted` | 文件已删除 | VLM/OCR 处理完成后 |
| `persisted` | 用户主动保留（可选功能） | 预留扩展，当前不使用 |

#### 生命周期阶段图

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
│  │ VLM 处理                                                  │               │
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
│  │ OCR 处理                         │      │ ✅ VLM 完成后删除            │ │
│  │ • 从 filePath 读取图片           │      │    storageState = "deleted"  │ │
│  │ • 裁剪 text_region               │      │    safeDeleteCaptureFile()   │ │
│  │ • Tesseract.js OCR               │      └──────────────────────────────┘ │
│  │ • ocr_text 存入 screenshots 表   │                                       │
│  └──────────────────────────────────┘                                       │
│             │                                                                │
│             ▼                                                                │
│  ┌──────────────────────────────────┐                                       │
│  │ ✅ OCR 完成后删除                 │                                       │
│  │    storageState = "deleted"      │                                       │
│  │    safeDeleteCaptureFile()       │                                       │
│  └──────────────────────────────────┘                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 关键设计决策

| 设计点 | 决策 | 理由 |
|-------|------|------|
| **filePath 入库** | `screenshots.filePath = 实际路径` | 需要在 VLM/OCR 处理时从 DB 读取文件位置。 |
| **storageState 追踪** | 使用 `ephemeral → deleted` 状态转换 | DB 记录文件是否已删，避免重复删除或读取已删文件。 |
| **删除时机** | VLM 成功后（无 OCR）或 OCR 成功后（有 OCR） | 确保图片在被需要时可用，用完即删。 |
| **删除失败容错** | `safeDeleteCaptureFile()` 静默失败，不阻断流程 | 删除失败仅记录日志，依赖后续 cleanup 机制。 |

#### 实现代码要点

```typescript
// BatchVLMScheduler: VLM 成功后
async processOneBatch(batch: Batch): Promise<void> {
  // 1. 从 DB 读取 filePath 并加载图片 Base64
  const screenshotRecords = await db.select().from(screenshots).where(...);
  const images = await loadBatchImages(screenshotRecords);
  
  // 2. 调用 VLM
  const vlmResult = await callVLM(images);
  
  // 3. 落库 context_nodes / 设置 ocrStatus
  await persistVLMResults(vlmResult);
  
  // 4. 删除不需要 OCR 的图片
  for (const ss of screenshotRecords) {
    if (ss.ocrStatus === null && ss.storageState !== "deleted") {
      await safeDeleteCaptureFile(ss.filePath);
      await db.update(screenshots)
        .set({ storageState: "deleted", updatedAt: Date.now() })
        .where(eq(screenshots.id, ss.id));
    }
  }
}

// OCRScheduler: OCR 成功后
async processOneScreenshot(ss: ScreenshotRecord): Promise<void> {
  // 检查文件是否已删除
  if (ss.storageState === "deleted" || !ss.filePath) {
    throw new Error("Screenshot file not available");
  }
  
  // 1. 读取并裁剪图片
  const imageBuffer = await loadAndCropImage(ss.filePath, ss.textRegion);
  
  // 2. OCR
  const ocrText = await ocrService.recognize(imageBuffer);
  
  // 3. 更新 screenshots.ocr_text
  await updateOcrText(ss.id, ocrText);
  
  // 4. 删除图片并更新 storageState
  await safeDeleteCaptureFile(ss.filePath);
  await db.update(screenshots)
    .set({ storageState: "deleted", updatedAt: Date.now() })
    .where(eq(screenshots.id, ss.id));
}
```

#### 与 Cleanup Loop 的关系

> [!NOTE]
> 新 pipeline **不再依赖周期性 cleanup loop**。图片删除由处理流程主动触发，而非等待 TTL 过期。

| 场景 | 处理方式 |
|------|----------|
| VLM 成功 + 无 OCR | VLM 完成后立即删除，设置 `storageState = "deleted"` |
| VLM 成功 + 需要 OCR | OCR 完成后立即删除，设置 `storageState = "deleted"` |
| VLM 失败 | 图片保留（`storageState = "ephemeral"`），VLM 重试时需要；达到 `failed_permanent` 后由兜底 cleanup 清理 |
| OCR 失败 | 图片保留（`storageState = "ephemeral"`），OCR 重试时需要；达到 `failed_permanent` 后由兜底 cleanup 清理 |
| App 崩溃 | 下次启动时，扫描 `storageState = "ephemeral"` 且 `createdAt` 过久的记录，执行兜底清理 |

#### 兜底 Cleanup（Fallback Cleanup）

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

### 2. batches 表

```sql
CREATE TABLE batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL UNIQUE,    -- UUID
  source_key TEXT NOT NULL,
  
  -- 时间范围
  ts_start INTEGER NOT NULL,
  ts_end INTEGER NOT NULL,
  
  -- VLM 状态（最多 2 次尝试，间隔 1 分钟）
  vlm_status TEXT NOT NULL DEFAULT 'pending',  -- pending|running|succeeded|failed|failed_permanent
  vlm_attempts INTEGER NOT NULL DEFAULT 0,
  vlm_next_run_at INTEGER,
  vlm_error_message TEXT,
  
  -- Thread LLM 状态（VLM 成功后才会 pending → running）
  thread_llm_status TEXT NOT NULL DEFAULT 'pending',  -- pending|running|succeeded|failed|failed_permanent
  thread_llm_attempts INTEGER NOT NULL DEFAULT 0,
  thread_llm_next_run_at INTEGER,
  thread_llm_error_message TEXT,
  
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_batches_vlm_status ON batches(vlm_status);
CREATE INDEX idx_batches_thread_llm_status ON batches(thread_llm_status);
CREATE INDEX idx_batches_source_key ON batches(source_key);
```

---

### 3. context_nodes 表

```sql
CREATE TABLE context_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- Batch 关联（用于追踪 VLM/Thread LLM 状态）
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  
  -- 核心内容
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  
  -- Thread 关联
  thread_id TEXT REFERENCES threads(id),
  
  -- Thread 快照（JSON，Thread LLM 分配时捕获，用于 Activity Summary 数据一致性）
  -- 在 Thread LLM 将节点分配到 thread 时，同时将 thread 的当前状态快照存入此字段
  -- Activity Summary 读取此快照，而非实时查询 threads 表，避免时间差导致的数据错乱
  thread_snapshot_json TEXT,  -- { title, summary, durationMs, startTime, currentPhase?, mainProject? }
  
  -- 应用上下文（JSON）
  app_context_json TEXT NOT NULL,  -- { appHint, windowTitle, sourceKey }
  
  -- 知识提取（JSON，可为 null，ocrText 存储在 screenshots 表）
  -- textRegion: VLM 返回的主文字区域坐标，用于精准本地 OCR
  knowledge_json TEXT,  -- { contentType, sourceUrl, projectOrLibrary, keyInsights, language, textRegion?: { box: { top, left, width, height }, confidence } }
  
  -- 状态快照（JSON，可为 null，包含构建状态/指标/问题检测等）
  state_snapshot_json TEXT,  -- { subjectType, subject, currentState, metrics?, issue?: { detected: boolean, type: "error"|"bug"|"blocker"|"question"|"warning", description: string, severity: 1-5 } }
  
  -- UI 文本片段（JSON）
  ui_text_snippets_json TEXT,  -- string[]
  
  -- 评估指标
  importance INTEGER NOT NULL DEFAULT 5,
  confidence INTEGER NOT NULL DEFAULT 5,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  
  -- Embedding 状态
  embedding_status TEXT NOT NULL DEFAULT 'pending',
  embedding_attempts INTEGER NOT NULL DEFAULT 0,
  embedding_next_run_at INTEGER,
  
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_context_nodes_thread_id ON context_nodes(thread_id);
CREATE INDEX idx_context_nodes_event_time ON context_nodes(event_time);
CREATE INDEX idx_context_nodes_embedding_status ON context_nodes(embedding_status);
```

---

### 4. threads 表

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,              -- UUID
  
  -- 内容
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  current_phase TEXT,               -- 当前阶段（编码/调试/审查/部署）
  current_focus TEXT,               -- 当前焦点
  
  -- 生命周期
  status TEXT NOT NULL DEFAULT 'active',  -- active|inactive|closed
  start_time INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  
  -- 统计
  duration_ms INTEGER NOT NULL DEFAULT 0,  -- 累计活跃时长
  node_count INTEGER NOT NULL DEFAULT 0,
  
  -- 聚合信息（JSON）
  apps_json TEXT NOT NULL DEFAULT '[]',       -- string[]
  main_project TEXT,
  key_entities_json TEXT NOT NULL DEFAULT '[]',  -- string[]
  
  -- 里程碑（JSON）
  milestones_json TEXT,  -- [{ time, description }]
  
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_threads_status ON threads(status);
CREATE INDEX idx_threads_last_active_at ON threads(last_active_at);
```

---

### 5. context_screenshot_links 表

```sql
CREATE TABLE context_screenshot_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES context_nodes(id),
  screenshot_id INTEGER NOT NULL REFERENCES screenshots(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_csl_node ON context_screenshot_links(node_id);
CREATE INDEX idx_csl_screenshot ON context_screenshot_links(screenshot_id);
CREATE UNIQUE INDEX idx_csl_unique ON context_screenshot_links(node_id, screenshot_id);
```

---

### 6. vector_documents 表

```sql
CREATE TABLE vector_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vector_id TEXT NOT NULL UNIQUE,   -- node:<nodeId>
  doc_type TEXT NOT NULL,           -- context_node
  ref_id INTEGER NOT NULL,          -- context_nodes.id
  
  -- 内容
  text_content TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  meta_payload_json TEXT,
  
  -- Embedding
  embedding BLOB,
  embedding_status TEXT NOT NULL DEFAULT 'pending',
  embedding_attempts INTEGER NOT NULL DEFAULT 0,
  embedding_next_run_at INTEGER,
  
  -- Index
  index_status TEXT NOT NULL DEFAULT 'pending',
  index_attempts INTEGER NOT NULL DEFAULT 0,
  index_next_run_at INTEGER,
  
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_vd_embedding_status ON vector_documents(embedding_status);
CREATE INDEX idx_vd_index_status ON vector_documents(index_status);
CREATE UNIQUE INDEX idx_vd_text_hash ON vector_documents(text_hash);
```

---

### 6.5. screenshots_fts 虚拟表 (FTS5 全文搜索)

> [!NOTE]
> FTS5 是 SQLite 内置的全文搜索引擎，用于对 OCR 文本进行高性能关键词检索，作为向量搜索的补充。
> 向量搜索擅长语义匹配（如"昨天遇到的报错"），FTS5 擅长精确匹配（如搜索具体的错误码 `TS2339` 或项目代号 `PROJ-1234`）。

```sql
-- 创建 FTS5 虚拟表（External Content 模式，不额外存储文本副本）
CREATE VIRTUAL TABLE screenshots_fts USING fts5(
    content,                           -- OCR 文本（映射自 screenshots.ocr_text）
    content='screenshots',             -- 指向物理表
    content_rowid='id',                -- 使用 screenshots.id 作为 rowid
    tokenize='unicode61'               -- Unicode 分词器，支持中英文混合
);

-- 触发器：INSERT 时同步到 FTS 表
CREATE TRIGGER screenshots_fts_insert AFTER INSERT ON screenshots 
WHEN new.ocr_text IS NOT NULL
BEGIN
  INSERT INTO screenshots_fts(rowid, content) VALUES (new.id, new.ocr_text);
END;

-- 触发器：UPDATE 时同步到 FTS 表
CREATE TRIGGER screenshots_fts_update AFTER UPDATE OF ocr_text ON screenshots 
WHEN new.ocr_text IS NOT NULL
BEGIN
  INSERT INTO screenshots_fts(screenshots_fts, rowid, content) VALUES ('delete', old.id, old.ocr_text);
  INSERT INTO screenshots_fts(rowid, content) VALUES (new.id, new.ocr_text);
END;

-- 触发器：DELETE 时同步删除
CREATE TRIGGER screenshots_fts_delete AFTER DELETE ON screenshots 
WHEN old.ocr_text IS NOT NULL
BEGIN
  INSERT INTO screenshots_fts(screenshots_fts, rowid, content) VALUES ('delete', old.id, old.ocr_text);
END;
```

**查询示例**：

```sql
-- 基础搜索：返回匹配的截图 ID 和 BM25 相关性评分
SELECT rowid AS screenshot_id, bm25(screenshots_fts) AS rank
FROM screenshots_fts
WHERE content MATCH '你的搜索词'
ORDER BY rank
LIMIT 20;

-- 高亮片段预览（用于 UI 展示）
SELECT rowid AS screenshot_id, 
       snippet(screenshots_fts, 0, '<mark>', '</mark>', '...', 32) AS preview
FROM screenshots_fts
WHERE content MATCH 'TypeScript error'
LIMIT 10;
```

**设计要点**：

| 要点 | 说明 |
|-----|------|
| **External Content** | 使用 `content='screenshots'` 模式，FTS 表不存储文本副本，仅存储索引。节省约 50% 存储空间。 |
| **触发器同步** | 通过 `INSERT/UPDATE/DELETE` 触发器保持 FTS 索引与 `screenshots.ocr_text` 同步。 |
| **分词器** | `unicode61` 是 SQLite 内置分词器，对英文按单词切分，对中文按字符切分。足以覆盖大多数搜索场景。 |
| **性能影响** | 写入开销约增加 5-10ms/条（相比 VLM 的数分钟处理时间可忽略）。读取为毫秒级。 |
| **搜索场景** | 适用于搜索错误码、项目代号、特殊术语等"精确匹配"场景，与向量搜索互补。 |

---

### 7. activity_summaries 表

```sql
CREATE TABLE activity_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- 窗口时间
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  
  -- 状态
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER,
  
  -- 内容
  summary_text TEXT,
  highlights_json TEXT,             -- string[]
  
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_as_window ON activity_summaries(window_start, window_end);
CREATE INDEX idx_as_status ON activity_summaries(status);
```

---

### 8. activity_events 表

```sql
CREATE TABLE activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  
  -- 关联
  summary_id INTEGER REFERENCES activity_summaries(id),
  thread_id TEXT REFERENCES threads(id),
  
  -- 内容
  title TEXT NOT NULL,
  kind TEXT NOT NULL,               -- focus|work|meeting|break|browse|coding|debugging
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  
  -- 长事件
  is_long INTEGER NOT NULL DEFAULT 0,
  details_status TEXT DEFAULT 'pending',  -- pending|running|succeeded|failed
  details_text TEXT,
  details_attempts INTEGER NOT NULL DEFAULT 0,
  details_next_run_at INTEGER,
  
  -- 关联节点 (context_nodes.id 数组)
  node_ids_json TEXT,               -- number[] (context_node IDs)
  
  confidence INTEGER,
  importance INTEGER,
  
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_ae_summary ON activity_events(summary_id);
CREATE INDEX idx_ae_thread ON activity_events(thread_id);
CREATE INDEX idx_ae_time ON activity_events(start_ts, end_ts);
```

---

## 核心处理流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Screenshot Processing Alpha Pipeline                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────┐   ┌─────────┐   ┌──────────────────────┐                      │
│  │ Capture  │──▶│ pHash   │──▶│ Source Buffer        │──2张/60秒──▶        │
│  │ Service  │   │ Dedup   │   │ (per sourceKey)      │                      │
│  └──────────┘   └─────────┘   └──────────────────────┘                      │
│                                          │                                   │
│                                          │ Batch 创建                        │
│                                          ▼                                   │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                           VLM Processor                               │  │
│  │  Input: screenshots (base64)                                          │  │
│  │  Output: ContextNode[] (含 title, summary, knowledge, state, etc.)    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                          │                                   │
│                                          │ VLM 成功                          │
│                                          ▼                                   │
│                                          │                                   │
│                                          ▼                                   │
│                  ┌───────────────────────────────────────────────┐           │
│                  │           Parallel Processing Stage           │           │
│                  └──────────────────────┬────────────────────────┘           │
│                                         │                                    │
│                    ┌────────────────────┴────────────────────┐               │
│                    ▼                                         ▼               │
│  ┌───────────────────────────────────┐     ┌───────────────────────────────────┐  │
│  │      Local OCR (Tesseract.js)     │     │       Thread LLM Processor        │  │
│  │  条件: language ∈ {en, zh}        │     │  Input: new ContextNodes          │  │
│  │  Output: ocr_text → 存库 + FTS    │     │  Output: Thread assignments       │  │
│  └───────────────────────────────────┘     └───────────────────────────────────┘  │
│                    │                                         │               │
│                    └────────────────────┬────────────────────┘               │
│                                         ▼                                    │
│                                 [Batch Completed]                            │
│                                          │                                   │
│                            ┌─────────────┴─────────────┐                    │
│                            │                           │                    │
│     ┌──────────────────────▼───────────────────────────▼─────────────────┐  │
│     │                     Parallel Processing                            │  │
│     │  ┌─────────────────────────┐   ┌──────────────────────────────┐   │  │
│     │  │ Vector Scheduler        │   │ Activity Timeline Scheduler   │   │  │
│     │  │ - Embedding             │   │ - 20min window summary        │   │  │
│     │  │ - HNSW Index            │   │ - Long event detection        │   │  │
│     │  └─────────────────────────┘   └──────────────────────────────┘   │  │
│     │                                                                    │  │
│     │   ⬆️ 非当前窗口的 Batch Processing 也可并行                        │  │
│     └────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 调度器架构设计

### 三个独立调度器（可并行）

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           Scheduler Architecture                            │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  > **Observability Tip**: Use `ScreenshotProcessingEventBus` for all        │
│    scheduler state changes and milestone completions.                       │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────┐               │
│  │               BatchScheduler                            │               │
│  │  (对标 screenshot-pipeline-scheduler.ts)                 │               │
│  │                                                          │               │
│  │  职责:                                                   │               │
│  │  - 扫描 batches 表处理 VLM → OCR → Thread LLM           │               │
│  │  - VLM: pending → running → succeeded/failed            │               │
│  │  - OCR: VLM 成功后，对 knowledge 截图做 OCR             │               │
│  │  - Thread LLM: OCR 完成后 → 分配 thread                 │               │
│  │  - 崩溃恢复: running/failed 超时 → pending              │               │
│  └─────────────────────────────────────────────────────────┘               │
│                               │                                             │
│   ┌───────────────────────────┼───────────────────────────────┐            │
│   │                           │                               │            │
│   ▼                           ▼                               ▼            │
│ ┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐   │
│ │ VectorDocument      │ │ ActivityTimeline    │ │ BatchScheduler      │   │
│ │ Scheduler           │ │ Scheduler           │ │ (非当前窗口 batch)  │   │
│ │                     │ │                     │ │                     │   │
│ │ 职责:               │ │ 职责:               │ │ ⬅️ 可并行处理       │   │
│ │ - embedding         │ │ - 20min summary     │ │   历史 pending      │   │
│ │ - HNSW index        │ │ - long event        │ │   batch             │   │
│ │ - 崩溃恢复          │ │ - 崩溃恢复          │ │                     │   │
│ └─────────────────────┘ └─────────────────────┘ └─────────────────────┘   │
│                                                                             │
│   ⚠️ ActivityTimelineScheduler 依赖 thread_llm_status=succeeded           │
│   ⚠️ VectorDocumentScheduler 与其他调度器并行运行                          │
│   ⚠️ 非当前窗口的 BatchScheduler 可与其他调度器并行                        │
│                                                                             │
└────────────────────────────────────────────────────────────────────────────┘
```

---

### BatchScheduler 状态机

```
                    ┌─────────────────────────────────────────────────┐
                    │                 batches 表                       │
                    └─────────────────────────────────────────────────┘
                                         │
         ┌───────────────────────────────┼───────────────────────────────┐
         │                               │                               │
         ▼                               ▼                               ▼
    ┌─────────┐                    ┌─────────┐                    ┌─────────┐
    │ vlm_    │                    │ vlm_    │                    │ vlm_    │
    │ pending │────VLM请求────────▶│ running │────成功────────────▶│ success │
    └─────────┘                    └─────────┘                    └─────────┘
         ▲                               │                               │
         │                               │ 失败                          │
         │                               ▼                               ▼
         │                         ┌─────────┐                    ┌─────────────┐
         │                         │ vlm_    │                    │ thread_llm_ │
         │    ───重试(≤2次)─────── │ failed  │                    │ pending     │
         │    (1分钟后)            └─────────┘                    └─────────────┘
         │                               │                               │
         │                               │ 超过2次                       │ Thread LLM
         │                               ▼                               ▼
         │                         ┌─────────────┐               ┌─────────────┐
         │                         │ vlm_        │               │ thread_llm_ │
         │                         │ failed_perm │               │ running     │
         │                         └─────────────┘               └─────────────┘
         │                                                              │
         │              ┌───────────── 成功 ─────────────────────────────┤
         │              │                                               │ 失败
         │              ▼                                               ▼
   崩溃恢复:       ┌─────────────┐                               ┌─────────────┐
   running超时    │ thread_llm_ │        ───重试(≤2次)────────── │ thread_llm_ │
   → pending      │ succeeded   │        (1分钟后)               │ failed      │
                  └─────────────┘                               └─────────────┘
                                                                        │
                                                                        │ 超过2次
                                                                        ▼
                                                                 ┌─────────────┐
                                                                 │ thread_llm_ │
                                                                 │ failed_perm │
                                                                 └─────────────┘
```

**状态转换规则**：

| VLM | `vlm_status=pending` 且 `vlm_next_run_at <= now` | 2 | 1 分钟 |
| Thread LLM | `vlm_status=succeeded` 且 `thread_llm_status=pending` 且 `thread_llm_next_run_at <= now` | 2 | 1 分钟 |

---

### OCR 精准处理流水线 (Selective OCR)

为平衡性能与精度，系统在 VLM 成功后，**并行于 Thread LLM** 启动按需 OCR 识别：

1. **VLM 判别**：VLM 在分析 `batches` 时，对符合 `knowledge` 类的内容识别其主要语言 `language` 及核心区域 `text_region`。
2. **语言过滤 (Skip Logic)**：
   - **触发条件**：仅当 `language` 为 `"en"` 或 `"zh"` 时触发本地 OCR。
   - **跳过条件**：若为 `"other"`（如仅包含代码块、艺术文字或非中英语言），**强制跳过**本地 OCR 步骤以节省 CPU 资源。
3. **区域裁剪**：利用 `sharp` 提取 `text_region.box` 像素区域，消除 UI 噪音。
4. **分类识别**：
   - 为 `"en"` 或 `"zh"` -> 启动 `chi_sim + eng` 混合识别。
5. **结果落库与 FTS 同步**：
   - 将全文存入 `screenshots.ocr_text`。
   - **FTS 联动**：触发 `screenshots_fts_update` 触发器（见 [6.5 节](#65-screenshots_fts-虚拟表-fts5-全文搜索)），自动更新全文搜索索引。这意味着 OCR 完成的瞬间，该截图即可通过关键词进行毫秒级检索。
   - **向量化补充**：OCR 文本还将参与后续 `VectorDocumentScheduler` 的 embedding 生成，增强语义搜索的精准度。

---

### VectorDocumentScheduler 状态机

```
context_nodes.embedding_status:
    pending → running → succeeded
                   ↓
               failed → (重试≤2次) → failed_permanent
                   ↑
            崩溃恢复: running超时 → pending
```

| 阶段 | 触发条件 | 最大尝试次数 | 重试间隔 |
|-----|---------|-------------|---------|
| Embedding | `embedding_status=pending` 且 `embedding_next_run_at <= now` | 2 | 1 分钟 |

---

### ActivityTimelineScheduler 状态机

```
activity_summaries.status:
    pending → running → succeeded | no_data
                   ↓
               failed → (重试≤2次) → failed_permanent
                   ↑
            崩溃恢复: running超时 → pending

activity_events.details_status (按需触发):
    pending → running → succeeded
                   ↓
               failed → (重试≤2次) → failed_permanent
```

**依赖关系**：
- Activity Summary 只处理 `batches` 中 `thread_llm_status=succeeded` 的数据
- Activity Summary 不依赖 embedding（可并行）
- Event Details 按需请求（用户点击时触发）

---

### 崩溃恢复机制

```typescript
// 每个调度器启动时执行
async recoverStaleStates(): Promise<void> {
  const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 分钟
  const now = Date.now();
  
  // 回滚超时的 running 和 failed 状态
  db.update(table)
    .set({ 
      status: 'pending',
      next_run_at: now,  // 立即重试
    })
    .where(
      and(
        or(
          eq(table.status, 'running'),
          eq(table.status, 'failed')
        ),
        lt(table.updated_at, now - STALE_THRESHOLD_MS)
      )
    )
    .run();
}
```

**场景覆盖**：
1. **App 崩溃重启**：启动时 `recoverStaleStates()` 回滚卡死的 running 和未完成重试 of failed
2. **App 长时间未开**：无论间隔多久，running 和 failed 都会被回滚重新执行

---

### 调度器协作时序

```
时间线 ──────────────────────────────────────────────────────────────────────▶

[截图采集]
    │ pHash去重
    ▼
[Buffer]──2张/60秒──▶[Batch创建]
                         │
                         ▼
[BatchScheduler] ────────────────────────────────────────────────────────────▶
    │ runCycle()
    │   ├── recoverStaleStates()
    │   ├── 扫描 vlm_status=pending
    │   │   └── VLM 请求 → vlm_status=succeeded
    │   └── 扫描 thread_llm_status=pending (where vlm_status=succeeded)
    │       └── Thread LLM 请求 → thread_llm_status=succeeded
    │                              └── 创建 context_nodes
    │                                   └── emit('batch:completed')
    │
    ├────────────────────────────────────────────────────────────────────────▶
    │                                    │
    ▼                                    ▼
[VectorDocumentScheduler]         [ActivityTimelineScheduler]
    │ runCycle()                      │ runCycle()
    │   ├── recoverStaleStates()      │   ├── recoverStaleStates()
    │   ├── 扫描 embedding=pending    │   ├── seedPendingWindows() 每20分钟
    │   │   └── Embedding API         │   ├── 扫描 status=pending
    │   └── 写入 HNSW                 │   │   └── 获取窗口内 context_nodes
    │                                 │   │   └── 生成 summary + events
    │                                 │   └── 检测长事件 (thread.duration_ms >= 25min)
    │                                 │
    ▼                                 ▼
[向量索引完成]                     [Activity Summary 完成]
```

---

## 配置参数

```typescript
export const ALPHA_CONFIG = {
  // Batch 触发
  batch: {
    minSize: 2,
    maxSize: 5,
    timeoutMs: 60 * 1000,
  },
  
  // Thread 生命周期
  thread: {
    inactiveThresholdMs: 4 * 60 * 60 * 1000,   // 4 小时转 inactive
    gapThresholdMs: 10 * 60 * 1000,            // 10 分钟间隔不计入 duration
    longEventThresholdMs: 25 * 60 * 1000,      // 25 分钟判定为长事件
    maxActiveThreads: 3,                        // LLM 请求时最多带 3 个活跃 thread
    fallbackRecentThreads: 1,                   // 如果没有活跃 thread，取最近 1 个
    recentNodesPerThread: 3,                   // 每个 thread 带最近 3 个节点
  },
  
  // Activity Summary
  activitySummary: {
    windowMs: 20 * 60 * 1000,                  // 20 分钟窗口
    longEventThresholdMs: 25 * 60 * 1000,      // 25 分钟判定为长事件
    eventDetailsEvidenceMaxNodes: 50,
    eventDetailsEvidenceMaxChars: 24000,
  },
  
  // OCR
  ocr: {
    maxChars: 8000,
    languages: 'eng+chi_sim',                // 仅支持中英文
    initOnSplash: true,                       // Splash 屏幕时初始化 Worker
    supportedLanguages: ['en', 'zh'],         // VLM 检测到这些语言才触发 OCR
  },
  
  // 重试 (适用于所有调度器)
  retry: {
    maxAttempts: 2,                            // 最多 2 次
    delayMs: 60 * 1000,                        // 1 分钟后重试
    staleRunningThresholdMs: 5 * 60 * 1000,    // 5 分钟判定为卡死
  },
  
  // AI 并发配置（复用 ai-runtime-service.ts 的 Semaphore/Tuner/Breaker）
  ai: {
    // 全局并发上限（每种 capability 独立）
    vlmGlobalConcurrency: 10,
    textGlobalConcurrency: 10,
    embeddingGlobalConcurrency: 10,
    
    // 超时配置
    vlmTimeoutMs: 120000,       // 2 分钟
    textTimeoutMs: 120000,      // 2 分钟
    embeddingTimeoutMs: 60000,  // 1 分钟
    
    // 自适应并发调整 (AIMD 算法)
    adaptiveEnabled: true,
    adaptiveMinConcurrency: 1,              // 最小并发数
    adaptiveWindowSize: 20,                 // 滑动窗口大小
    adaptiveFailureRateThreshold: 0.2,      // 20% 失败率触发降级
    adaptiveConsecutiveFailureThreshold: 2, // 连续 2 次失败触发降级
    adaptiveCooldownMs: 30000,              // 30 秒冷却期
    adaptiveRecoveryStep: 1,                // 恢复时每次增加 1
    adaptiveRecoverySuccessThreshold: 20,   // 连续 20 次成功后恢复
  },
  
  // 自适应背压策略（根据 pending batch 数量动态调整采集行为）
  // 
  // 注意：基准值来自 screen-capture/types.ts 中的 DEFAULT_SCHEDULER_CONFIG
  // - DEFAULT_SCHEDULER_CONFIG.interval = 3000 (3秒)
  // - phash-dedup.ts 中的 SimilarityThreshold = 8
  backpressure: {
    // 压力等级阈值（按 maxPending 升序排列，匹配第一个满足条件的等级）
    levels: [
      // Level 0: 正常运行 (pending < 4)
      {
        maxPending: 3,
        intervalMultiplier: 1,                // 使用 DEFAULT_SCHEDULER_CONFIG.interval (3秒)
        phashThreshold: 8,                    // 使用默认去重阈值 (Hamming distance ≤ 8 判定为重复)
        description: 'normal',
      },
      // Level 1: 轻度压力 (4 ≤ pending < 8) - 提高去重灵敏度
      {
        maxPending: 7,
        intervalMultiplier: 1,                // 保持 3 秒/张
        phashThreshold: 12,                   // 更宽松的去重 (Hamming distance ≤ 12 判定为重复，更多截图被跳过)
        description: 'light_pressure',
      },
      // Level 2: 中度压力 (8 ≤ pending < 12) - 降低截图频率
      {
        maxPending: 11,
        intervalMultiplier: 2,                // 2x = 6 秒/张
        phashThreshold: 12,                   // 保持 Level 1 的去重率
        description: 'medium_pressure',
      },
      // Level 3: 重度压力 (pending ≥ 12) - 进一步降低截图频率
      {
        maxPending: Infinity,
        intervalMultiplier: 4,                // 4x = 12 秒/张
        phashThreshold: 12,                   // 保持去重率不变
        description: 'heavy_pressure',
      },
    ],
    
    // 恢复策略
    recoveryHysteresisMs: 30000,              // 恢复观察期 30 秒（防止频繁切换）
    recoveryBatchThreshold: 2,                // pending 降到阈值以下且保持 30 秒才恢复
  },
};
```

> [!NOTE]
> 完整复用 `ai-runtime-service.ts` 的能力：
> - **Semaphore**：全局并发控制（vlm/text/embedding 独立）
> - **AISemaphoreManager**：统一管理三种 capability 的信号量
> - **Adaptive Concurrency Tuner (AIMD)**：自适应并发调整，失败时降级，成功时恢复
> - **AI Failure Fuse Breaker**：连续失败时熔断，保护系统

### 自适应背压策略图示

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Adaptive Backpressure Strategy                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  基准值: DEFAULT_SCHEDULER_CONFIG.interval = 3000ms (types.ts)              │
│  pending = batches.status IN (pending/running/failed)                       │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Level 0: pending < 4 (正常)                                          │   │
│  │   📸 间隔: 1x = 3 秒/张                                               │   │
│  │   🔍 pHash: 8 (默认阈值)                                              │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              ↓ pending ≥ 4                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Level 1: 4 ≤ pending < 8 (轻度压力)                                  │   │
│  │   📸 间隔: 1x = 3 秒/张                                               │   │
│  │   🔍 pHash: 12 (更宽松，更多截图被跳过)                                │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              ↓ pending ≥ 8                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Level 2: 8 ≤ pending < 12 (中度压力)                                 │   │
│  │   📸 间隔: 2x = 6 秒/张                                               │   │
│  │   🔍 pHash: 12                                                        │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              ↓ pending ≥ 12                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Level 3: pending ≥ 12 (重度压力)                                     │   │
│  │   📸 间隔: 4x = 12 秒/张                                              │   │
│  │   🔍 pHash: 12                                                        │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ⚡ 恢复策略: pending 降到阈值以下且保持 30 秒 → 恢复上一级               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

> [!IMPORTANT]
> **背压策略的核心思想**：从源头（采集端）控制流量，而非在处理端"攒任务"。
> - Batch 大小保持恒定（2-5 张），VLM 响应时间可预测
> - 降低截图频率 + 提高去重 = 减少 Batch 产生速度
> - 恢复时加入 30 秒滞后期，防止频繁切换等级


---

## Prompt 设计
  参考 docs\alpha-prompt-templates.md

## 本地 OCR 集成

使用 Tesseract.js（纯 JS + WASM，无 native 依赖）：

```typescript
// ocr-service.ts
import Tesseract from 'tesseract.js';

let worker: Tesseract.Worker | null = null;

// Splash 屏幕时调用
export async function initOcrWorker(): Promise<void> {
  worker = await Tesseract.createWorker('eng+chi_sim');
}

// VLM 成功后，根据 knowledge.language 判断是否调用
export async function extractOcrText(
  imageBuffer: Buffer,
  maxChars: number = 8000
): Promise<string> {
  if (!worker) {
    throw new Error('OCR worker not initialized');
  }
  const { data: { text } } = await worker.recognize(imageBuffer);
  return text.trim().slice(0, maxChars);
}

export function shouldRunOcr(knowledgeLanguage: string | undefined): boolean {
  return knowledgeLanguage === 'en' || knowledgeLanguage === 'zh';
}
```

**集成流程**：

```
App 启动 (Splash 屏幕)
  └─ initOcrWorker() → 后台初始化 Worker

VLM 返回后
  └─ 遍历 context_nodes
      └─ if knowledge_json.language in ['en', 'zh']
          └─ shouldRunOcr() = true
          └─ 设置 screenshot.ocr_status = 'pending'

BatchScheduler (OCR 步骤)
  └─ 扫描 ocr_status = pending 的 screenshots
      └─ extractOcrText(imageBuffer)
      └─ 更新 screenshot.ocr_text, ocr_status = 'succeeded'
```

---

## 目录结构

```
electron/services/screenshot-processing-alpha/
├── index.ts                      # 模块导出
├── config.ts                     # 配置参数
├── types.ts                      # TypeScript 类型定义
├── schemas.ts                    # Zod Schemas (与 Prompt 对齐)
│
├── source-buffer-registry.ts     # 可复用现有实现
├── phash-dedup.ts                # 可复用现有实现
├── ocr-service.ts                # 新增：本地 OCR
│
├── batch-builder.ts              # 简化版
├── vlm-processor.ts              # 简化版（输出结构调整）
├── thread-llm-processor.ts       # 新增：Thread 判断
│
├── vector-document-service.ts    # 可复用现有实现
├── vector-document-scheduler.ts  # 可复用现有实现
├── vector-index-service.ts       # 可复用现有实现
├── embedding-service.ts          # 可复用现有实现
│
├── activity-timeline-scheduler.ts # 简化版
├── activity-monitor-service.ts    # 简化版
│
├── pipeline-scheduler.ts          # 核心调度器
├── base-scheduler.ts              # 可复用现有实现
├── event-bus.ts                   # 可复用现有实现
└── events.ts                      # 调整事件类型
```

---

## 验证计划

### 单元测试

1. **pHash 去重**：验证相似截图被正确去重
2. **Batch 触发**：验证 2 张/60 秒触发逻辑
3. **VLM Schema**：验证 Zod 解析正确
4. **Thread 匹配**：验证 Thread LLM 输出解析
5. **Duration 计算**：验证 gap > 10分钟不计入

### 集成测试

1. **端到端流程**：截图 → VLM → Thread → Vector → Activity Summary
2. **长事件检测**：验证 25+ 分钟 Thread 被正确识别
3. **跨窗口 Thread**：验证 Thread 在多个 Activity Summary 窗口中正确关联

### 手动验证

1. 运行应用，截图并验证 VLM 输出
2. 验证 Thread 更新是否合理
3. 验证 Activity Summary 中的长事件展示

---

## 已确认事项

| 事项 | 决策 |
|-----|------|
| **Activity Summary 窗口时长** | 20 分钟 ✅ |
| **Tesseract.js 语言包** | 支持中英文 OCR (`eng+chi_sim`) ✅ |
| **Thread 选择逻辑** | 优先取 3 个活跃 threads；如果没有活跃 thread，取最近 1 个 thread ✅ |

---

## 代码复用分析

### 可直接复用（minor 调整）

| 模块 | 文件 | 复用理由 |
|-----|------|---------|
| **pHash 去重** | `phash-dedup.ts` | 算法不变，直接复用 |
| **Base Scheduler** | `base-scheduler.ts` | 调度器基类，直接复用 |
| **Event Bus** | `event-bus.ts` | 事件机制不变，直接复用 |
| **Vector Index Service** | `vector-index-service.ts` | HNSW 索引操作不变，直接复用 |
| **Embedding Service** | `embedding-service.ts` | 调用 API 逻辑不变，直接复用 |
| **AI Runtime Service** | `ai-runtime-service.ts` | Semaphore/Breaker 机制不变，直接复用 |

### 需要适配（moderate 调整）

| 模块 | 文件 | 调整内容 |
|-----|------|---------|
| **Source Buffer Registry** | `source-buffer-registry.ts` | 调整触发条件 (2张/60秒)，移除 OCR 调用 |
| **Vector Document Service** | `vector-document-service.ts` | 调整 buildTextForNode() 以适配新 schema |
| **Vector Document Scheduler** | `vector-document-scheduler.ts` | 调整扫描逻辑适配新表结构 |

### 需要重写（major 重构）

| 模块 | 新文件 | 重写原因 |
|-----|-------|---------|
| **VLM Processor** | `vlm-processor.ts` | 输出结构完全变化（1 截图 1 节点），新 prompt |
| **Thread LLM Processor** | `thread-llm-processor.ts` | 新增模块，替代原 text-llm-processor.ts |
| **Batch Scheduler** | `batch-scheduler.ts` | 替代 screenshot-pipeline-scheduler.ts，新状态机 |
| **Activity Timeline Scheduler** | `activity-timeline-scheduler.ts` | 适配新的 thread/长事件检测逻辑 |
| **Schemas** | `schemas.ts` | 完全新的 Zod schemas |
| **Types** | `types.ts` | 完全新的 TypeScript 类型 |
| **Config** | `config.ts` | 新配置参数 |
| **OCR Service** | `ocr-service.ts` | 新增模块 (Tesseract.js) |

### 不再需要

| 模块 | 原因 |
|-----|------|
| `text-llm-processor.ts` | 被 Thread LLM Processor 替代 |
| `context-graph-service.ts` | 简化后不需要复杂的图操作 |
| `entity-service.ts` | entities 直接存入 context_nodes.entities_json |
| `backfill-entities.ts` | 不再需要回填逻辑 |

---

## AI Runtime 集成

### 复用 `ai-runtime-service.ts` 全部功能

| 功能 | 说明 | 集成点 |
|-----|------|-------|
| **Semaphore** | 全局并发控制 | 所有 AI 请求前 `acquire()` |
| **AISemaphoreManager** | VLM/Text/Embedding 分离 | BatchScheduler, VectorScheduler |
| **Adaptive Concurrency Tuner (AIMD)** | 自适应并发调整 | 请求成功/失败时调用 |
| **AI Failure Fuse Breaker** | 熔断机制 | 连续失败时触发 |

### 调用模式

```typescript
// 所有 AI 调用统一模式
async function executeWithRuntime<T>(
  capability: AICapability,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const release = await aiRuntimeService.semaphores.acquire(capability);
  const startTime = Date.now();
  
  try {
    const result = await fn();
    aiRuntimeService.tuner.recordSuccess(capability);
    
    // 记录到 monitoring
    monitoringService.recordRequest({
      capability,
      operation,
      durationMs: Date.now() - startTime,
      status: 'succeeded',
    });
    
    return result;
  } catch (error) {
    aiRuntimeService.tuner.recordFailure(capability);
    
    monitoringService.recordRequest({
      capability,
      operation,
      durationMs: Date.now() - startTime,
      status: 'failed',
      errorMessage: error.message,
    });
    
    throw error;
  } finally {
    release();
  }
}
```

---

## Monitoring 重设计

### 新 QueueStatus 结构（适配 Alpha Schema）

```typescript
interface AlphaQueueStatus {
  ts: number;
  
  // Batch 状态（分 VLM 和 Thread LLM）
  batches: {
    vlmPending: number;
    vlmRunning: number;
    vlmFailed: number;
    threadLlmPending: number;
    threadLlmRunning: number;
    threadLlmFailed: number;
  };
  
  // Embedding 状态
  embedding: {
    pending: number;
    running: number;
    failed: number;
  };
  
  // Activity Summary 状态
  activitySummary: {
    pending: number;
    running: number;
    failed: number;
  };
  
  // Activity Event Details 状态（按需生成）
  activityEventDetails: {
    title: string;       // event title，方便识别
    pending: number;
    running: number;
    failed: number;
  };
}
```

### 新 Request Trace 结构

```typescript
interface AlphaRequestTrace {
  id: string;                         // 唯一 ID
  ts: number;                         // 请求开始时间
  
  // 阶段标识
  phase: 'batch_vlm' | 'batch_thread_llm' | 'batch_ocr' | 'embedding' | 'activity_summary' | 'activity_event_details';
  
  // AI 请求信息
  capability: 'vlm' | 'text' | 'embedding';
  operation: string;                  // e.g., 'vlm_analyze_batch', 'thread_llm_assign'
  model: string;
  
  // 性能指标
  durationMs: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  
  // 上下文
  batchId?: string;
  screenshotCount?: number;
  nodeCount?: number;
  
  // 响应摘要
  responsePreview?: string;           // 截断后的响应预览 (≤500 chars)
  tokensUsed?: number;
  
  // 失败信息
  errorCode?: string;
  errorMessage?: string;
}
```

### Monitoring 服务调整（调整或删除旧实现）

| 组件 | 调整内容 |
|-----|---------|
| `queue-inspector.ts` | **重写**：查询新表结构，分离 VLM/Thread LLM 状态 |
| `monitoring-types.ts` | **重写**：替换为 `AlphaQueueStatus` 和 `AlphaRequestTrace` |
| `ai-request-trace.ts` | **重写**：增加 `phase`、`batchId`、`responsePreview` 等字段 |
| `monitoring-server.ts` | **调整**：SSE 推送新类型数据 |
| `metrics-collector.ts` | **保留**：系统指标采集不变 |
| `ring-buffer.ts` | **保留**：数据结构不变 |
| `activity-alert-trace.ts` | **删除**：合并到 `AlphaRequestTrace` |
| `ai-error-stream.ts` | **删除**：合并到 `AlphaRequestTrace.errorMessage` |

### 数据采集点

```
BatchScheduler
  └─ VLM 请求开始/结束 → recordRequest(phase='batch_vlm')
  └─ OCR 请求开始/结束 → recordRequest(phase='batch_ocr')
  └─ Thread LLM 请求开始/结束 → recordRequest(phase='batch_thread_llm')

VectorDocumentScheduler
  └─ Embedding 请求开始/结束 → recordRequest(phase='embedding')

ActivityTimelineScheduler
  └─ Summary 请求开始/结束 → recordRequest(phase='activity_summary')
  └─ Event Details 请求开始/结束 → recordRequest(phase='activity_event_details')
```

---

## 目录结构（更新）

```
electron/services/screenshot-processing-alpha/
├── index.ts                      # 模块导出
├── config.ts                     # 配置参数
├── types.ts                      # TypeScript 类型定义
├── schemas.ts                    # Zod Schemas
│
├── source-buffer-registry.ts     # 适配版
├── phash-dedup.ts                # 复用
├── ocr-service.ts                # 新增
│
├── batch-scheduler.ts            # 新：VLM → OCR → Thread LLM
├── vlm-processor.ts              # 重写
├── thread-llm-processor.ts       # 新增
│
├── vector-document-service.ts    # 适配版
├── vector-document-scheduler.ts  # 适配版
├── vector-index-service.ts       # 复用
├── embedding-service.ts          # 复用
│
├── activity-timeline-scheduler.ts # 重写
├── activity-monitor-service.ts    # 简化版
│
├── base-scheduler.ts              # 复用
├── event-bus.ts                   # 复用
└── events.ts                      # 调整

electron/services/monitoring/      # 适配
├── queue-inspector.ts             # 查询新表结构
├── monitoring-types.ts            # 新类型定义
├── ai-request-trace.ts            # 增强请求追踪
└── ...                            # 其他文件保留
```
