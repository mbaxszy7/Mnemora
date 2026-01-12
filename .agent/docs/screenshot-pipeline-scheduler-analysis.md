# Screenshot Pipeline Scheduler 详细技术分析

## 概述

`screenshot-pipeline-scheduler.ts` 是截图处理管线的核心调度器,负责协调从截图采集到最终语义节点生成的完整流程。

---

## 一、完整数据流程

### 1.1 截图完成 → Batch 构建

**入口**: `screenshot-processing-module.ts` L127-L162 (`onCaptureComplete`)

```typescript
// 步骤1: 截图采集完成后的处理
onCaptureComplete(event: CaptureCompleteEvent)
  ├─ 遍历每个截图结果 (event.result)
  ├─ 构建 sourceKey: "screen:displayId" 或 "window:windowId"
  ├─ 构建 ScreenshotInput:
  │   ├─ sourceKey
  │   ├─ imageBuffer (用于 pHash 去重)
  │   └─ screenshot metadata (ts, filePath, appHint, windowTitle)
  └─ 调用 sourceBufferRegistry.add(input)
```

**输入**:
- `result.buffer`: 图片的二进制数据
- `result.timestamp`: 截图时间戳
- `result.filePath`: 图片存储路径
- `result.source`: 来源信息 (屏幕/窗口)

**输出**:
- 如果 `accepted=true`: 截图加入 buffer,等待批次处理
- 如果 `accepted=false`: 删除截图文件 (重复或来源不活跃)

**数据落库**: `source-buffer-registry.ts` L184-L194
```typescript
persistAcceptedScreenshot() 
  → screenshots 表插入记录
  → 字段: sourceKey, ts, filePath, phash, vlmStatus='pending', createdAt
```

---

### 1.2 Buffer → Batch 生成

**处理器**: `source-buffer-registry.ts`

```typescript
// 步骤2: Buffer 积累到批次条件
processReadyBatches(trigger: 'add' | 'timeout')
  ├─ 检查每个 source buffer 是否满足:
  │   ├─ 数量 >= batchSize (默认 5)
  │   └─ 或超时 >= batchTimeoutMs (默认 30秒)
  ├─ drainForBatch(sourceKey) → 清空 buffer,获取截图列表
  └─ 发出事件: screenshotProcessingEventBus.emit('batch:ready', batches)
```

**trigger 时机**:
1. `add`: 每次新截图加入 buffer 时检查
2. `timeout`: 定时器 (每 30秒) 检查

**输入**: 
- Buffer 中的 `AcceptedScreenshot[]`

**输出**: 
- `BatchReadyEvent` 事件,包含按 sourceKey 分组的截图列表

---

### 1.3 Batch 持久化

**处理器**: `batch-builder.ts` → `createAndPersistBatch()`

```typescript
// 步骤3: 创建并持久化 Batch
createAndPersistBatch(sourceKey, screenshots)
  ├─ createBatch() → 生成 Batch 对象
  │   ├─ batchId = `batch_${timestamp}_${random}`
  │   ├─ idempotencyKey = `vlm_batch:${sourceKey}:${tsStart}-${tsEnd}:${hash}`
  │   └─ 按时间排序截图
  ├─ buildHistoryPack(sourceKey) → 查询上下文
  │   ├─ 最近 3 个活跃线程 (threadId)
  │   ├─ 15分钟内的 open segments
  │   └─ 最近 10 个提及的实体
  └─ persistBatch() → 落库
      ├─ batches 表插入
      └─ 更新 screenshots.enqueuedBatchId
```

**输入**:
- `screenshots`: 已接受的截图列表

**输出**:
- `batch`: Batch 对象 (包含 historyPack)
- `dbId`: 数据库中的 batch.id

**数据落库**: `batches` 表
```sql
INSERT INTO batches (
  batchId, sourceKey, screenshotIds, tsStart, tsEnd,
  historyPack, idempotencyKey, status='pending', attempts=0
)
```

**关键**: 发出 `batch:persisted` 事件 → 唤醒 scheduler

---

### 1.4 Batch → Shards 分片

**处理器**: `batch-builder.ts` → `splitIntoShards()`

```typescript
// 步骤4: 将 Batch 切分为 Shards (并行处理单元)
splitIntoShards(batch, shardSize=5)
  └─ 每 5 个截图创建一个 Shard
      ├─ shardIndex: 分片索引
      ├─ screenshots: ScreenshotWithData[] (包含 base64 占位)
      └─ historyPack: 与 batch 共享

// 示例: 12 个截图 → 3 个 shards
// Shard 0: screenshots[0-4]
// Shard 1: screenshots[5-9]
// Shard 2: screenshots[10-11]
```

**输入**:
- `batch.screenshots`: 已排序的截图列表
- `batch.historyPack`: 上下文信息

**输出**:
- `Shard[]`: 分片数组,每个最多 5 个截图

**目的**: 
- VLM 对图片数量有限制,分片后并行处理提升吞吐量

---

### 1.5 Shards → VLM 处理

**处理器**: `vlm-processor.ts` → `processBatch()` + `processShard()`

```typescript
// 步骤5: VLM 视觉分析
processBatch(batch, shards)
  ├─ processShardsConcurrently(shards) → 并发处理 shards
  │   ├─ 并发数: min(vlmGlobalConcurrency, shards.length)
  │   └─ 每个 worker:
  │       ├─ loadShardImages(shard) → 加载 base64 图片数据
  │       └─ processShard(shard) → 调用 VLM API
  │           ├─ 构建 VLM 请求 (screenshots + historyPack)
  │           ├─ 获取 VLM semaphore (并发控制)
  │           ├─ generateObject() → 调用视觉模型
  │           └─ 解析返回: VLMIndexResult
  │               ├─ segments[] (事件片段)
  │               ├─ entities[] (识别的实体)
  │               └─ screenshots[] (OCR + UI snippets)
  ├─ mergeShardResults() → 合并所有 shard 结果
  │   ├─ 去重边界 segments
  │   ├─ 合并 entities (去重)
  │   └─ 限制 segments ≤ maxSegmentsPerBatch
  └─ updateScreenshotStatuses() → 更新 screenshots.vlmStatus='succeeded'
```

