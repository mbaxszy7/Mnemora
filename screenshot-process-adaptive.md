## description: Screenshot process design, adaptive capture/pHash tuning, and activity summary retry

## 现有实现对齐

- 偏好/源获取：`CapturePreferencesService` 初始化与设置 @electron/services/capture-preferences-service.ts#15-41，计算有效源 @electron/services/capture-preferences-service.ts#52-85
- 源缓存：`CaptureSourceProvider` @electron/services/screen-capture/capture-source-provider.ts#31-96
- 自动刷新缓存：`AutoRefreshCache` @electron/services/screen-capture/auto-refresh-cache.ts#28-118

## Screenshot Process Service 设计

### 核心组件

- **SourceRegistry**：定期用 CaptureSourceProvider + CapturePreferencesService 拉取有效源；下线源清理，新增源补充。
- **Per-Source Buffers**：`Map<sourceKey, RingBuffer<CaptureFrame>>`，每 6s 一帧；`sourceKey = ${type}:${id}`（屏幕用 displayId，窗口用 id）。
- **pHash 去重**：仅在同源内比较，距离 < 阈值跳过；跨源不比，避免屏幕/窗口互杀。
- **Batcher**：单源凑满 10 张或到时间上限（如 70s 未凑满）打 batch 送 VLM。
- **VLM Worker Pool**：并发 2-3，队列化 batch，失败重试 1 次，超时标记丢弃。
- **Processed Context Queue**：VLM 完成后串行/轻量 LLM contextualize，形成 `ProcessedContext` 入队。
- **Merge Scheduler**：`max(5 个 processed, 6 分钟)` 先到触发合并成 `MergedContext`，避免低流量不合并。
- **Activity Summary Publisher**：每 15 分钟触发（cron + 补偿），消费最近 `MergedContext`（或回落到 `ProcessedContext`）生成 summary；插件化输出。

### 关键数据结构

```ts
type SourceKey = string; // type:id
interface CaptureFrame {
  source: SourceKey;
  ts: number;
  phash: string;
  dataUrl: string;
}
interface VlmBatch {
  source: SourceKey;
  frames: CaptureFrame[];
}
interface ProcessedContext {
  id;
  tsStart;
  tsEnd;
  frames: CaptureFrame[];
  vlmResult;
  llmContext;
}
interface MergedContext {
  id;
  windowStart;
  windowEnd;
  processedIds: string[];
  summary;
  keywords;
  activeApps;
}
```

### 去重与源维护

- 只在同源内做 pHash；跨源不比。
- 用 AutoRefreshCache 保持最新源列表，定期（如 30s）sweep `Map`，移除无效源并回收缓冲。
- 对刚下线源设 grace（1-2 个刷新周期）避免抖动。

### 背压与节流

- 采集侧：若队列长度 > N（如 50 个 VLM batch 待处理），可暂停采集或提高 pHash 阈值（激进去重）。
- VLM/LLM：worker pool + 队列 + 超时；VLM 并发有限，LLM 串行或小并发（1-2）。
- 不强制冷却；用并发上限 + 队列长度驱动动态降采样。

### 时序校准（时间补偿）

- 帧记录 ts，Processed/Merged 按时间排序，不依赖到达序。
- Merge 用滑动窗口（如 10 分钟），淘汰窗口外 processed，保持连续性与内存可控。

### 设计点评与改进

- “10 张再请求 VLM”：保留但加时间上限（如 70s）。
- “5 个 processed 再 merge”：改为 min-count + max-age，避免低吞吐卡住；高吞吐用固定窗口避免过长上下文。
- “冷却时间”：用并发池+队列阈值替代；队列过长临时降采样/跳帧。
- “连续动作不碎片化”：滑动窗口 merge，窗口间 30-50% overlap，或增量 summary 定期重写。

### 时间线示例（与现估算对齐并更健壮）

- 采集：6s/帧
- Batch：10 张或 70s 触发
- VLM+LLM：假设 20s/批；并发 2，约 30-40s 清一批
- Merge：5 个 processed 或 6 分钟先到
- Activity summary：每 15 分钟，补偿缺口

## Adaptive Capture & pHash (队列积压自适应)

**队列定义（用于积压判断）**

