# Screenshot Processing 架构文档索引

> 本目录包含截图处理流水线的完整架构分析和可视化说明

---

## 📚 文档结构

### 1. 技术分析文档
**文件**: `screenshot-pipeline-scheduler-analysis.md`

**适合读者**: 开发人员、架构师

**内容**:
- ✅ 完整数据流程（7个阶段详解）
- ✅ Scheduler调度机制（runCycle、重试、并发）
- ✅ 关键函数详解（processBatchRecord、handleSingleMerge等）
- ✅ 数据库状态机（Batch、Screenshot、ContextNode）
- ✅ 性能优化策略（扫描、并发、调度）
- ✅ 错误处理与容错机制
- ✅ 配置参数总结

**代码覆盖**:
- `screenshot-pipeline-scheduler.ts` (1312行,全部分析)
- `source-buffer-registry.ts` (494行)
- `batch-builder.ts` (541行)
- `vlm-processor.ts` (834行)
- `text-llm-processor.ts` (1201行)
- `screenshot-processing-module.ts` (277行)

---

### 2. 可视化图解说明
**文件**: `screenshot-pipeline-visual-guide.md`

**适合读者**: 产品经理、新人、非技术人员

**内容**:
- 🎨 通俗易懂的流程解释（用比喻和实例）
- 🎨 完整数据流概览（配图）
- 🎨 每个阶段的输入输出示例
- 🎨 调度器工作原理漫画图解
- 🎨 数据库状态流转图
- 🎨 常见问题解答

**配套图解**:
1. **scheduler_mechanism_comic.png** - 调度器工作机制（漫画风格）
2. **data_transformation_flow.png** - 数据转换流程（卡片式）
3. **database_state_machine.png** - 状态机流转图

---

## 🎯 快速导航

### 按需求查找

**我想了解...**

| 需求 | 推荐文档 | 章节 |
|------|---------|------|
| 截图怎么变成知识图谱的？ | visual-guide.md | 二、数据流详解 |
| 调度器如何工作？ | visual-guide.md | 三、调度器工作原理 |
| 重试机制的实现？ | analysis.md | 二.2.3 重试与退避机制 |
| 崩溃后如何恢复？ | analysis.md | 二.2.3.3 崩溃恢复 |
| 并发是如何控制的？ | analysis.md | 二.2.4 并发控制 |
| VLM处理的详细流程？ | analysis.md | 一.1.5 Shards → VLM处理 |
| Text LLM扩展逻辑？ | analysis.md | 一.1.6 VLM Index → Text LLM Expansion |
| 节点合并的策略？ | analysis.md | 一.1.7 Context Node Merge |
| 数据库字段含义？ | analysis.md | 四、数据库状态机 |
| 为什么这样设计？ | visual-guide.md | 七、常见问题解答 |

---

## 🔍 核心概念速查

### 关键类和文件

| 类/文件 | 职责 | 代码行数 |
|---------|------|---------|
| `ScreenshotPipelineScheduler` | 核心调度器，管理batch和merge任务 | 1312 |
| `SourceBufferRegistry` | 临时仓库，收集截图并触发batch | 494 |
| `BatchBuilder` | 创建batch、构建historyPack、分片 | 541 |
| `VLMProcessor` | 调用视觉模型分析截图 | 834 |
| `TextLLMProcessor` | 扩展VLM结果为语义节点 | 1201 |
| `ScreenshotProcessingModule` | 模块入口，连接各组件 | 277 |

### 关键流程

```
1. 截图完成 (onCaptureComplete)
     ↓
2. 加入Buffer (sourceBufferRegistry.add)
     ↓
3. 触发Batch (batch:ready event)
     ↓
4. 持久化Batch (batchBuilder.createAndPersistBatch)
     ↓
5. 调度器处理 (screenshotPipelineScheduler.processBatchRecord)
     ↓
6. VLM分析 (vlmProcessor.processBatch)
     ↓
7. Text扩展 (textLLMProcessor.expandToNodes)
     ↓
8. 节点合并 (screenshotPipelineScheduler.handleSingleMerge)
     ↓
9. 知识图谱更新
```

### 数据库表

| 表名 | 用途 | 关键字段 |
|------|------|---------|
| `screenshots` | 存储截图元数据 | vlmStatus, enqueuedBatchId, ocrText |
| `batches` | 批次任务 | status, attempts, nextRunAt, historyPack |
| `context_nodes` | 语义节点 | mergeStatus, mergeAttempts, threadId, kind |
| `screenshot_links` | 节点↔截图关联 | contextNodeId, screenshotId |
| `vector_documents` | 向量化数据 | embeddingStatus, indexStatus |

### 状态值

**Batch/Screenshot状态**:
- `pending`: 等待处理
- `running`: 正在处理
- `succeeded`: 处理成功
- `failed`: 失败（可重试）
- `failed_permanent`: 永久失败（达到最大重试次数）

**Context Node合并状态**:
- `pending`: 等待合并
- `running`: 正在合并
- `succeeded`: 合并完成
- `failed`: 合并失败（可重试）
- `failed_permanent`: 永久失败

---

## 📊 关键指标

### 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| batchSize | 5 | 每批截图数量 |
| batchTimeoutMs | 30000 | 批次超时(30秒) |
| vlmShardSize | 5 | 每个shard截图数 |
| maxAttempts | 5 | 最大重试次数 |
| staleRunningThresholdMs | 300000 | 崩溃检测阈值(5分钟) |
| vlmGlobalConcurrency | 4 | VLM全局并发 |
| textGlobalConcurrency | 4 | Text LLM全局并发 |