**输入**:
- `shards`: 带 base64 图片数据的分片列表
- History context (threads, segments, entities)

**VLM 请求结构**:
```typescript
{
  system: VLM system prompt,
  userContent: [
    { type: 'text', text: prompt },
    { type: 'image', image: 'data:image/jpeg;base64,...' },
    { type: 'image', image: 'data:image/jpeg;base64,...' },
    ...
  ]
}
```

**VLM 输出** (`VLMIndexResult`):
```typescript
{
  segments: [
    {
      segment_id: 'seg_xxx',
      screen_ids: [1, 2],
      event: { title, summary, importance, confidence },
      derived: {
        knowledge: [{ title, summary }],
        state: [...],
        procedure: [...],
        plan: [...]
      },
      merge_hint: { decision: 'NEW' | 'MERGE', thread_id? },
      keywords: [...],
    }
  ],
  entities: ['Entity1', 'Entity2'],
  screenshots: [
    {
      screenshot_id: 123,
      ocr_text: '...',
      ui_text_snippets: [...],
      app_guess: { name: 'VSCode', confidence: 0.9 }
    }
  ]
}
```

**数据落库**: 
- `screenshots` 表更新: `vlmStatus='succeeded'`, `ocrText`, `uiTextSnippets`, `detectedEntities`, `retentionExpiresAt`

---

### 1.6 VLM Index → Text LLM Expansion

**处理器**: `text-llm-processor.ts` → `expandToNodes()`

```typescript
// 步骤6: 将 VLM 结果扩展为语义节点
expandToNodes(vlmIndex, batch)
  ├─ buildEvidencePacks() → 提取证据
  │   └─ 为每个截图收集: appHint, windowTitle, ocrText, uiTextSnippets
  ├─ callTextLLMForExpansion() → 调用 Text LLM (可选)
  │   ├─ 构建详细的 expansion prompt
  │   ├─ 获取 text semaphore
  │   └─ generateObject() → 返回 TextLLMExpandResult
  │       ├─ nodes[] (event + derived nodes)
  │       └─ edges[] (node 间关系)
  ├─ convertToPendingNodes() → 转换为内部结构
  │   ├─ 处理 event nodes (kind='event')
  │   └─ 处理 derived nodes (kind='knowledge'|'state'|'procedure'|'plan')
  ├─ processMergeHints() → 处理 merge 决策
  │   ├─ 为每个 event node 分配 threadId
  │   ├─ 根据 merge_hint.decision:
  │   │   ├─ MERGE → 使用 merge_hint.thread_id
  │   │   └─ NEW → 生成新 thread_id
  │   └─ Derived nodes 继承 source event 的 threadId
  └─ persistNodes() → 落库到 context_nodes
      ├─ 生成 originKey (幂等性保证)
      ├─ 调用 contextGraphService.createNode()
      └─ 为每个 event 同步 entity mentions
```

**Text LLM Expansion 输入** (如果启用):
```typescript
{
  localTime: '2026-01-12 16:48:25',
  timeZone: 'Asia/Shanghai',
  segments: [...],  // VLM segments
  screenshotMapping: [
    { screen_id: 1, database_id: 123, ts, source_key, app_hint, window_title }
  ],
  evidencePacks: [
    { screenshotId, appHint, windowTitle, ocrText, uiTextSnippets }
  ]
}
```

**Text LLM 输出**:
```typescript
{
  nodes: [
    {
      kind: 'event',
      thread_id: 'thread_xxx',
      title: '...',
      summary: '...',
      keywords: [...],
      entities: [{ name, entityType, confidence }],
      importance: 7,
      confidence: 8,
      screenshot_ids: [123, 124],
      event_time: 1736672905000
    },
    {
      kind: 'knowledge',
      title: '...',
      summary: '...',
      ...
    }
  ],
  edges: [
    { from_index: 0, to_index: 1, edge_type: 'derived_from' }
  ]
}
```

**数据落库**: `context_nodes` 表
```sql
INSERT INTO context_nodes (
  kind, threadId, originKey, title, summary, 
  keywords, entities, importance, confidence,
  eventTime, mergeStatus='pending', mergeAttempts=0
)
```

**关键字段**:
- `originKey`: 幂等性键,格式 `ctx_node:${batch.idempotencyKey}:ss:${screenshotIds}:${kind}:${ordinal}`
- `mergeStatus`: 初始为 `pending`,等待后续 merge 调度

**后续触发**:
1. 为每个新节点调用 `vectorDocumentService.upsertForContextNode(nodeId)` → 触发向量化
2. 只 upsert,不阻塞等待 embedding 完成

---

### 1.7 Context Node Merge

**处理器**: `screenshot-pipeline-scheduler.ts` → `handleSingleMerge()`

```typescript
// 步骤7: 合并同线程同类型节点
handleSingleMerge(nodeRecord)
  ├─ 加载节点数据 + 关联的截图
  ├─ 查找 merge 目标:
  │   └─ WHERE threadId = node.threadId
  │       AND kind = node.kind
  │       AND mergeStatus = 'succeeded'
  │       AND id != node.id
  │     ORDER BY eventTime DESC LIMIT 1
  ├─ 如果没有目标 → 标记自己为 'succeeded'
  ├─ 如果有目标:
  │   ├─ textLLMProcessor.executeMerge(newNode, existingNode)
  │   │   ├─ 调用 Text LLM merge API
  │   │   └─ 或使用启发式合并 (fallback)
  │   ├─ 合并逻辑:
  │   │   ├─ title/summary: 取更长或拼接
  │   │   ├─ keywords: 去重合并 (最多 10 个)
  │   │   ├─ entities: 去重合并,保留更高 confidence
  │   │   ├─ importance/confidence: 取最大值
  │   │   └─ screenshotIds: 合并去重
  │   ├─ 更新目标节点内容
  │   ├─ 将来源节点的截图链接到目标节点
  │   ├─ 标记来源节点 mergeStatus='succeeded'
  │   └─ 触发目标节点向量文档更新
  └─ 记录日志: 'Merged node {source} into {target}'
```