- 以 **VLM batch 处理队列** 为主指标：采集后的 10 张（或时间上限）形成的 batch 等待送 VLM 的排队长度。如果 VLM 并发有限而积压增长，说明需要降采样。
- 备选/附加指标：Processed Context 队列长度（VLM 结束、待 LLM contextualize）也可作为辅助信号，但首选 VLM batch 队列。

**配置（建议放在 `screen-capture/types.ts` 与默认配置同处，便于调试）**

```ts
export interface AdaptiveCaptureConfig {
  baseIntervalMs: number; // 正常采样间隔（现有 DEFAULT_SCHEDULER_CONFIG.interval）
  maxIntervalMs: number; // 积压时可拉长到的最大采样间隔 —— 针对 "VLM batch 队列" 的积压控制
  minIntervalMs: number; // 采样间隔下限（现有 DEFAULT_SCHEDULER_CONFIG.minDelay）
  phashSimilarityCutoff: number; // 正常模式下的 pHash 汉明距离阈值
  phashSimilarityCutoffAggressive: number; // 积压模式下的更宽松阈值，便于更多判重、减少入队
  backlogHighWatermark: number; // VLM batch 队列长度的上水位，达到后进入积压模式
  backlogLowWatermark: number; // 队列降到此值以下恢复正常模式，避免频繁抖动
  upscaleStepMs: number; // 每次拉长采样间隔的步进值（用于从 baseInterval 向上调节），直到不超过 maxIntervalMs
}
```

**运行时策略**

- 正常模式：采样间隔 = `baseIntervalMs`，pHash 阈值 = `phashSimilarityCutoff`。
- 积压模式触发：`VLM batch 队列长度 ≥ backlogHighWatermark`。
  - 采样间隔每次增加 `upscaleStepMs`，上限 `maxIntervalMs`。
  - pHash 阈值切到 `phashSimilarityCutoffAggressive`，更容易判重减少写入。
- 恢复：`队列长度 ≤ backlogLowWatermark`。
  - 采样间隔按 `upscaleStepMs` 逐步回落（对称递减），不低于 `baseIntervalMs`。
  - pHash 阈值恢复正常值。

**参考默认值（可调整）**

- baseIntervalMs: 6000
- maxIntervalMs: 12000
- minIntervalMs: 100
- phashSimilarityCutoff: 8
- phashSimilarityCutoffAggressive: 12
- backlogHighWatermark: 50
- backlogLowWatermark: 20
- upscaleStepMs: 1000

**应用位置**

- 采集调度器读取动态 `currentIntervalMs`（不要写死 DEFAULT）；当进入积压模式时用 `upscaleStepMs` 逐步拉长到 `maxIntervalMs`。
- pHash 去重读取当前模式的阈值，积压模式使用 `phashSimilarityCutoffAggressive`。
- 队列长度来源：VLM batch 队列为主；如需更保守，可同时观察 Processed Context 队列。

## Activity Summary Service：重试与补偿

**配置（集中放同处便于调试）**

```ts
export interface ActivitySummaryConfig {
  intervalMs: number; // 15 * 60 * 1000
  taskTimeoutMs: number; // 单次 LLM 调用超时，如 25000
  maxRetries: number; // 3
  backoffScheduleMs: number[]; // [5000, 20000, 60000]
  compensationLookbackMs: number; // 补偿扫回窗口，如 30 * 60 * 1000
}
```

**流程**

1. 定时（intervalMs）确定窗口与 MergedContext 列表，生成任务 key（window start-end + ids）保证幂等。
2. Worker 执行：LLM 调用超时/失败 -> 标记失败，按 backoffScheduleMs 重试，最多 maxRetries。
3. 超过 maxRetries：写占位结果（"summary unavailable, will retry later"），并登记为待补偿。
4. 补偿：下一周期扫描过去 `compensationLookbackMs` 内失败的窗口重新排队；成功后清理标记。

## Activity Summary Service（插件化消费）

- **输入**：`MergedContext` 流（回退可用 `ProcessedContext`）。
- **Scheduler**：每 15 分钟触发；数据稀疏仍产出“无显著活动”。
- **插件接口**：

```ts
interface SummaryPlugin {
  name: string;
  run(ctxs: MergedContext[]): Promise<SummaryChunk>;
}
```

- 主 summary 可调用多个插件（activity / topic / risk ...），合并输出。
- **持久化**：环形存储最近若干小时的 `MergedContext` 与 Summary；后续 topic summary 复用。
- **幂等/补偿**：窗口 key 避免重复写入；失败进入补偿队列，成功后清理标记。

