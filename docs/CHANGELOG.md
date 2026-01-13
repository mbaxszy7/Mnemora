# Alpha Implementation Plan - Changelog

> 记录对 `alpha-implementation-plan.md` 及相关设计文档的所有修改

---

## [2026-01-13] 添加自适应背压策略

### 变更内容

新增自适应背压策略（Adaptive Backpressure），根据 pending batch 数量动态调整截图采集行为，防止 Batch 积压失控。

### 修改文件

#### `docs/alpha-implementation-plan.md`

**新增位置**: 配置参数 `ALPHA_CONFIG.backpressure`

**策略层级**:

| Level | pending 范围 | 间隔倍率 | 实际间隔 | pHash 阈值 (Hamming) |
|-------|-------------|---------|---------|---------------------|
| 0 | < 4 | 1x | 3 秒 | 8 (默认) |
| 1 | 4 ~ 7 | 1x | 3 秒 | 12 (更宽松) |
| 2 | 8 ~ 11 | 2x | 6 秒 | 12 |
| 3 | ≥ 12 | 4x | 12 秒 | 12 |

**恢复策略**: pending 降到阈值以下且保持 30 秒 → 恢复上一级

### 设计决策

- **复用现有常量**：基准值来自 `screen-capture/types.ts:DEFAULT_SCHEDULER_CONFIG.interval` (3000ms) 和 `phash-dedup.ts:SimilarityThreshold` (8)
- **使用倍率而非绝对值**：`intervalMultiplier` 设计使配置与基准解耦，便于统一调整
- 从源头（采集端）控制流量，Batch 大小保持恒定（2-5 张）
- 恢复时加入 30 秒滞后期，防止频繁切换等级

### 影响范围

- `screen-capture-module.ts`：新增 `BackpressureMonitor`，调用 `scheduler.updateConfig({ interval })`
- `source-buffer-registry.ts`：`isDuplicateByLast()` 调用需传入动态阈值
- `screenshot-pipeline-scheduler.ts`：新增 `getPendingBatchCount()` 方法

---

## [2026-01-13] 添加 FTS5 全文搜索虚拟表 Schema

### 变更内容

新增 `screenshots_fts` FTS5 虚拟表，用于对 OCR 文本进行高性能关键词检索，作为向量搜索的补充。

- **向量搜索**：擅长语义匹配（如"昨天遇到的报错"）
- **FTS5 搜索**：擅长精确匹配（如搜索具体的错误码 `TS2339` 或项目代号 `PROJ-1234`）

### 修改文件

#### `docs/alpha-implementation-plan.md`

**新增位置**: 数据库 Schema 设计 - 第 6.5 节（在 `vector_documents` 和 `activity_summaries` 之间）

**新增内容**:
- FTS5 虚拟表定义（External Content 模式，不额外存储文本副本）
- INSERT/UPDATE/DELETE 触发器（保持 FTS 索引与 `screenshots.ocr_text` 同步）
- 查询示例（基础搜索 + 高亮片段预览）
- 设计要点表格

### 设计决策

| 决策 | 说明 |
|-----|------|
| **External Content 模式** | FTS 表不存储文本副本，仅存储索引，节省约 50% 存储空间 |
| **触发器同步** | 通过数据库触发器自动保持 FTS 索引与源数据同步 |
| **分词器选择** | 使用 `unicode61`（SQLite 内置），对英文按单词切分，对中文按字符切分 |

### 影响范围

- 需新增数据库迁移脚本创建 FTS5 虚拟表
- Deep Search Service 可集成 FTS 搜索与向量搜索的混合检索

---

## [2026-01-13] 添加 Issue 检测支持

### 变更内容

支持用户进行自然语言搜索问题/错误，例如：
- "两天前做xxx项目遇到过什么问题？"
- "上周有哪些 bug？"
- "最近的阻塞问题是什么？"

### 修改文件

#### 1. `docs/alpha-implementation-plan.md`

**修改位置**: `context_nodes` 表 Schema - `state_snapshot_json` 字段 (L166-167)

**修改前**:
```sql
state_snapshot_json TEXT,  -- { subjectType, subject, currentState, metrics }
```

**修改后**:
```sql
-- 状态快照（JSON，可为 null，包含构建状态/指标/问题检测等）
state_snapshot_json TEXT,  -- { subjectType, subject, currentState, metrics?, issue?: { detected: boolean, type: "error"|"bug"|"blocker"|"question"|"warning", description: string, severity: 1-5 } }
```

#### 2. `docs/alpha-prompt-templates.md`

**修改位置**: 
- VLM Output Schema - `state_snapshot` 类型定义 (L70-82)
- VLM System Prompt - `state_snapshot` 字段说明 (L194-205)

**Schema 定义更新**:
```typescript
state_snapshot: {
  subject_type: string;         // build|deploy|pipeline|metrics|task_board|error|...
  subject: string;
  current_state: string;
  metrics?: Record<string, string | number>;
  issue?: {                     // 新增！
    detected: boolean;
    type: "error" | "bug" | "blocker" | "question" | "warning";
    description: string;
    severity: number;           // 1-5
  };
} | null;
```

**Prompt 说明更新**:
```
### state_snapshot (optional)
- Populate if user is viewing dashboards, metrics, build status, task boards, 
  OR if any error/bug/blocker is detected  ← 新增触发条件
- issue (IMPORTANT for search): If error, bug, blocker, or warning is detected:
  - detected: true
  - type: "error" | "bug" | "blocker" | "question" | "warning"
  - description: What went wrong
  - severity: 1-5 (1=minor, 5=critical)
```

### 字段说明 (`state_snapshot_json.issue`)

| 属性 | 类型 | 说明 |
|------|------|------|
| `detected` | boolean | 是否检测到问题 |
| `type` | enum | 问题类型: `error` \| `bug` \| `blocker` \| `question` \| `warning` |
| `description` | string | 问题描述 |
| `severity` | 1-5 | 严重程度（1最轻，5最重） |

### 设计决策

将 issue 信息合并到 `state_snapshot_json` 中（而非单独字段），因为问题/错误本质上是一种"状态快照"。

### 影响范围

- `context_nodes.state_snapshot_json` 结构扩展
- VLM Processor 输出 schema
- 向量搜索时可通过 `state_snapshot_json->issue->detected` 过滤

---

## 模板

### [YYYY-MM-DD] 变更标题

**变更内容**:
- 简要描述

**变更原因**:
- 为什么需要这个变更

**影响范围**:
- 哪些模块/文件受影响