**输入**:
- `nodeRecord`: mergeStatus='pending' 的节点

**输出**:
- 更新目标节点 (或自己)
- 关联所有截图
- 更新 mergeStatus='succeeded'

**数据落库**:
1. 更新目标 node: title, summary, keywords, entities, mergedFromIds
2. 插入 `screenshot_links`: contextNodeId → screenshotId
3. 更新来源 node: mergeStatus='succeeded'
4. 插入/更新 `vector_documents`: embeddingStatus='pending'

---

## 二、Scheduler 调度机制详解

### 2.1 Scheduler 架构

`ScreenshotPipelineScheduler` 继承自 `BaseScheduler`,负责:
1. **Batch 处理**: VLM 分析 + Text LLM 扩展
2. **Context Node Merge**: 同线程节点合并

```typescript
class ScreenshotPipelineScheduler extends BaseScheduler {
  // 状态字段 (继承自 BaseScheduler)
  private isRunning: boolean      // 是否已启动
  private isProcessing: boolean   // 是否正在执行一轮 cycle
  private wakeRequested: boolean  // 是否有 wake 请求待处理
  private timer: NodeJS.Timeout   // 下一轮调度的定时器

  // 配置
  getBatchWorkerLimit(): number {
    const vlmLimit = aiRuntimeService.getLimit('vlm')
    return Math.ceil(vlmLimit / 2)  // 最多 1-4
  }

  getMergeWorkerLimit(): number {
    const textLimit = aiRuntimeService.getLimit('text')
    const reserved = 2  // 保留给 activity summary
    const batchWorkers = this.getBatchWorkerLimit()
    return Math.max(1, textLimit - reserved - batchWorkers)  // 最多 1-10
  }

  getScanLimit(): number {
    const total = getBatchWorkerLimit() + getMergeWorkerLimit()
    return Math.min(200, Math.max(20, total * 4))
  }
}
```

---

### 2.2 调度循环 (runCycle)

```typescript
// 核心调度循环
async runCycle() {
  if (!this.isRunning || this.isProcessing) return
  this.isProcessing = true

  try {
    // (1) 崩溃恢复: 把 running > staleThreshold 的任务回滚为 pending
    await recoverStaleStates()
      ├─ UPDATE batches SET status='pending' 
      │   WHERE status='running' AND updatedAt < (now - 5min)
      ├─ UPDATE screenshots SET vlmStatus='pending'
      │   WHERE vlmStatus='running' AND updatedAt < (now - 5min)
      └─ UPDATE context_nodes SET mergeStatus='pending'
          WHERE mergeStatus='running' AND updatedAt < (now - 5min)

    // (2) 扫描待处理任务
    records = await scanPendingRecords()
      ├─ 查询 batches: status IN ('pending','failed') 
      │   AND (nextRunAt IS NULL OR nextRunAt <= now)
      │   AND attempts < maxAttempts
      │ ORDER BY createdAt DESC/ASC LIMIT scanLimit/2  (取新旧各一半)
      └─ 查询 context_nodes: mergeStatus IN ('pending','failed')
          AND (mergeNextRunAt IS NULL OR mergeNextRunAt <= now)
          AND mergeAttempts < maxAttempts
        ORDER BY createdAt DESC/ASC LIMIT scanLimit/2

    // (3) 分流处理: batch 和 merge 并行
    batchRecords = records.filter(r => r.table === 'batches')
    otherRecords = records.filter(r => r.table !== 'batches')

    await Promise.all([
      processBatchesConcurrently(batchRecords),
      processMergeRecordsConcurrently(otherRecords)
    ])

    // (4) 孤儿截图入队 (防止遗漏)
    await enqueueOrphanScreenshots()
      └─ 查找: enqueuedBatchId IS NULL 
          AND createdAt < (now - batchTimeoutMs - 5s)
        → 创建新 batch

  } finally {
    this.isProcessing = false

    // (5) 决定下一次调度
    if (!this.isRunning) {
      // 已停止
    } else if (this.wakeRequested) {
      this.scheduleSoon()  // 立即再跑一轮
    } else {
      const nextRun = computeEarliestNextRun()
      this.scheduleNext(delayMs)  // 按计算延迟调度
    }
  }
}
```

---

### 2.3 重试与退避机制

#### 2.3.1 Claim (认领) 机制

```typescript
// 原子性认领任务 (防止并发冲突)
processBatchRecord(record) {
  const claim = db.update(batches)
    .set({ 
      status: 'running', 
      attempts: batchRecord.attempts + 1,
      updatedAt: now
    })
    .where(
      AND(
        eq(batches.id, batchRecord.id),
        OR(eq(batches.status, 'pending'), eq(batches.status, 'failed'))
      )
    )
    .run()

  if (claim.changes === 0) {
    return  // 被其他 worker 抢先认领,跳过
  }

  // 执行任务...
}
```

**关键点**:
- `UPDATE ... WHERE status IN ('pending','failed')` 保证原子性
- `claim.changes === 0` 表示竞争失败,安全跳过

#### 2.3.2 失败重试

```typescript
// 失败后的退避策略
catch (error) {
  const attempts = batchRecord.attempts + 1
  const isPermanent = attempts >= maxAttempts  // 默认 5 次

  const nextRunAt = isPermanent 
    ? null 
    : calculateNextRun(attempts)

  db.update(batches)
    .set({
      status: isPermanent ? 'failed_permanent' : 'failed',
      attempts,
      nextRunAt,
      errorMessage: error.message,
      updatedAt: now
    })
    .where(...)
}

// 退避计算
calculateNextRun(attempts) {
  const schedule = [5s, 15s, 60s, 300s, 600s]  // 指数退避
  const baseDelay = schedule[Math.min(attempts-1, schedule.length-1)]
  const jitter = Math.random() * 10000  // 随机抖动 0-10s
  return now + baseDelay + jitter
}
```