## 落地提示

- 把 `AdaptiveCaptureConfig` 和 `ActivitySummaryConfig` 及默认值放在 `screen-capture/types.ts` 旁边，与现有 DEFAULT 配置同一处，方便调试。
- 采集调度器/去重读取动态配置值，不要写死常量。
- VLM/LLM 队列长度需可观测（日志/metrics），驱动自适应逻辑。
- Summary 幂等依赖窗口 key，避免重复写入；补偿要记得清理成功记录。

## 改进方案（基于 prompts_en.yaml 与 PURE_FRONTEND_ARCHITECTURE.md 评估）

以下改进针对现有设计的关键缺失点，提供详细可执行的实现方案。

### 1. 一截图多上下文提取（Multi-Context Extraction）

**现状问题**：当前 VLM 返回单一结果，丢失了同一截图中的多维信息（如用户行为 + 技术知识 + 状态数据）。

**改进方案**：

```ts
// VLM 返回结构调整
interface VlmExtractionResult {
  items: VlmExtractedItem[]; // 一张截图可返回多个 item
}

interface VlmExtractedItem {
  context_type: ContextType; // activity_context | semantic_context | state_context | procedural_context | intent_context
  screen_ids: number[]; // 关联的截图序号（batch 内 1-indexed）
  decision: "NEW" | "MERGE"; // VLM 初步判断
  history_id?: string; // MERGE 时指向历史 ID
  analysis: {
    title: string;
    summary: string;
    keywords: string[];
    entities: EntityInfo[]; // 必填，至少 1-5 个
    importance: number; // 0-10
    confidence: number; // 0-10
    event_time?: string; // ISO 8601
  };
}

interface EntityInfo {
  name: string;
  type: "person" | "project" | "product" | "organization" | "document" | "location";
  description?: string;
  aliases?: string[];
  metadata?: Record<string, string>;
}

enum ContextType {
  ACTIVITY_CONTEXT = "activity_context", // 用户行为
  SEMANTIC_CONTEXT = "semantic_context", // 技术知识
  STATE_CONTEXT = "state_context", // 状态数据
  PROCEDURAL_CONTEXT = "procedural_context", // 操作流程
  INTENT_CONTEXT = "intent_context", // 未来计划
}
```

**VLM Prompt 要点**（参考 prompts_en.yaml:408-674）：

1. **默认优先原则**：每张截图必须先生成 `activity_context`，再主动识别其他类型
2. **主动提取策略**：
   - 看到产品介绍页 → `activity_context` + `semantic_context`
   - 看到任务看板 → `activity_context` + `state_context`
   - 看到多步操作序列 → `activity_context` + `procedural_context`
3. **描述风格匹配**：不同 context_type 使用对应的描述风格
   - `activity_context`: "current_user 正在查看..."
   - `semantic_context`: "该技术架构采用..."
   - `state_context`: "项目进度显示..."

**实现位置**：`vlm-processor.ts` 的 prompt 构造与响应解析

---

### 2. 历史上下文传递给 VLM（History Context for Continuity）

**现状问题**：VLM 无法感知之前截图的上下文，难以识别跨截图的活动连续性。

**改进方案**：

```ts
interface VlmBatchRequest {
  frames: CaptureFrame[];
  history: HistoryContextSummary[]; // 最近 N 条未完结的上下文摘要
}

interface HistoryContextSummary {
  id: string;
  context_type: ContextType;
  title: string;
  summary: string; // 简化摘要，控制 token
  keywords: string[];
  last_update: number;
}

// 获取历史上下文
function getRecentHistoryForVlm(): HistoryContextSummary[] {
  // 从 ProcessedContextCache 获取每个 context_type 最近的 1-2 条
  const historyLimit = 2;
  const result: HistoryContextSummary[] = [];

  for (const type of Object.values(ContextType)) {
    const cached = processedContextCache.get(type);
    if (cached) {
      result.push(
        ...cached.slice(-historyLimit).map((c) => ({
          id: c.id,
          context_type: type,
          title: c.extracted_data.title,
          summary: c.extracted_data.summary.slice(0, 200), // 截断控制 token
          keywords: c.extracted_data.keywords,
          last_update: c.properties.update_time,
        }))
      );
    }
  }
  return result;
}
```

