# Alpha Implementation Plan - Changelog

> 记录对 `alpha-implementation-plan.md` 及相关设计文档的所有修改

---

## [2026-01-14] VLM Stateless 化与 OCR 并行化重构

### 变更内容

为了提升系统处理性能并降低组件耦合度，对 VLM 处理流程进行了重大架构调整。

### 核心变更

1. **VLM Stateless (无状态化)**：
   - 移除 VLM Processor 对 `history_pack` (近期活动上下文) 的依赖。
   - VLM 现在仅负责“从图中提取信息”，不参与“活动连贯性维护”。
   - 职责解耦：活动连贯性交由 Stage 2 的 **Thread LLM** 独立完成。

2. **OCR 与 Thread LLM 并行化**：
   - 将流式处理从 `VLM -> OCR -> Thread LLM` 串行模式重构为 `VLM -> (OCR & Thread LLM)` 并行模式。
   - **理由**：Thread LLM 的分配决策仅依赖 VLM 的结构化输出，无需等待耗时较长的本地 OCR 识别结果。
   - 并行化后，Batch 的整体处理延迟将减少约 30%-50%。

3. **智能 语言过滤 (OCR Gatekeeper)**：
   - VLM 在识别 `knowledge` 类型时，必须检测主文字语言。
   - 仅当语言为 `"en"` 或 `"zh"` 时触发本地 OCR。
   - 对于代码块、纯符号或其他语言，标记为 `"other"` 并强制跳过 OCR 步骤。

### 修改文件

- **`docs/alpha-implementation-plan.md`**: 
  - 更新核心流程图和调度器架构图。
  - 在第 3.4 节新增“OCR 精准处理流水线”详述并行与过滤逻辑。
- **`docs/alpha-prompt-templates.md`**: 
  - 移除 VLM User Prompt 中的 `history_pack` 部分。
  - 强化 `knowledge.language` 的字段说明及决策规则。

---

## [2026-01-13] VLM 文字区域定位优化 OCR

### 变更内容

新增 VLM 返回主文字区域坐标的能力，用于优化本地 OCR 识别：
- VLM 在识别 `knowledge` 类内容时，额外返回 `text_region` 字段。
- `text_region` 包含主内容区域的边界框坐标 (top, left, width, height)。
- 本地 OCR 引擎可以只对该区域进行识别，减少 UI 噪音（如侧边栏、工具栏）。

### 性能提升 (Demo 数据)

| 指标 | 全图 OCR | 区域识别 (VLM 引导) | 提升 |
|-----|---------|-------------------|-----|
| **置信度** | ~80% | **88%+** | +10% |
| **平均耗时** | 4.17s | **2.91s** | -30% |

### 修改文件

- `docs/alpha-implementation-plan.md`: 扩展 `knowledge_json` 以包含 `textRegion` 结构。
- `docs/alpha-prompt-templates.md`: 在 VLM Output Schema 和 System Prompt 中新增 `text_region` 字段要求。

---

## [2026-01-14] 重构 Long Event Details 输出结构

### 变更内容

重新设计长事件详情（Activity Event Details）的输出模式，从多字段 JSON 切换回单一 Markdown 字段 `{ "details": "<markdown>" }`，但要求 Markdown 内部遵循严格的三段式大纲。

### 强制 Markdown 大纲

| 章节 | 用途 | 数据来源 |
|---------|------|---------|
| **1. Session Activity (本阶段工作)** | 当前窗口做了什么 | `window_nodes` |
| **2. Current Status & Progress (当前最新进度)** | 全局最新进度和状态 | `thread_latest_nodes` + `thread` context |
| **3. Future Focus & Next Steps (后续关注)** | 建议操作和后续 Focus | 综合推断 + `action_items_json` |

### 输出 Schema

```typescript
interface EventDetailsOutput {
  details: string;  // 严格遵循上述大纲的 Markdown 文本
}
```

### 修改文件

- `docs/alpha-implementation-plan.md`: 更新 `longEventDetails` 配置说明
- `docs/alpha-prompt-templates.md`: 重写 Activity Event Details 的 System Prompt，增加详细的 Markdown 结构化指令。
---