**退避时间表**:
| 尝试次数 | 基础延迟 | 抖动 | 实际延迟范围 |
|----------|---------|------|-------------|
| 1        | 5s      | 0-10s | 5-15s       |
| 2        | 15s     | 0-10s | 15-25s      |
| 3        | 60s     | 0-10s | 60-70s      |
| 4        | 300s    | 0-10s | 300-310s    |
| 5        | 600s    | 0-10s | 600-610s    |

**永久失败**: `attempts >= 5` → `status='failed_permanent'`, `nextRunAt=null`

#### 2.3.3 崩溃恢复

```typescript
// 每轮开始前执行
recoverStaleStates() {
  const staleThreshold = now - 5 * 60 * 1000  // 5分钟

  // 把长时间 running 的任务回滚
  db.update(batches)
    .set({ status: 'pending', nextRunAt: null })
    .where(
      AND(
        eq(batches.status, 'running'),
        lt(batches.updatedAt, staleThreshold)
      )
    )
}
```

**场景**: 
- 进程崩溃/重启
- 任务执行超时卡死

**恢复策略**:
- `running` 状态超过 5 分钟 → 回滚为 `pending`
- 清空 `nextRunAt`,允许立即重新调度

---

### 2.4 并发控制

#### 2.4.1 Lane 分流 (优先级)

```typescript
// 按任务年龄和重试次数分配到不同 lane
splitBatchesIntoLanes(records) {
  const realtime = []  // 实时任务
  const recovery = []  // 恢复任务

  for (const r of records) {
    if (r.attempts > 0) {
      recovery.push(r)  // 重试任务 → recovery
      continue
    }

    const age = now - r.createdAt
    if (age >= laneRecoveryAgeMs) {  // 默认 5分钟
      recovery.push(r)  // 积压任务 → recovery
    } else {
      realtime.push(r)  // 新鲜任务 → realtime
    }
  }

  return { realtime, recovery }
}
```

**Lane 权重**:
```typescript
processInLanes({
  lanes: { realtime, recovery },
  concurrency: 4,
  laneWeights: { realtime: 3, recovery: 1 }
})

// 实际分配: 
// - realtime lane: 3 workers
// - recovery lane: 1 worker
```

**目的**:
- **防止饥饿**: 保证旧任务也能推进
- **优先实时**: 大部分资源给新任务

#### 2.4.2 全局并发限制

```typescript
// VLM 并发: 由 AI Semaphore 控制
processShard(shard) {
  const release = await aiRuntimeService.acquire('vlm')
  try {
    await generateObject({ model: vlmClient, ... })
  } finally {
    release()
  }
}

// Text LLM 并发: 同样受 semaphore 控制
callTextLLMForExpansion() {
  const release = await aiRuntimeService.acquire('text')
  try {
    await generateObject({ model: textClient, ... })
  } finally {
    release()
  }
}
```

**Semaphore 限制** (来自 `aiRuntimeService`):
- `vlm`: 默认 4 个并发
- `text`: 默认 4 个并发

**调度层并发**:
- `batchWorkerLimit`: `ceil(vlmLimit / 2)` = 1-4
- `mergeWorkerLimit`: `textLimit - 2 - batchWorkers` = 1-10

**为什么 batch worker < vlm limit?**
- Batch 处理还包含 shard 内部并发
- 避免创建过多调度任务都卡在同一个 semaphore

---

### 2.5 动态调度时机

```typescript
// 计算下一次调度时间
computeEarliestNextRun() {
  const candidates = []

  // (1) 最早的 pending batch
  const batch = db.select({ nextRunAt: batches.nextRunAt })
    .from(batches)
    .where(status IN ('pending','failed') AND attempts < maxAttempts)
    .orderBy(asc(nextRunAt))
    .limit(1)
  if (batch) candidates.push(batch.nextRunAt ?? now)

  // (2) 最早的 pending merge
  const merge = db.select({ nextRunAt: contextNodes.mergeNextRunAt })
    .from(contextNodes)
    .where(mergeStatus IN ('pending','failed') AND mergeAttempts < maxAttempts)
    .orderBy(asc(mergeNextRunAt))
    .limit(1)
  if (merge) candidates.push(merge.nextRunAt ?? now)

  // (3) 最早的孤儿截图
  const orphan = db.select({ createdAt: screenshots.createdAt })
    .from(screenshots)
    .where(enqueuedBatchId IS NULL AND createdAt < cutoff)
    .orderBy(asc(createdAt))
    .limit(1)
  if (orphan) {
    const eligibleAt = orphan.createdAt + batchTimeoutMs + 5s
    candidates.push(eligibleAt)
  }

  return Math.max(Math.min(...candidates), now)
}

// 调度决策
scheduleNext() {
  const nextRun = computeEarliestNextRun()
  
  if (nextRun === null) {
    // 无任务: 使用默认轮询间隔 (60s)
    delayMs = 60000
  } else {
    delayMs = Math.max(0, nextRun - now)
  }

  this.timer = setTimeout(() => runCycle(), delayMs)
}
```

**调度策略**:
1. **有任务**: 按最早 `nextRunAt` 调度
2. **无任务**: 60 秒后轮询检查
3. **wake 请求**: 立即执行 (`delayMs=0`)

---

### 2.6 Wake 机制

```typescript
// 外部触发立即调度
wake() {
  if (!this.isRunning) return

  if (this.isProcessing) {
    // 正在处理中: 标记下次立即跑
    this.wakeRequested = true
    return
  }

  // 空闲: 立即调度
  this.scheduleSoon()  // setTimeout(..., 0)
}

// wake 调用时机:
// 1. batch:persisted 事件
// 2. 孤儿截图入队后
// 3. 其他业务逻辑触发
```