**VLM User Prompt 模板**：

```
Historical context:
{history_json}

---
Please analyze the following {total_screenshots} new screenshots...
```

---

### 3. 按 context_type 分组合并（Type-Based Merge Strategy）

**现状问题**：当前 Merge Scheduler 混合处理所有上下文，但不同类型的合并标准差异很大。

**改进方案**：

```ts
// 按 context_type 分组后并发执行合并
interface MergeConfig {
  [ContextType.ACTIVITY_CONTEXT]: {
    strictMode: true; // 严格：必须是同一明确任务才合并
    maxMergeCount: 10; // 单个上下文最多被合并 10 次
  };
  [ContextType.SEMANTIC_CONTEXT]: {
    strictMode: false; // 宽松：同主题的知识内容可合并
    maxMergeCount: 20;
  };
  [ContextType.STATE_CONTEXT]: {
    strictMode: false; // 同对象的状态更新可合并
    maxMergeCount: 5; // 状态变化频繁，少量合并
  };
  // ...
}

// 并发合并（参考 PURE_FRONTEND_ARCHITECTURE.md:603-625）
async function mergeByType(
  newItems: Map<ContextType, ProcessedContext[]>,
  cache: ProcessedContextCache
): Promise<ProcessedContext[]> {
  const tasks: Promise<ProcessedContext[]>[] = [];

  for (const [type, items] of newItems) {
    const cachedItems = cache.get(type) || [];
    tasks.push(mergeSingleType(type, items, cachedItems));
  }

  const results = await Promise.all(tasks);
  return results.flat();
}

async function mergeSingleType(
  type: ContextType,
  newItems: ProcessedContext[],
  cachedItems: ProcessedContext[]
): Promise<ProcessedContext[]> {
  // 调用 LLM 判断合并决策
  const prompt = buildMergePrompt(type, newItems, cachedItems);
  const decision = await llmClient.call(prompt);

  // 解析返回：merged_ids + new data
  return applyMergeDecision(decision, newItems, cachedItems);
}
```

**activity_context 合并严格标准**（参考 prompts_en.yaml:714-720）：

- ✅ 应合并："编写登录功能代码" + "继续编写登录功能代码" — 同一任务延续
- ❌ 不应合并："配置工具凭证" + "编辑配置文件" — 相关但独立操作
- ❌ 不应合并："查看成功日志" + "处理错误消息" — 结果状态不同

---

### 4. 渐进式合并与缓存更新（Progressive Merging）

**现状问题**：合并后的 MergedContext 不再参与后续合并，形成信息孤岛。

**改进方案**：

```ts
class ProcessedContextCache {
  private cache: Map<ContextType, Map<string, ProcessedContext>> = new Map();

  // 合并后更新缓存：移除旧项，添加新项（可再次被合并）
  updateAfterMerge(
    type: ContextType,
    mergedContext: ProcessedContext,
    mergedFromIds: string[]
  ): void {
    const typeCache = this.cache.get(type);
    if (!typeCache) return;

    // 1. 删除被合并的旧项
    for (const oldId of mergedFromIds) {
      typeCache.delete(oldId);
    }

    // 2. 添加合并后的新项（可被后续合并）
    typeCache.set(mergedContext.id, mergedContext);
  }

  // 清理过期上下文（滑动窗口）
  pruneOldContexts(maxAgeMs: number = 10 * 60 * 1000): void {
    const now = Date.now();
    for (const [type, typeCache] of this.cache) {
      for (const [id, ctx] of typeCache) {
        if (now - ctx.properties.update_time > maxAgeMs) {
          typeCache.delete(id);
          // 触发存储（窗口外的上下文固化到向量库）
          this.persistToVectorDB(ctx);
        }
      }
    }
  }
}
```

**时间线示例**：

```
17:30 截图1 → A (新建，入缓存)
17:32 截图2 → B (新建)
       ↓ LLM: A + B 主题相同 → 合并为 AB
       ↓ A、B 从缓存删除，AB 入缓存
17:35 截图3 → C (新建)
       ↓ LLM: AB + C 主题相同 → 合并为 ABC
       ↓ AB 从缓存删除，ABC 入缓存（可继续被合并）
17:50 截图4 → D (新建)
       ↓ LLM: ABC 和 D 主题不同 → 不合并
       ↓ D 入缓存，ABC 保留
```

---