## [2026-01-14] 重构 Activity Event 长事件逻辑

### 变更内容

重新设计 Activity Event 的长事件（is_long）标记逻辑和 Activity Summary 的生成流程。

### 核心变更

1. **`is_long` 标记位置调整**：从 Activity Summary 级别移动到 **Activity Event** 级别
2. **强制生成规则**：如果窗口内有 context node 属于超过 25 分钟的 thread，**必须**生成对应的 activity event
3. **新增 `thread_snapshot_json` 字段**：在 `context_nodes` 表中存储 Thread LLM 分配时的 thread 快照，解决数据一致性问题
4. **LongThreadContext 数据来源**：从 `context_nodes.thread_snapshot_json` 聚合，而非实时查询 threads 表
5. **Details 按需生成**：Activity Event 的 `details` 字段是按需触发的（用户点击时），不在 Summary 阶段生成

### 数据一致性问题解决

**问题**：如果 Thread LLM 更新快、Activity Summary 生成慢，Summary 可能读取到超前的 thread 信息。

**方案**：在 Thread LLM 分配节点到 thread 时，同时将 thread 当前状态快照存入 `context_nodes.thread_snapshot_json`。Activity Summary 从快照读取数据，确保时间点一致性。

### 新增字段

#### `context_nodes.thread_snapshot_json`

```typescript
interface ThreadSnapshot {
  title: string;
  summary: string;
  durationMs: number;      // 快照时刻的 duration
  startTime: number;
  currentPhase?: string;
  mainProject?: string;
}
```

#### `LongThreadContext`（从 thread_snapshot_json 聚合）

```typescript
interface LongThreadContext {
  thread_id: string;
  title: string;              // 从 snapshot 读取
  summary: string;            // 从 snapshot 读取
  duration_ms: number;        // 从 snapshot 读取（快照时刻的值）
  start_time: number;         // 从 snapshot 读取
  last_active_at: number;     // 从 context_nodes.event_time 取最大值
  current_phase?: string;     // 从 snapshot 读取
  main_project?: string;      // 从 snapshot 读取
  node_count_in_window: number;  // 计算值：窗口内对应 thread 的节点数
}
```

### 修改文件

#### `docs/alpha-implementation-plan.md`

**修改位置**: L55-81 (Thread 跨窗口追踪与长事件检测)

**变更内容**:
- 重写"长事件判定"为"长事件判定与 Activity Event 生成"
- 添加 LongThreadContext 接口定义
- 明确落库顺序：Activity Summary → Activity Events → 设置 is_long

#### `docs/alpha-prompt-templates.md`

**修改位置**: Activity Summary 章节

1. **输入 Schema** (L506-560):
   - 新增 `long_threads: LongThreadContext[]` 字段
   - 新增 `LongThreadContext` 接口定义

2. **输出 Schema** (L570-596):
   - `ActivityEventCandidate` 新增 `thread_id?: string` 字段
   - 添加注释说明 details 是按需生成

3. **System Prompt** (L633-700):
   - JSON 示例中添加 `thread_id` 字段
   - events 字段说明添加 **MANDATORY** 规则
   - Hard Rules 新增第 6 条：必须为 long_threads 生成对应 event

4. **User Prompt Template** (L714-730):
   - 新增 `## Long Threads (MUST generate events for these)` 部分
   - 更新 Instructions 中添加强制生成规则

### 设计决策

| 决策 | 理由 |
|-----|------|
| `is_long` 放在 Event 级别 | Activity Event 是实际的"事件"载体，长事件标记更精准 |
| 提供精简的 LongThreadContext | 避免传递过多信息（如 apps_json, milestones_json）浪费 token |
| 包含 `current_phase` 和 `main_project` | 帮助生成更准确的 event kind 和 title |
| 强制生成规则 | 确保长时间工作不会被遗漏 |

### 影响范围

- `activity-timeline-scheduler.ts`：需实现 LongThreadContext 构建逻辑
- `activity-monitor-service.ts`：需在 event 落库后设置 `is_long`
- Activity Summary LLM Prompt 构建函数需传入 `long_threads`

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