**防止重入**:
- 如果正在 `runCycle()`,设置 `wakeRequested` 标记
- `finally` 块检查标记,决定是否立即再跑

---

## 三、关键函数详解

### 3.1 `processBatchRecord(record)`

**职责**: 处理单个 batch (VLM + Text LLM)

**流程**:
```typescript
async processBatchRecord(record: PendingRecord) {
  // 1. 加载 batch 记录
  const batchRecord = db.select().from(batches).where(id = record.id)
  if (!batchRecord || batchRecord.status not in ('pending','failed')) return

  // 2. Claim 任务
  const claim = db.update(batches)
    .set({ status: 'running', attempts: attempts+1 })
    .where(id = record.id AND status in ('pending','failed'))
  if (claim.changes === 0) return  // 竞争失败

  // 3. 构建 batch 对象
  const screenshotRows = db.select().from(screenshots).where(id in screenshotIds)
  const batch: Batch = {
    batchId, sourceKey, screenshots: accepted[],
    historyPack: JSON.parse(batchRecord.historyPack)
  }

  // 4. 分片
  const shards = batchBuilder.splitIntoShards(batch)

  // 5. VLM 处理
  const vlmResult = await vlmProcessor.processBatch(batch, shards)
  if (!vlmResult.success) throw error

  // 6. Text LLM 扩展 + 持久化
  await persistVlmEvidenceAndFinalize(vlmResult.mergedResult, batch)
    ├─ 更新 screenshots: ocrText, uiTextSnippets, detectedEntities
    ├─ textLLMProcessor.expandToNodes(index, batch)
    │   ├─ 调用 Text LLM expansion
    │   ├─ 创建 context nodes
    │   └─ 返回 nodeIds[]
    └─ 为每个新节点: vectorDocumentService.upsertForContextNode(nodeId)

  // 7. 成功: 更新 batch 状态
  db.update(batches)
    .set({ status: 'succeeded', indexJson, errorMessage: null, nextRunAt: null })
    .where(id = batchRecord.id AND status = 'running')

  // 8. 失败: 退避重试
  catch (error) {
    const isPermanent = attempts >= maxAttempts
    const nextRun = isPermanent ? null : calculateNextRun(attempts)
    
    db.update(batches)
      .set({ 
        status: isPermanent ? 'failed_permanent' : 'failed',
        attempts,
        nextRunAt: nextRun,
        errorMessage: error.message
      })
      .where(id = batchRecord.id AND status = 'running')
  }
}
```

**输入**: `PendingRecord` (id, table='batches', status, attempts, nextRunAt)

**输出**: 
- 成功: `batch.status='succeeded'`, 创建 context nodes
- 失败: `batch.status='failed'` + `nextRunAt`

**耗时统计**:
- `vlmMs`: VLM 处理耗时
- `textLlmMs`: Text LLM + 持久化耗时
- `totalMs`: 总耗时

---

### 3.2 `processContextNodeMergeRecord(record)`

**职责**: 处理单个 context node 的 merge

**流程**:
```typescript
async processContextNodeMergeRecord(record: PendingRecord) {
  // 1. 加载节点
  const node = db.select().from(contextNodes).where(id = record.id)
  if (!node) return

  // 2. Claim
  const claim = db.update(contextNodes)
    .set({ mergeStatus: 'running', mergeAttempts: attempts+1 })
    .where(id = node.id AND mergeStatus in ('pending','failed'))
  if (claim.changes === 0) return

  // 3. 执行 merge
  try {
    await handleSingleMerge(node)
  } catch (error) {
    // 失败: 退避重试
    const isPermanent = attempts >= maxAttempts
    const nextRun = isPermanent ? null : calculateNextRun(attempts)
    
    db.update(contextNodes)
      .set({
        mergeStatus: isPermanent ? 'failed_permanent' : 'failed',
        mergeAttempts: attempts,
        mergeNextRunAt: nextRun,
        mergeErrorMessage: error.message
      })
      .where(id = node.id AND mergeStatus = 'running')
  }
}
```

---

### 3.3 `handleSingleMerge(nodeRecord)`

**职责**: 执行实际的节点合并逻辑

**流程**:
```typescript
async handleSingleMerge(nodeRecord: ContextNodeRecord) {
  // 1. 转换为 ExpandedContextNode
  const node: ExpandedContextNode = {
    id, kind, threadId, title, summary,
    keywords: JSON.parse(keywords),
    entities: JSON.parse(entities),
    screenshotIds: contextGraphService.getLinkedScreenshots(id),
    ...
  }

  // 2. 无 threadId → 直接成功 (无法找到 merge 目标)
  if (!node.threadId) {
    await contextGraphService.updateNode(id, { mergeStatus: 'succeeded' })
    return
  }

  // 3. 查找 merge 目标
  const targetRecord = db.select().from(contextNodes)
    .where(
      threadId = node.threadId
      AND kind = node.kind
      AND mergeStatus = 'succeeded'
      AND id != node.id
    )
    .orderBy(desc(eventTime))
    .limit(1)

  // 4. 无目标 → 直接成功 (首个节点)
  if (!targetRecord) {
    await contextGraphService.updateNode(id, { mergeStatus: 'succeeded' })
    return
  }

  // 5. 执行 LLM merge
  const target: ExpandedContextNode = { ... }
  const mergeResult = await textLLMProcessor.executeMerge(node, target)

  // 6. 更新目标节点
  await contextGraphService.updateNode(targetRecord.id, {
    title: mergeResult.mergedNode.title,
    summary: mergeResult.mergedNode.summary,
    keywords: mergeResult.mergedNode.keywords,
    entities: mergeResult.mergedNode.entities,
    importance: mergeResult.mergedNode.importance,
    confidence: mergeResult.mergedNode.confidence,
    mergedFromIds: mergeResult.mergedFromIds
  })

  // 7. 关联截图到目标节点
  for (const screenshotId of node.screenshotIds) {
    await contextGraphService.linkScreenshot(targetRecord.id, screenshotId)
  }

  // 8. 标记来源节点成功
  await contextGraphService.updateNode(node.id, { mergeStatus: 'succeeded' })

  // 9. 触发目标节点向量更新
  await vectorDocumentService.upsertForContextNode(targetRecord.id)
}
```