### 5. 完善 ProcessedContext 数据结构

**现状问题**：当前 `ProcessedContext` 缺少 vectorize、置信度、实体等关键字段。

**改进方案**：

```ts
interface ProcessedContext {
  id: string; // UUID

  // 属性信息
  properties: {
    raw_properties: RawContextProperties[]; // 原始截图属性列表
    create_time: number; // 首次创建时间戳
    event_time?: number; // 事件发生时间戳
    update_time: number; // 最后更新时间戳
    duration_count: number; // 持续截图数量（合并计数）
    merge_count: number; // 被合并次数
    is_processed: boolean;
    enable_merge: boolean;
  };

  // VLM 提取的数据
  extracted_data: {
    context_type: ContextType;
    title: string;
    summary: string;
    keywords: string[];
    entities: EntityInfo[];
    importance: number; // 0-10
    confidence: number; // 0-10
  };

  // 向量化信息
  vectorize: {
    content_format: "text" | "image";
    text: string; // title + summary
    vector?: number[]; // embedding 向量
  };

  // 元数据
  metadata: {
    merged_from?: string[]; // 被合并的上下文 ID 列表
    screenshot_paths?: string[];
    source_key?: string; // 来源标识
  };
}

interface RawContextProperties {
  object_id: string;
  content_format: "image";
  source: "screenshot";
  content_path: string;
  create_time: number;
  phash: string;
  source_key: string;
}
```

---

### 6. 向量化步骤（Vectorization）

**现状问题**：当前方案没有向量化步骤，无法支持语义检索。

**改进方案**：

```ts
// LLM 合并后，并发执行向量化和实体提取
async function postMergeProcessing(contexts: ProcessedContext[]): Promise<ProcessedContext[]> {
  const tasks = contexts.map(async (ctx) => {
    // 并发执行向量化和实体提取
    const [vector, entities] = await Promise.all([
      generateEmbedding(ctx.vectorize.text),
      refreshEntities(ctx.extracted_data.entities, ctx.vectorize.text),
    ]);

    ctx.vectorize.vector = vector;
    ctx.extracted_data.entities = entities;
    return ctx;
  });

  return Promise.all(tasks);
}

async function generateEmbedding(text: string): Promise<number[]> {
  // 调用 Embedding API（如 OpenAI text-embedding-3-small）
  const response = await embeddingClient.embed({
    input: text,
    model: "text-embedding-3-small",
  });
  return response.data[0].embedding; // 1536 维
}

// 向量化内容 = title + summary
function buildVectorizeText(ctx: ProcessedContext): string {
  return `${ctx.extracted_data.title} ${ctx.extracted_data.summary}`;
}
```

---

### 7. 双存储架构（Dual Storage）

**现状问题**：只有 MergedContext，缺少 Vector DB + SQLite 的分工。

**改进方案**：

```ts
// 存储职责划分
interface StorageArchitecture {
  vectorDB: {
    // 按 context_type 分 Collection
    collections: {
      activity_context: ProcessedContext[];
      semantic_context: ProcessedContext[];
      state_context: ProcessedContext[];
      procedural_context: ProcessedContext[];
      intent_context: ProcessedContext[];
    };
    // 用途：语义检索
    query: (query: string, top_k: number) => ProcessedContext[];
  };

  sqlite: {
    // 存储聚合后的活动摘要
    activity: Activity[]; // ActivityMonitor 生成
    todo: Todo[]; // 自动/手动创建
    tips: Tip[]; // 智能建议
    vaults: Vault[]; // 知识库文档/日报
    // 用途：时间线展示、结构化查询
  };
}

// SQLite Activity 表结构
interface Activity {
  id: number;
  title: string;
  content: string; // 活动描述
  resources: string[]; // 关联截图路径
  metadata: {
    category_distribution: Record<string, number>;
    insights: string[];
    potential_todos: string[];
    tips: string[];
  };
  start_time: Date;
  end_time: Date;
}

// 关系：多个 ProcessedContext 聚合生成一个 Activity
// ProcessedContext (Vector DB) → N:1 → Activity (SQLite)
```

**存储时序**：

```
batch_process() 内部：
├─ mergeContexts()：
│   └─ vectorDB.delete(old_ids)  ← 立即删除被合并的旧项
│
batch_process() 返回后：
└─ vectorDB.batchUpsert(new_items) ← 批量存储新项

ActivityMonitor (每 15 分钟)：
├─ vectorDB.query(time_range)
├─ llm.generateSummary(contexts)
└─ sqlite.insert(activity)
```

