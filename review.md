我会按两条线来 review：

1. 先对照 `screenshot-process-v2.md` 里“Context Graph/上下文图”的设计目标与数据流，检查 `context-graph-service.ts` 是否实现一致（输入、输出、存储、触发时机、边/节点结构、去重策略等）。
2. 再从工程质量角度看：API 面（public 方法数量/职责）、性能（N+1 查询、重复计算、索引利用）、类型/schema 是否重复定义、可复用抽象是否抽到 shared/schema 层。

我先把这两个文件读出来，然后给你结论和可执行的重构建议（如需要我也可以直接提 patch）。

## 1) 是否符合 [screenshot-process-v2.md](cci:7://file:///c:/frank-repos/Mnemora/screenshot-process-v2.md:0:0-0:0)

整体结论：**“数据表模型/字段层面基本对齐”，但“文档里强调的连续性（thread/segment/event_next）与证据边（derived_from_screenshot）在这个 service 里没有落全”。**  
更准确地说：[ContextGraphService](cci:2://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:107:0-616:1) 当前更像一个 **CRUD/查询层（repository）**，不是文档里“Context Graph 业务编排”的完整实现。

### 已对齐/实现得比较符合的点

- **ContextKind 与 EdgeType**：使用了 [schema.ts](cci:7://file:///c:/frank-repos/Mnemora/electron/database/schema.ts:0:0-0:0) 里的 `ContextKind/EdgeType`，kind 列表与文档 5.1.1 一致（`event/knowledge/state_snapshot/procedure/plan/entity_profile`）。
- **派生节点必须能追溯 event**（文档 5.3）：
  - 你实现了 CP-8：当创建 `knowledge/state_snapshot/procedure/plan` 且传入 `sourceEventId` 时，自动写入对应的 `event_*` 边（`event_produces_knowledge` 等）。
- **embedding_status 初始化**（文档 6.2 / 7.3）：
  - CP-9：创建 node 时强制 `embeddingStatus="pending"`，也符合“reconcile loop 扫 pending”这种状态机模型。
- **截图证据可回溯**（文档 4.6 / 5.3）：
  - 通过 `context_screenshot_links` 表把 node 与 screenshot 关联起来，能满足“可追溯 screenshot 证据”。

### 与文档存在差距/未覆盖的点（重点）

- **文档要求的连续性一等公民（thread/segment/edge）没有在这里体现出来**
  - service 里只有 `threadId` 字段的读写（[createNode](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:108:2-173:3) 可写入、[getThread](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:320:2-338:3) 可按 thread 取 event）。
  - **没有 segment_id 概念**（schema 也没有），文档 3.1/4.4 强调 segment 的分段与拼接，这部分不在此处实现。
  - **没有自动维护 `event_next`**：文档 5.1.2 把 `event_next` 作为关键边，但 service 并不会在创建 event 时自动连 `event_next`（这可能在上层编排做也可以，但目前 repo 内我没看到调用点）。
- **`derived_from_screenshot` EdgeType 在 schema 里存在，但该 service 从不创建这种 edge**
  - 你用的是 `context_screenshot_links` 表，而不是 `context_edges` 的 `derived_from_screenshot`。
  - 这不是“错”，但属于**实现路线与文档描述不一致**：文档写的是 edge（5.1.2），代码做的是 link table（schema 也确实建了 link table）。
  - 建议二选一统一：
    - **方案 A（推荐）**：保留 link table，把 `derived_from_screenshot` 从 `EDGE_TYPE_VALUES` 移除，避免“存在但无人使用”的概念漂浮。
    - **方案 B**：保留 edgeType，但在 [linkScreenshot](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:277:2-318:3) 同步创建一条 `derived_from_screenshot` edge（缺点：会引入截图作为 node 的建模或需要另一种表示，不太自然）。
- **文档的硬性规则**：“所有 derived 节点必须至少有一条边指回 event”
  - 当前代码只是在 _提供 sourceEventId 时_ 才自动建边，**并没有强制** derived kind 必须带 `sourceEventId`。所以依然可能产生“孤儿 knowledge/state/procedure/plan”。

---

## 2) 代码是否简洁高效（public 方法尽量少）？是否重复定义类型/schema？

### 2.1 API 面（public 方法数量/职责）

当前 [ContextGraphService](cci:2://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:107:0-616:1) 对外暴露的方法偏多（约 12+ 个）：

- 写入类：[createNode](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:108:2-173:3) / [updateNode](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:175:2-230:3) / [createEdge](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:232:2-275:3) / [linkScreenshot](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:277:2-318:3)
- 查询类：[getThread](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:320:2-338:3) / [getNode](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:340:2-357:3) / [getNodesByIds](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:484:2-499:3) / [getLinkedScreenshots](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:501:2-522:3) / [getEdgesFrom](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:524:2-549:3) / [getEdgesTo](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:551:2-576:3) / [getPendingEmbeddingNodes](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:578:2-593:3) / [traverse](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:359:2-482:3)
- 转换类：[recordToExpandedNode](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:595:2-615:3)

从 repo 搜索结果看：**除了测试，目前没有任何生产代码调用 `contextGraphService.*`**（仅从 [index.ts](cci:7://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/index.ts:0:0-0:0) export 出去）。这意味着：

- **它现在像是“准备给未来用”的通用 service**，但对齐文档的“最小闭环”其实只需要少数方法。
- 如果你的目标是“public 方法尽量少”，建议把它改成更明确的边界：
  - **对外（public）**：只保留真正被 orchestration 层需要的少数方法（例如 [createNode](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:108:2-173:3)、[updateNode](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:175:2-230:3)、[createEdge](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:232:2-275:3)、[linkScreenshot](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:277:2-318:3)、[traverse](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:359:2-482:3)、[getPendingEmbeddingNodes](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:578:2-593:3)）。
  - **其余**（如 `getEdgesFrom/getEdgesTo/getNodesByIds/getLinkedScreenshots/recordToExpandedNode`）：
    - 要么挪到“query helper / repository”文件，
    - 要么保留但别从 [electron/services/screenshot-processing/index.ts](cci:7://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/index.ts:0:0-0:0) export（减少公共 surface area）。

> 我不直接动代码是因为这属于 API 级变更；你确认“外部没依赖/可以收口”后，我可以给你一个收口 patch。

### 2.2 性能/效率（主要问题在 [traverse](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:359:2-482:3)）

[traverse()](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:359:2-482:3) 当前是典型 **N+1 查询**：

- BFS 每访问一个 node：
  - 查一次 `contextScreenshotLinks`（按 nodeId）
  - 若深度未到：查一次 outgoing edges + 查一次 incoming edges
- 深度和节点一多，SQL 次数会指数增加（尤其你做双向遍历）。

改进方向：

- **按层批量查询**：对 `currentLevel` 用 `inArray(contextEdges.fromNodeId, currentLevel)` 一次查完 outgoing；incoming 同理；links 也同理。
- **去重 collectedEdges**：双向遍历 + 多路径会重复 push 相同边，最好用一个 `Set`（key=`from-to-type`）避免膨胀。
- **depth 条件**：你现在 `while (... && currentDepth <= depth)`，且在 `currentDepth < depth` 时扩边，逻辑是对的，但会额外多跑一层只做“标记 visited + links”。如果这是刻意为了“最后一层也收集 screenshotIds”，OK；否则可调成更直观的控制。

[createNode()](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:108:2-173:3) 的效率点：

- 对 `screenshotIds` 的逐个 [await this.linkScreenshot(...)](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:277:2-318:3) 会导致串行写入。可以：
  - 用批量 insert（一次 `values([...])`）+ `onConflictDoNothing`，并放进事务，性能和一致性都更好。

### 2.3 重复定义类型/schema 的问题

这里有**明确的重复定义/概念重叠**：

- [context-graph-service.ts](cci:7://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:0:0-0:0) 里定义了 [TraverseResult](cci:2://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:71:0-79:1)，而 [types.ts](cci:7://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/types.ts:0:0-0:0) 里已经有 [GraphTraversalResult](cci:2://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/types.ts:367:0-378:1)（语义非常接近）。
  - 目前 [TraverseResult](cci:2://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:71:0-79:1) 返回的是 [ContextNodeRecord[]](cci:2://file:///c:/frank-repos/Mnemora/electron/database/schema.ts:457:0-457:65)，而 [GraphTraversalResult](cci:2://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/types.ts:367:0-378:1) 返回 [ExpandedContextNode[]](cci:2://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/types.ts:272:0-295:1)。
  - 建议统一策略：
    - 要么 [traverse()](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:359:2-482:3) 直接返回 **record**（DB 层）并把“转换成 Expanded”放到上层；
    - 要么 [traverse()](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:359:2-482:3) 内部就 [recordToExpandedNode()](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:595:2-615:3)，直接返回 [GraphTraversalResult](cci:2://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/types.ts:367:0-378:1)（更符合“service 层输出可用 DTO”）。
- [recordToExpandedNode()](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:595:2-615:3) 的 JSON parse 没有容错：`JSON.parse(record.keywords)` 一旦 DB 内容被污染会直接抛异常。
  - 如果它是公共 API，建议做 `try/catch` 或 “safe parse + fallback”。

另外还有一些“小的建模一致性”点：

- id 在 service API 层用 `string`（createNode 返回 string、其它参数也收 string），DB 实际是 `number`。这会带来大量 `parseInt` 与错误分支。内部 service 更自然的形态是用 `number`，字符串转换放到 IPC/API 层。

### 2.4 冗余/可简化实现

- `createEdge/linkScreenshot` 已经用了 `onConflictDoNothing`，但又额外 try/catch 去判断 `UNIQUE constraint failed`：这段在 SQLite 上通常不会触发（因为冲突已被 do nothing 吸收），属于**冗余复杂度**，可以删掉 try/catch，让逻辑更干净。

---

## 建议的“最小重构”优先级（不改变业务行为）

- **P0（高收益，低风险）**
  - **优化 [traverse](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:359:2-482:3) 的 N+1**：按层批量查询 edges/links，并对 collectedEdges 去重。
  - **批量 linkScreenshot**：[createNode](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:108:2-173:3) 里 screenshot links 用一次 insert。
- **P1（API 收口）**
  - 从 [screenshot-processing/index.ts](cci:7://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/index.ts:0:0-0:0) 中减少 export：只导出真正需要的少数方法/类型，避免“公共 API 无限制增长”。
  - 合并/统一 [TraverseResult](cci:2://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/context-graph-service.ts:71:0-79:1) vs [GraphTraversalResult](cci:2://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/types.ts:367:0-378:1)，把“图遍历结果 DTO”收敛到一个地方（建议 [types.ts](cci:7://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing/types.ts:0:0-0:0)）。
- **P2（与文档一致性）**
  - 决定 `derived_from_screenshot` 到底走 edge 还是 link table，并统一文档与 schema（避免双轨）。
  - 对 derived kind 强制 `sourceEventId`（或提供一个专门的 `createDerivedNode(...)` 入口），把“不可产生孤岛”落到代码层。

---

## 我需要你确认的一点（方便我下一步直接改代码）

- 你希望我 **只做 review 给建议**，还是希望我直接提交一个 patch：
  - **选项 A**：只做 “P0 性能优化 + type 收敛”，不改对外 API；
  - **选项 B**：连同 “public export 收口 + 方法改 private/拆分文件” 一起做（会涉及潜在破坏性变更，但从当前 repo 搜索看影响可能很小）。

---

## 状态

- **已完成**：对照文档一致性检查 + 代码简洁/性能/重复类型与 schema review。