**Merge 逻辑** (在 `textLLMProcessor.executeMerge`):
```typescript
executeMerge(newNode, existingNode) {
  // 1. 启发式合并
  const mergedNode = {
    kind: existingNode.kind,
    threadId: existingNode.threadId,
    title: mergeText(existingNode.title, newNode.title, 100),
    summary: mergeText(existingNode.summary, newNode.summary, 200),
    keywords: mergeKeywords(existing, new, 10),
    entities: mergeEntities(existing, new),
    importance: max(existing, new),
    confidence: max(existing, new),
    screenshotIds: [...existing, ...new].unique(),
    mergedFromIds: [...existing, ...new.mergedFromIds].unique()
  }

  // 2. 尝试 LLM merge (可选增强)
  try {
    const llmMerged = await callTextLLMForMerge(existingNode, newNode)
    mergedNode.title = llmMerged.title
    mergedNode.summary = llmMerged.summary
    mergedNode.keywords = mergeKeywords(llmMerged.keywords, mergedNode.keywords, 10)
    mergedNode.entities = mergeEntities(llmMerged.entities, mergedNode.entities)
  } catch {
    // LLM 失败: 使用启发式结果
  }

  return { mergedNode, mergedFromIds }
}
```

---

### 3.4 `enqueueOrphanScreenshots()`

**职责**: 找到遗漏的截图,创建 batch

**场景**:
- 截图已入库但未加入 buffer (系统重启/异常)
- Buffer 超时前未达到 batchSize

**流程**:
```typescript
async enqueueOrphanScreenshots() {
  const now = Date.now()
  const minAge = batchTimeoutMs + 5s  // 30s + 5s = 35s
  const cutoffCreatedAt = now - minAge

  // 1. 先检查现有 batch,补足其 enqueuedBatchId
  const existingBatches = db.select({ id, screenshotIds })
    .from(batches)
    .where(status in ('pending','failed','running') AND attempts < maxAttempts)
    .orderBy(desc(updatedAt))
    .limit(scanLimit)

  for (const batch of existingBatches) {
    const ids = JSON.parse(batch.screenshotIds)
    db.update(screenshots)
      .set({ enqueuedBatchId: batch.id })
      .where(id in ids AND enqueuedBatchId IS NULL)
  }

  // 2. 查找孤儿截图
  const orphans = db.select()
    .from(screenshots)
    .where(
      enqueuedBatchId IS NULL
      AND vlmStatus in ('pending','failed')
      AND vlmAttempts < maxAttempts
      AND createdAt <= cutoffCreatedAt
      AND filePath IS NOT NULL
      AND storageState != 'deleted'
    )
    .orderBy(asc(sourceKey), asc(ts))
    .limit(scanLimit)

  if (orphans.length === 0) return

  // 3. 按 sourceKey 分组
  const bySource = new Map<SourceKey, typeof orphans>()
  for (const row of orphans) {
    bySource.get(row.sourceKey) ?? bySource.set(row.sourceKey, [])
    bySource.get(row.sourceKey)!.push(row)
  }

  // 4. 为每个 sourceKey 创建 batch (按 batchSize 分块)
  for (const [sourceKey, rows] of bySource) {
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize)
      const accepted: AcceptedScreenshot[] = chunk.map(s => ({
        id: s.id, ts: s.ts, sourceKey, phash: s.phash,
        filePath: s.filePath!, meta: { ... }
      }))

      await batchBuilder.createAndPersistBatch(sourceKey, accepted)
      createdBatches++
    }
  }

  // 5. 如果创建了新 batch,唤醒 scheduler
  if (createdBatches > 0) {
    this.wakeRequested = true
  }
}
```

**触发时机**:
- 每轮 `runCycle()` 最后执行
- 保证没有截图被遗漏

---

## 四、数据库状态机

### 4.1 Batch 状态流转

```
pending  ──(claim)──→  running  ──(success)──→  succeeded
   ↑                      │                         ✓
   │                      │
   └─────(retry)──────────┘
                   (failure, attempts < max)

                          │
                          └─────(failure, attempts >= max)────→  failed_permanent
                                                                       ✗
```

**字段**:
- `status`: 'pending' | 'failed' | 'running' | 'succeeded' | 'failed_permanent'
- `attempts`: 重试次数 (0-5)
- `nextRunAt`: 下次运行时间 (失败后设置)
- `errorMessage`: 错误信息
- `updatedAt`: 更新时间 (用于崩溃恢复)

---

### 4.2 Context Node Merge 状态流转

```
pending  ──(claim)──→  running  ──(success)──→  succeeded
   ↑                      │                         ✓
   │                      │
   └─────(retry)──────────┘
                   (failure, mergeAttempts < max)

                          │
                          └─────(failure, mergeAttempts >= max)────→  failed_permanent
                                                                            ✗
```

**字段**:
- `mergeStatus`: 'pending' | 'failed' | 'running' | 'succeeded' | 'failed_permanent'
- `mergeAttempts`: 重试次数 (0-5)
- `mergeNextRunAt`: 下次运行时间
- `mergeErrorMessage`: 错误信息

---

### 4.3 Screenshot VLM 状态流转

```
pending  ──(batch claim)──→  running  ──(success)──→  succeeded
   ↑                            │                          ✓
   │                            │
   └─────(retry)────────────────┘
                         (batch failure)

                                │
                                └─────(failure, vlmAttempts >= max)────→  failed_permanent
                                                                               ✗
```

**字段**:
- `vlmStatus`: 'pending' | 'failed' | 'running' | 'succeeded' | 'failed_permanent'
- `vlmAttempts`: 重试次数
- `vlmNextRunAt`: 下次运行时间
- `enqueuedBatchId`: 关联的 batch ID

---

## 五、性能优化策略

### 5.1 扫描优化