### 性能数据

**典型耗时**（5张截图的batch）:
- VLM处理: ~30秒
- Text LLM扩展: ~10秒
- 节点合并: ~5秒
- **总计**: ~45秒

**并发能力**:
- 最多同时处理 4个VLM请求
- 最多同时处理 4个Text LLM请求
- Batch worker: 1-4个
- Merge worker: 1-10个

---

## 🎨 图解说明

### 1. Scheduler机制漫画

![Scheduler Mechanism](./scheduler_mechanism_comic_*.png)

展示调度器的4个核心能力：
- **Crash Recovery**: 卡死任务复活
- **Retry with Backoff**: 失败重试策略
- **Concurrent Processing**: Lane分流并发
- **Dynamic Scheduling**: 智能休眠唤醒

### 2. 数据转换流程

![Data Transformation](./data_transformation_flow_*.png)

展示5个阶段的数据变化：
1. Screenshot Captured → 原始metadata
2. Batch Created → 组织+历史包
3. VLM Analysis → 结构化理解
4. Text Expansion → 语义节点
5. Context Node → 图谱入库

### 3. 状态机流转

![State Machine](./database_state_machine_*.png)

展示3种状态机：
- Batch States: pending → running → succeeded
- Screenshot States: 跟随batch状态
- Context Node Merge: pending → running → succeeded

---

## 🔧 开发指南

### 调试技巧

**1. 查看当前处理状态**
```sql
-- 检查pending的batch
SELECT id, batchId, status, attempts, nextRunAt 
FROM batches 
WHERE status IN ('pending', 'failed', 'running')
ORDER BY createdAt DESC;

-- 检查pending的merge
SELECT id, kind, threadId, mergeStatus, mergeAttempts, mergeNextRunAt
FROM context_nodes
WHERE mergeStatus IN ('pending', 'failed', 'running')
ORDER BY createdAt DESC;
```

**2. 查看失败原因**
```sql
-- Batch失败信息
SELECT batchId, attempts, errorMessage, updatedAt
FROM batches
WHERE status = 'failed_permanent';

-- Merge失败信息  
SELECT id, title, mergeAttempts, mergeErrorMessage, updatedAt
FROM context_nodes
WHERE mergeStatus = 'failed_permanent';
```

**3. 手动重置任务**
```sql
-- 重置failed_permanent batch（慎用！）
UPDATE batches
SET status='pending', attempts=0, nextRunAt=NULL, errorMessage=NULL
WHERE id = <batch_id>;

-- 重置failed_permanent merge
UPDATE context_nodes
SET mergeStatus='pending', mergeAttempts=0, mergeNextRunAt=NULL, mergeErrorMessage=NULL
WHERE id = <node_id>;
```

### 监控要点

**日志关键字**:
- `"Starting batch processing"` - batch开始
- `"Batch processing completed successfully"` - batch成功
- `"Batch processing failed"` - batch失败
- `"Merged node into target"` - merge成功
- `"Recovered stale states"` - 崩溃恢复

**事件监听**:
```typescript
screenshotProcessingEventBus.on('pipeline:batch:started', ...)
screenshotProcessingEventBus.on('pipeline:batch:finished', ...)
```

---

## 📖 扩展阅读

### 相关模块

- **Vector Document Scheduler**: 向量化和索引调度（独立调度器）
- **Activity Timeline Scheduler**: 活动摘要生成调度
- **Context Graph Service**: 知识图谱CRUD操作
- **Entity Service**: 实体识别和管理

### 设计模式

1. **状态机模式**: 任务状态流转
2. **生产者-消费者**: Buffer → Batch → Scheduler
3. **策略模式**: VLM分析 + Text扩展 + 启发式merge
4. **观察者模式**: 事件总线(EventBus)
5. **幂等性设计**: originKey保证重复调用安全

### 参考文档

- AI SDK文档: `ai` package (generateObject)
- Drizzle ORM: 数据库操作
- BaseScheduler: 调度器基类

---

## ✅ 检查清单

### 阅读理解检查

完成学习后，你应该能够回答：

- [ ] 截图从采集到知识图谱经历了哪7个阶段？
- [ ] SourceBufferRegistry在什么条件下触发batch？
- [ ] VLM和Text LLM分别负责什么？
- [ ] 调度器如何处理失败重试？
- [ ] 崩溃恢复的原理是什么？
- [ ] Lane分流的目的和权重分配？
- [ ] 为什么要合并Context Node？
- [ ] 幂等性是如何保证的？
- [ ] Semaphore限流的作用？
- [ ] 孤儿截图如何产生和处理？

### 代码导航检查

能够快速找到：

- [ ] 截图入库的代码位置
- [ ] Batch持久化的实现
- [ ] VLM调用的代码
- [ ] Text LLM扩展的逻辑
- [ ] 节点合并的策略
- [ ] 重试退避的计算
- [ ] 崩溃恢复的SQL
- [ ] 并发控制的实现

---

## 🤝 贡献

如有疑问或发现文档错误，请：
1. 检查代码是否更新（文档基于2026-01-12版本）
2. 查看相关日志确认实际行为
3. 提出issue或更新文档

---

**最后更新**: 2026-01-12  
**文档版本**: 1.0  
**代码覆盖**: screenshot-processing module (完整)
