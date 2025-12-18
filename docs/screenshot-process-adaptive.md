--- question
我现在已经实现了app截图和多屏截图，现在需要实现调用vlm来识别图片，和llm来根据context处理多张图片，这样一个screenshot process service。那么这个service里面有多个核心逻辑：
核心逻辑A
1. 截图肯定不是截一张就去请求vlm处理的，我设计的是存10张，然后一次性去请求vlm。
2. 因为可以截图app和多屏，但是又要对图片进行感知哈希 (pHash) 去重，所以去重的时候如果是app截图跟屏幕截图对比肯定是不合理的，那么就需要设计一个map，这个map存储每个截图源的图片数组，然后在这个图片数组中进行去重。但是这个截图源是多变的, 比如用户短时间内切换外接显示屏，短时间内设置不同的app截图@capture-preferences-service.ts 。所以需要有一个维护机制，比如一段时间内去根据@capture-preferences-service.ts 和 @capture-source-provider.ts 去check，那就可以复用@auto-refresh-cache.ts 这个service，还可以根据什么来保证这个map的数据准确？
核心逻辑B
1. 每10张去请求完vlm后，是要再去请求llm，进行context分析的，可以把这样的vlm + llm 叫做一次processed context, 那么需要对processed contexts做队列处理，因为processed context有可能处理的慢，然后下一个10条又来了，这个是有有必要加入冷却时间？防止上一个processed context处理完，就紧接着处理下一个。
2. 每一个processed context是要暂存下来的，我设计的是每存满5个processed context就请求llm做合并处理叫做merged context （请指出我这个设计的合理性），做这段时间的summary，提取keyword和在用的app什么的。merged context 是要暂存下来，跟后面的processed context，再次做merge的，这样设计的原因是为了保证获得用户的连续动作，不会被碎片化。请你review我的这个设计，提出改进
---

---

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
