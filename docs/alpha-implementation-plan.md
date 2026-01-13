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

2. **长事件判定**：
   - `Thread.duration_ms` 累计计算（排除超过 10 分钟的 gap）。
   - 当 `Thread.duration_ms >= 25 分钟` 时，在 Activity Summary 中将其标记为"长事件"（`is_long = 1`）。
   - 长事件会触发 `Activity Event Details` 的生成，提供更丰富的事件详情。

3. **Activity Summary 不依赖 Thread 边界**：
   - Activity Summary 按固定 20 分钟窗口生成。
   - 窗口内的 Context Node 可能属于多个 Thread。
   - Thread 信息用于识别长事件和提供活动连续性上下文。

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
  
  -- 应用上下文（JSON）
  app_context_json TEXT NOT NULL,  -- { appHint, windowTitle, sourceKey }
  
  -- 知识提取（JSON，可为 null，ocrText 存储在 screenshots 表）
  knowledge_json TEXT,  -- { contentType, sourceUrl, projectOrLibrary, keyInsights }
  
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
│  │  Input: screenshots (base64) + history_pack (当前活跃 threads)        │  │
│  │  Output: ContextNode[] + app_guess (屏幕截图时)                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                          │                                   │
│                                          │ VLM 成功                          │
│                                          ▼                                   │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                  Local OCR (Tesseract.js)                             │  │
│  │  条件: knowledge_json 不为 null 的 context_node 关联的 screenshot     │  │
│  │  Output: ocr_text 存入 screenshots 表                                 │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                          │                                   │
│                                          ▼                                   │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         Thread LLM Processor                          │  │
│  │  Input: new ContextNodes + active Threads (top 3) + recent nodes     │  │
│  │  Output: Thread assignments + Thread updates                          │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
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

| 阶段 | 触发条件 | 最大尝试次数 | 重试间隔 |
|-----|---------|-------------|---------|
| VLM | `vlm_status=pending` 且 `vlm_next_run_at <= now` | 2 | 1 分钟 |
| Thread LLM | `vlm_status=succeeded` 且 `thread_llm_status=pending` 且 `thread_llm_next_run_at <= now` | 2 | 1 分钟 |

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
    │ pHash去重 + Local OCR
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
};
```

> [!NOTE]
> 完整复用 `ai-runtime-service.ts` 的能力：
> - **Semaphore**：全局并发控制（vlm/text/embedding 独立）
> - **AISemaphoreManager**：统一管理三种 capability 的信号量
> - **Adaptive Concurrency Tuner (AIMD)**：自适应并发调整，失败时降级，成功时恢复
> - **AI Failure Fuse Breaker**：连续失败时熔断，保护系统


---

## VLM Prompt 设计

### System Prompt

```
You are a screenshot analysis assistant. For each screenshot, extract structured information.

Output JSON array with one object per screenshot, matching the screenshot order (1-indexed).

Each object must have:
- title: Brief title (≤100 chars)
- summary: Detailed description of what user is doing, in which app, which project, current progress (200-500 chars)
- appContext: { appHint, windowTitle, sourceKey }
- knowledge: If reading docs/blog/tutorial, extract { contentType, sourceUrl?, projectOrLibrary?, keyInsights[], language: "en"|"zh"|"other" }. Otherwise null.
- stateSnapshot: If viewing build status/metrics/task board, extract { subjectType, subject, currentState, metrics? }. Otherwise null.
- entities: Array of { name, type, raw?, confidence? }. Types: person|project|team|org|jira_id|pr_id|commit|document_id|url|repo|other
- actionItems: If explicit or inferred TODOs, extract [{ action, priority?, source }]. Otherwise null.
- uiTextSnippets: Important UI text (buttons, messages, titles). Max 10 items.
- importance: 0-10
- confidence: 0-10
- keywords: Max 5 keywords
```

### User Prompt

```
Analyze {count} screenshots.

Screenshot metadata:
{screenshotMeta}

Recent history (for continuity):
{historyPack}

---

Output format:
{
  "nodes": [
    { /* screenshot 1 result */ },
    { /* screenshot 2 result */ },
    ...
  ]
}
```

---

## Thread LLM Prompt 设计

### System Prompt

```
You analyze user activity continuity. Given new context nodes and active threads, determine:
1. Which thread each new node belongs to (or create new thread)
2. How to update thread status (title, summary, phase, focus, milestones)

Rules:
- Match nodes to threads based on: same project, same app, related topic, time proximity
- Create new thread if activity is clearly different
- Update thread summary to reflect current progress
- Add milestone if significant progress detected
```

### User Prompt

```
Active threads (most recent first):
{activeThreads}

Each thread's recent nodes:
{threadRecentNodes}

New nodes from this batch:
{batchNodes}

---

Output:
{
  "assignments": [
    { "nodeIndex": 0, "threadId": "existing-uuid" | "NEW", "reason": "..." },
    ...
  ],
  "threadUpdates": [
    {
      "threadId": "...",
      "title": "...",
      "summary": "...",
      "currentPhase": "...",
      "currentFocus": "...",
      "newMilestone": { "description": "..." } | null
    },
    ...
  ],
  "newThreads": [
    {
      "title": "...",
      "summary": "...",
      "currentPhase": "...",
      "nodeIndices": [...]
    },
    ...
  ]
}
```

---

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