```typescript
// 取新旧各一半,保证公平性
scanPendingRecords() {
  const sliceLimit = Math.ceil(scanLimit / 2)

  // 最新的 pending records
  const newest = db.select()
    .from(batches)
    .where(status in ('pending','failed') AND nextRunAt <= now)
    .orderBy(desc(createdAt))
    .limit(sliceLimit)

  // 最老的 pending records
  const oldest = db.select()
    .from(batches)
    .where(status in ('pending','failed') AND nextRunAt <= now)
    .orderBy(asc(createdAt))
    .limit(sliceLimit)

  // 去重合并
  return mergeUniqueById([...newest, ...oldest])
}
```

**目的**:
- **防止新任务饥饿**: 保证新任务快速响应
- **防止旧任务积压**: 保证积压任务也能推进

---

### 5.2 并发分流

```typescript
// Lane-based 并发控制
processInLanes({
  lanes: { realtime: [...], recovery: [...] },
  concurrency: 4,
  laneWeights: { realtime: 3, recovery: 1 },
  handler: async (record) => { ... }
})

// 实现:
// 1. 按权重分配 worker: realtime=3, recovery=1
// 2. 每个 lane 独立队列,循环取任务
// 3. 使用 Promise.all + worker pool 模式
```

**效果**:
- 75% 资源给实时任务
- 25% 资源给恢复任务
- 避免 head-of-line blocking

---

### 5.3 Semaphore 分级

```typescript
// 全局 AI 并发控制
aiRuntimeService
  ├─ vlm semaphore: limit=4
  └─ text semaphore: limit=4

// 调度层并发控制
ScreenshotPipelineScheduler
  ├─ batchWorkerLimit: ceil(vlmLimit/2) = 2
  └─ mergeWorkerLimit: textLimit - 2 - batchWorkers = 0

// Shard 内部并发
vlmProcessor.processShardsConcurrently()
  └─ workerCount: min(vlmLimit, shards.length)
```

**分层目的**:
1. **全局限制**: 保护 API rate limit
2. **调度限制**: 避免任务队列过深
3. **Shard 限制**: 批量处理内部并发

---

### 5.4 动态调度

```typescript
// 根据任务状态动态调度
computeEarliestNextRun() {
  const nextBatch = min(batches.nextRunAt where status='pending')
  const nextMerge = min(contextNodes.mergeNextRunAt where mergeStatus='pending')
  const nextOrphan = min(screenshots.createdAt where enqueuedBatchId IS NULL) + timeout

  return min(nextBatch, nextMerge, nextOrphan, now)
}

// 精确调度: 有任务就按时间调度,无任务 60s 轮询
delayMs = max(0, earliestNextRun - now) || 60000
```

**优点**:
- 减少无意义的空轮询
- 任务到期时精确调度
- 节省 CPU 资源

---

## 六、错误处理与容错

### 6.1 崩溃恢复

```typescript
// 每轮开始前恢复 stale 状态
recoverStaleStates() {
  const threshold = now - 5min

  // 1. Batches
  UPDATE batches 
  SET status='pending', nextRunAt=null, updatedAt=now
  WHERE status='running' AND updatedAt < threshold

  // 2. Screenshots
  UPDATE screenshots
  SET vlmStatus='pending', vlmNextRunAt=null, updatedAt=now
  WHERE vlmStatus='running' AND updatedAt < threshold

  // 3. Context Nodes
  UPDATE context_nodes
  SET mergeStatus='pending', updatedAt=now
  WHERE mergeStatus='running' AND updatedAt < threshold
}
```

**保证**:
- 进程崩溃后,重启自动恢复
- `updatedAt` 作为心跳检测

---

### 6.2 部分失败容错

```typescript
// Batch 处理: shard 部分失败 → 整个 batch 失败
processBatch(batch, shards) {
  const shardResults = await processShardsConcurrently(shards)
  
  if (!allSucceeded(shardResults)) {
    await updateScreenshotStatuses(batch, 'failed')
    return { success: false, error: '...' }
  }

  // 所有 shard 成功才合并
  const merged = mergeShardResults(shardResults.map(r => r.result))
  await updateScreenshotStatuses(batch, 'succeeded')
  return { success: true, mergedResult: merged }
}
```

**策略**: 
- Shard 并发处理
- 只要有一个失败,整个 batch 失败重试
- 保证数据一致性

```typescript
// Text LLM expansion 失败: fallback 到直接转换
try {
  pendingNodes = convertTextLLMExpandResultToPendingNodes(
    await callTextLLMForExpansion(...)
  )
} catch (error) {
  // Fallback: 直接转换 VLM segments
  pendingNodes = convertSegmentsToPendingNodes(vlmIndex, batch, evidencePacks)
}
```

**策略**:
- LLM 调用失败不阻塞整个流程
- 使用简化逻辑保底

---

### 6.3 幂等性保证

```typescript
// Batch 幂等性: idempotencyKey
idempotencyKey = `vlm_batch:${sourceKey}:${tsStart}-${tsEnd}:${hash}`

try {
  db.insert(batches).values({ ..., idempotencyKey })
} catch (UniqueConstraintError) {
  // 重复插入: 查询已存在的 batch
  const existing = db.select({ id }).from(batches)
    .where(eq(batches.idempotencyKey, idempotencyKey))
  return existing.id
}
```

```typescript
// Context Node 幂等性: originKey
originKey = `ctx_node:${batch.idempotencyKey}:ss:${screenshotIds}:${kind}:${ordinal}`

contextGraphService.createNode({
  originKey,  // UNIQUE constraint
  ...
})
// 重复调用 → DB 返回已存在节点
```

**保证**:
- 重试不会重复创建数据
- 支持安全的多次调用

---

## 七、监控与可观测性

### 7.1 事件总线