---

### 8. 低质量过滤（Confidence & Importance Filter）

**现状问题**：没有过滤低质量上下文的机制。

**改进方案**：

```ts
interface QualityFilterConfig {
  minConfidence: number; // 最低置信度阈值，默认 5
  minImportance: number; // 最低重要性阈值，默认 3
  dropDuplicateSummary: boolean; // 去除重复摘要
}

function filterLowQualityContexts(
  contexts: ProcessedContext[],
  config: QualityFilterConfig
): ProcessedContext[] {
  return contexts.filter((ctx) => {
    const { confidence, importance } = ctx.extracted_data;

    // 过滤低置信度
    if (confidence < config.minConfidence) {
      logger.debug(`Dropping low-confidence context: ${ctx.id}`);
      return false;
    }

    // 过滤低重要性
    if (importance < config.minImportance) {
      logger.debug(`Dropping low-importance context: ${ctx.id}`);
      return false;
    }

    return true;
  });
}
```

---

### 9. 改进的 MergedContext 与 Activity 关系

**现状问题**：MergedContext 定义模糊，与 ProcessedContext/Activity 的关系不清晰。

**改进方案**：移除 MergedContext 概念，改为：

```ts
// 处理流水线清晰化
type Pipeline = {
  // 阶段 1：采集
  capture: CaptureFrame[];

  // 阶段 2：VLM 提取（返回多上下文）
  vlmExtract: (frames: CaptureFrame[]) => VlmExtractedItem[];

  // 阶段 3：构造 ProcessedContext + 合并
  mergeAndProcess: (items: VlmExtractedItem[], cache: ProcessedContextCache) => ProcessedContext[];

  // 阶段 4：向量化 + 存储到 Vector DB
  vectorizeAndStore: (contexts: ProcessedContext[]) => void;

  // 阶段 5：定时聚合生成 Activity（存储到 SQLite）
  generateActivity: (contexts: ProcessedContext[]) => Activity;
};
```

---

### 10. 实体消歧与关系追踪（Entity Disambiguation）

**现状问题**：缺少实体提取和消歧机制。

**改进方案**：

```ts
interface EntityRegistry {
  // 规范名 → 实体信息
  entities: Map<
    string,
    {
      canonical_name: string;
      type: string;
      aliases: Set<string>;
      mentioned_in: string[]; // context IDs
      profile?: string;
    }
  >;

  // 查找或创建实体
  findOrCreate(entity: EntityInfo): string; // 返回 canonical_name

  // 精确匹配
  findExact(name: string): EntityInfo | null;

  // 相似匹配（向量搜索）
  findSimilar(name: string, threshold: number): EntityInfo[];
}

// 实体消歧流程
async function refreshEntities(
  rawEntities: EntityInfo[],
  contextText: string
): Promise<EntityInfo[]> {
  const result: EntityInfo[] = [];

  for (const entity of rawEntities) {
    // 1. 精确匹配
    const existing = entityRegistry.findExact(entity.name);
    if (existing) {
      result.push({ ...existing, ...entity });
      continue;
    }

    // 2. 相似匹配（同名不同写法）
    const similar = await entityRegistry.findSimilar(entity.name, 0.9);
    if (similar.length > 0) {
      // 可选：LLM 决策是否为同一实体
      result.push({ ...similar[0], aliases: [...(similar[0].aliases || []), entity.name] });
      continue;
    }

    // 3. 新实体
    entityRegistry.findOrCreate(entity);
    result.push(entity);
  }

  return result;
}
```

---

### 11. 改进的流水线架构图

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            Screenshot Processing Pipeline                         │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  ┌─────────┐   ┌──────────┐   ┌─────────────┐   ┌──────────────────────────┐     │
│  │ Capture │──▶│  pHash   │──▶│  Batcher    │──▶│  VLM Worker Pool (2-3)   │     │
│  │ (6s/帧) │   │  Dedup   │   │ (10张/70s)  │   │  返回多 context_type     │     │
│  └─────────┘   └──────────┘   └─────────────┘   └────────────┬─────────────┘     │
│                                                               │                   │
│                                              ┌────────────────▼────────────────┐ │
│                                              │   Multi-Context Extraction      │ │
│                                              │   一截图 → N 个上下文            │ │
│                                              │   (activity + semantic + ...)   │ │
│                                              └────────────────┬────────────────┘ │
│                                                               │                   │
│  ┌───────────────────────────────────────────────────────────▼──────────────────┐│
│  │                   Type-Based Merge (按 context_type 分组并发)                ││
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐             ││
│  │  │ activity    │ │ semantic   │ │ state       │ │ procedural  │  ...        ││
│  │  │ (严格合并)  │ │ (宽松合并) │ │ (状态更新) │ │ (步骤累积) │             ││
│  │  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘ └──────┬──────┘             ││
│  └─────────┼───────────────┼───────────────┼───────────────┼────────────────────┘│
│            │               │               │               │                     │
│            └───────────────┴───────────────┴───────────────┘                     │
│                                     │                                             │
│                        ┌────────────▼────────────────┐                           │
│                        │  Progressive Merging Cache  │                           │
│                        │  合并后重新入缓存可再合并   │                           │
│                        └────────────┬────────────────┘                           │
│                                     │                                             │
│            ┌────────────────────────┼────────────────────────┐                   │
│            │                        │                        │                   │
│  ┌─────────▼─────────┐  ┌──────────▼──────────┐  ┌──────────▼──────────┐        │
│  │ Quality Filter    │  │ Vectorization       │  │ Entity Extraction   │        │
│  │ (confidence/      │  │ (title + summary    │  │ (消歧 + 关系追踪)  │        │
│  │  importance)      │  │  → embedding)       │  │                     │        │
│  └─────────┬─────────┘  └──────────┬──────────┘  └──────────┬──────────┘        │
│            └────────────────────────┼────────────────────────┘                   │
│                                     │                                             │
│                        ┌────────────▼────────────────┐                           │
│                        │     Dual Storage            │                           │
│                        │  ┌──────────┐ ┌──────────┐ │                           │
│                        │  │Vector DB │ │ SQLite   │ │                           │
│                        │  │(Contexts)│ │(Activity)│ │                           │
│                        │  └──────────┘ └──────────┘ │                           │
│                        └─────────────────────────────┘                           │
│                                                                                   │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │                   Activity Summary Publisher (每 15 分钟)                   │ │
│  │   Vector DB 查询 → LLM 聚合生成 → Activity 存储到 SQLite                   │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

### 12. 配置汇总

```ts
export interface ScreenshotProcessingConfig {
  // 采集配置（已有）
  capture: AdaptiveCaptureConfig;

  // VLM 配置
  vlm: {
    workerPoolSize: number; // 并发数，默认 2-3
    batchSize: number; // 批次大小，默认 10
    batchTimeoutMs: number; // 批次超时，默认 70000
    historyContextLimit: number; // 传给 VLM 的历史上下文数，默认 2/类型
  };

  // 合并配置
  merge: {
    cacheWindowMs: number; // 缓存窗口，默认 10 分钟
    triggerMinCount: number; // 最少 processed 数触发合并，默认 5
    triggerMaxAgeMs: number; // 最长等待时间触发合并，默认 6 分钟
    typeConfigs: Record<
      ContextType,
      {
        strictMode: boolean;
        maxMergeCount: number;
      }
    >;
  };

  // 质量过滤
  filter: QualityFilterConfig;

  // 向量化配置
  vectorize: {
    embeddingModel: string; // 默认 'text-embedding-3-small'
    embeddingDimension: number; // 默认 1536
  };

  // Activity Summary（已有）
  activitySummary: ActivitySummaryConfig;
}
```

---

### 13. 实现优先级建议

| 优先级 | 改进项                     | 工作量 | 价值 |
| :----: | :------------------------- | :----: | :--: |
|   P0   | 一截图多上下文提取         |   中   |  高  |
|   P0   | 按 context_type 分组合并   |   中   |  高  |
|   P1   | 完善 ProcessedContext 结构 |   低   |  高  |
|   P1   | 向量化步骤                 |   低   |  高  |
|   P1   | 双存储架构                 |   中   |  高  |
|   P2   | 渐进式合并缓存             |   中   |  中  |
|   P2   | 历史上下文传递给 VLM       |   低   |  中  |
|   P2   | 低质量过滤                 |   低   |  中  |
|   P3   | 实体消歧                   |   高   |  中  |