```typescript
// 关键事件发出
screenshotProcessingEventBus.emit('pipeline:batch:started', {
  type: 'pipeline:batch:started',
  timestamp: now,
  batchDbId, batchId, sourceKey,
  attempts, screenshotCount
})

screenshotProcessingEventBus.emit('pipeline:batch:finished', {
  type: 'pipeline:batch:finished',
  timestamp: now,
  batchDbId, batchId, sourceKey,
  status: 'succeeded' | 'failed' | 'failed_permanent',
  attempts,
  totalMs, vlmMs, textLlmMs,
  errorMessage?
})
```

**订阅点**:
- Activity Monitor
- 调试面板
- 日志收集

---

### 7.2 耗时统计

```typescript
processBatchRecord() {
  const processStartTime = Date.now()
  let vlmMs = 0
  let textLlmMs = 0

  try {
    const vlmStartTime = Date.now()
    const vlmResult = await vlmProcessor.processBatch(...)
    vlmMs = Date.now() - vlmStartTime

    const textLlmStartTime = Date.now()
    await persistVlmEvidenceAndFinalize(...)
    textLlmMs = Date.now() - textLlmStartTime

    const totalMs = Date.now() - processStartTime
    
    logger.info({ batchId, totalMs, vlmMs, textLlmMs }, 'Batch completed')
  }
}
```

**指标**:
- `totalMs`: 总耗时
- `vlmMs`: VLM 处理耗时
- `textLlmMs`: Text LLM + 持久化耗时

---

### 7.3 AI 请求追踪

```typescript
// VLM 请求记录
aiRequestTraceBuffer.record({
  ts: Date.now(),
  capability: 'vlm',
  operation: 'vlm_analyze_shard',
  model: 'gpt-4o',
  durationMs,
  status: 'succeeded' | 'failed',
  responsePreview: JSON.stringify(result),
  images: ['data:image/jpeg;base64,...']
})

// Text LLM 请求记录
aiRequestTraceBuffer.record({
  ts: Date.now(),
  capability: 'text',
  operation: 'text_expand' | 'text_merge',
  model: 'gpt-4o-mini',
  durationMs,
  status: 'succeeded' | 'failed',
  responsePreview: JSON.stringify(result),
  errorPreview?: string
})
```

**用途**:
- AI Monitor 面板展示
- 调试 LLM 输出质量
- 监控 API 调用失败率

---

## 八、配置参数总结

| 参数 | 默认值 | 说明 | 位置 |
|------|--------|------|------|
| batchSize | 5 | 每批截图数量 | processingConfig.batch.batchSize |
| batchTimeoutMs | 30000 | 批次超时 (30s) | processingConfig.batch.batchTimeoutMs |
| vlmShardSize | 5 | 每个 shard 截图数 | processingConfig.vlm.vlmShardSize |
| vlmGlobalConcurrency | 4 | VLM 全局并发 | aiRuntimeService.getLimit('vlm') |
| textGlobalConcurrency | 4 | Text LLM 全局并发 | aiRuntimeService.getLimit('text') |
| batchWorkerLimit | 1-4 | Batch 调度并发 | ceil(vlmLimit/2) |
| mergeWorkerLimit | 1-10 | Merge 调度并发 | textLimit - 2 - batchWorkers |
| scanLimit | 20-200 | 每轮扫描上限 | (batchWorkers + mergeWorkers) * 4 |
| maxAttempts | 5 | 最大重试次数 | processingConfig.scheduler.retryConfig.maxAttempts |
| backoffSchedule | [5s,15s,60s,300s,600s] | 退避时间表 | processingConfig.scheduler.retryConfig.backoffScheduleMs |
| jitterMs | 10000 | 随机抖动 (10s) | processingConfig.scheduler.retryConfig.jitterMs |
| staleRunningThresholdMs | 300000 | 崩溃检测阈值 (5min) | processingConfig.scheduler.staleRunningThresholdMs |
| scanIntervalMs | 60000 | 空闲轮询间隔 (60s) | processingConfig.scheduler.scanIntervalMs |
| laneRecoveryAgeMs | 300000 | Recovery lane 年龄阈值 (5min) | processingConfig.scheduler.laneRecoveryAgeMs |

---

## 九、常见问题

### Q1: 为什么 batch 失败后截图也要更新状态?

**A**: 
- Batch 是截图的容器,batch 失败意味着所有截图都需要重新处理
- 更新 `screenshots.vlmStatus='failed'` 允许后续重新入队
- 避免截图永久卡在 `running` 状态

### Q2: 孤儿截图是如何产生的?

**A**:
1. Buffer 超时前进程重启 → buffer 丢失,截图已入库
2. Buffer 异常清理 → 截图未及时入队
3. Batch 创建异常 → 部分截图遗漏

**解决**: `enqueueOrphanScreenshots()` 定期扫描补救

### Q3: 为什么需要 崩溃恢复 (stale state recovery)?

**A**:
- 进程崩溃时,`running` 任务没有机会更新为 `failed`
- 重启后这些任务永久卡在 `running`,不会被重新调度
- `recoverStaleStates()` 定期检查 `updatedAt`,超时回滚

### Q4: Lane 分流的作用?

**A**:
- **防止饥饿**: 保证旧任务不被完全阻塞
- **优先实时**: 75% 资源给新任务,保证用户体验
- **公平调度**: 新旧任务都能推进

### Q5: 为什么 Text LLM expansion 失败不阻塞流程?

**A**:
- VLM 输出已经包含基础语义信息
- Text LLM 只是"增强",不是必需
- Fallback 到直接转换保证数据完整性

---

## 总结

`ScreenshotPipelineScheduler` 是一个**健壮、可恢复、高并发**的任务调度器,通过:

1. **原子认领**: 防止并发冲突
2. **退避重试**: 失败自动恢复
3. **崩溃恢复**: 进程重启后继续
4. **Lane 分流**: 公平调度新旧任务
5. **动态调度**: 精确按时间触发
6. **幂等性**: 支持安全重试
7. **分层并发**: 保护 API 稳定性
8. **部分容错**: 关键路径有 fallback

实现了从截图到语义节点的**完整、可靠、高效**处理流程。
