# 纯前端架构设计指南：从屏幕上下文到认知智能

本文档旨在指导如何使用纯前端技术（Electron + Node.js）重构原有的 Python + Electron 混合架构，实现一个具备屏幕感知、语义理解和主动建议功能的智能应用。

## 1. 核心架构映射

我们将原 Python 后端的各个模块映射到 Node.js 生态系统中：

| 核心流程        | 原 Python 实现              | Node.js / Electron 纯前端方案  | 推荐库/API                                                    |
| :-------------- | :-------------------------- | :----------------------------- | :------------------------------------------------------------ |
| **1. 截图采集** | `mss` (后台线程)            | Electron 主进程 (Main Process) | `desktopCapturer` (原生) 或 `screenshot-desktop`              |
| **2. 图像去重** | `imagehash` / `PIL` (pHash) | 图片处理与哈希计算             | `sharp` (替代 PIL, 极速) + `blockhash-js` (替代 imagehash)    |
| **3. 任务队列** | `queue.Queue`               | 异步队列管理                   | `fastq` 或 `async/queue`                                      |
| **4. VLM 识别** | Python HTTP Client          | Node.js SDK                    | `openai` / `anthropic-sdk`                                    |
| **5. 向量存储** | ChromaDB / LanceDB          | 本地向量库 (JS/WASM)           | **Voyager** (推荐, WASM 极快), `Orama`, 或 `Chroma` JS Client |
| **6. 关系存储** | SQLite                      | 本地数据库                     | `better-sqlite3` (推荐), `RxDB`, 或 `Prisma`                  |
| **7. 任务调度** | `threading` / `schedule`    | 定时任务                       | `node-schedule` 或 `bree`                                     |

---

## 2. 详细实现流程

### 阶段一：智能采集与去重 (The Eye)

**目标**：实现低功耗、无人值守的屏幕监控。

1.  **主进程调度**：

    - 在 Electron **主进程**中创建一个定时器（默认每 15 秒，可配置）。
    - **不要**在渲染进程做这件事，以避免页面阻塞和性能问题。
    - **调度机制**（参考 `ScheduleNextTask`）：
      - 使用 `setTimeout` 实现自循环调度，而非 `setInterval`。
      - **智能延迟补偿**：`nextDelay = INTERVAL - executionTime`，确保总周期稳定（避免"间隔 + 执行时间"的累积漂移）。
      - 错误容错：即使某次截图任务失败，循环也会继续（catch 后仍调度下一次）。

2.  **动态窗口追踪**（参考 `AutoRefreshCache`）：

    - 用户的屏幕环境是动态的（窗口打开/关闭、最小化、切换虚拟桌面、插拔显示器）。
    - 使用一个**高频缓存**（如每 3 秒刷新一次）来追踪当前可见的窗口和屏幕列表。
    - **为什么刷新频率更高？** 确保截图任务（15 秒）执行时，拿到的窗口列表是最新的，避免截取已关闭窗口或遗漏新窗口。
    - 实现方式：
      ```typescript
      const configCache = new AutoRefreshCache({
        fetchFn: async () =>
          desktopCapturer.getSources({ types: ["window", "screen"] }),
        interval: 3000, // 3 秒刷新
        immediate: true,
      });
      ```

3.  **获取截图**：

    - 使用 `desktopCapturer.getSources` 获取屏幕源。
    - 或者使用 `screenshot-desktop` 库直接获取 Buffer（通常比 `desktopCapturer` 更快用于全屏截图）。

4.  **感知哈希 (pHash) 去重**：
    - **原理解析**：在 Python 版中，这一步由 `imagehash` 和 `PIL` 完成。在 Node.js 中，`sharp` 是更高效的替代品（基于 libvips C++）。
    - **实现步骤**：
      1.  使用 `sharp` 将截图 resize 到 32x32 并转为灰度 (`.resize(32, 32).grayscale()`)。
      2.  获取 raw buffer 计算哈希。
      3.  与上一帧哈希对比，汉明距离 < 阈值（如 2）则视为静止画面，直接丢弃。
    - **压缩上传**：对于通过去重的图片，使用 `sharp` 转换为 JPEG (quality: 80) 或 WebP，大幅减少 VLM Token 消耗和网络带宽。

### 阶段二：VLM 语义提取 (The Brain)

**目标**：将像素转化为结构化文本。

1.  **批处理策略**：

    - 维护一个内存数组 `pendingScreenshots = []`。
    - 当数组长度达到 `BATCH_SIZE` (如 5-10) 或距离上次处理超过 `TIMEOUT` (如 30 秒)，触发处理函数。

2.  **调用 Vision LLM**：
    - 构造 Prompt（参考原项目 `config/prompts_en.yaml`）。
    - 将图片转换为 Base64，并发请求 OpenAI (GPT-4o) 或 Anthropic (Claude 3.5 Sonnet)。
    - **提示词重点**：要求返回 JSON 格式，包含 `title`, `summary`, `keywords`, `context_type` (activity/semantic/debug 等)。

### 阶段三：上下文融合 (Merge)

**目标**：将碎片化的瞬间整合成连续的事件。

1.  **合并逻辑 (Node.js 实现)**：

    - 获取 VLM 返回的一批 `ParsedItem`。
    - 按 `context_type` 分组。
    - 从本地数据库中查出**最近一条未完结**的记录（Cache）。
    - 将 **Cache + New Items** 一起发给 LLM（使用轻量模型如 GPT-4o-mini 以节省成本）。

2.  **LLM 决策**：
    - 询问 LLM："这些片段是同一个事件的延续吗？"
    - **Merge**：更新数据库中旧记录的 `end_time` 和 `summary`。
    - **New**：插入一条新记录到数据库。

### 阶段四：存储与记忆 (The Memory)

**目标**：构建可检索的个人知识库。

1.  **双写策略**：

    - **SQLite (better-sqlite3)**: 存储完整的 JSON 对象、时间戳、应用名称。用于时间轴展示 (`SELECT * FROM activities WHERE time > ?`).
    - **Vector DB (Voyager)**: 存储 `embedding(title + summary)`。用于语义搜索 ("我上周处理的那个报错")。

2.  **隐私数据存储**：
    - 所有数据存储在 `app.getPath('userData')` 下，确保数据完全本地化。

### 阶段五：认知分析与主动建议 (The Advisor)

**目标**：ActivityMonitor 实现。

1.  **RAG (检索增强生成) 循环**：

    - 设置一个 `ActivityMonitor` 定时任务（如每 15-30 分钟）。
    - **Retrieve**: `db.prepare('SELECT * FROM activities WHERE time > ?').all(last_15_min)`。
    - **Generate**: 发送给 LLM，使用 `generation.realtime_activity_monitor` 提示词。

2.  **事件驱动反馈**：
    - 如果 LLM 分析结果包含 `potential_todos` 或 `suggestions`。
    - 通过 Electron 的 `ipcMain` 发送事件给渲染进程。
    - 前端收到事件，弹出 Toast 或 Notification："检测到您在调试 Python 错误，建议尝试安装 pandas..."。

---

## 3. 推荐技术栈 (Pure Frontend)

为了获得最佳性能和开发体验，推荐以下技术组合：

- **框架**: Electron + React/Vue
- **构建工具**: Vite (必须，用于快速构建主进程和渲染进程)
- **语言**: TypeScript (必须，复杂逻辑没有类型会很痛苦)
- **数据库**:
  - **better-sqlite3**: Node.js 环境下最快的 SQLite 库，同步 API 避免回调地狱，非常适合 Electron 主进程。
- **向量搜索**:
  - **Voyager**: Spotify 开源的 WASM 向量库，运行在 Node.js 中，极快，无需额外部署向量数据库。
- **图片处理**:
  - **sharp**: Node.js 也就是最快的图片处理库，用于 resize 和格式转换。

## 4. 关键技术细节：混合截图策略

项目采用了一套精妙的混合策略来平衡性能与兼容性，实现全场景覆盖。请在实现时参考以下分工：

### 4.1 工具分工表

| 场景                | 推荐工具                                   | 核心代码参考                                | 优势                                                                                           |
| :------------------ | :----------------------------------------- | :------------------------------------------ | :--------------------------------------------------------------------------------------------- |
| **全屏监控 (高频)** | `screenshot-desktop`                       | `ScreenshotService.takeScreenshotOfDisplay` | 调用系统底层 API (GDI/Quartz)，速度快，开销低，适合 5s/次的自动采集。                          |
| **窗口抓取 (交互)** | `electron.desktopCapturer`                 | `ScreenshotService.takeSourceScreenshot`    | 原生支持获取 Window ID 和缩略图，适合用户手动选择特定窗口。                                    |
| **跨平台高性能**    | `NativeCaptureHelper` (`node-screenshots`) | `NativeCaptureHelper.captureScreen`         | 基于 Rust 的 Native 模块，直接调用底层 API，比 Electron 原生更轻量，尤其在多屏场景下表现更好。 |
| **macOS 增强**      | AppleScript                                | `get-capture-sources.ts` (exec osascript)   | 通过 `exec` 执行 AppleScript 脚本，获取所有 Spaces 上的窗口列表，补充 Electron 的视野盲区。    |

### 4.2 实现逻辑建议

1.  **自动监控循环 (Auto Loop)**：

    - **推荐**使用 `NativeCaptureHelper` (封装 `node-screenshots`)。
    - 它比 `desktopCapturer` 更适合高频全屏截图，且比 `screenshot-desktop` 维护更积极（Rust 核心）。
    - 代码示例：
      ```typescript
      // NativeCaptureHelper 内部封装
      import * as nodeScreenshots from "node-screenshots";
      const monitors = nodeScreenshots.Monitor.all();
      const image = await monitors[0].captureImage();
      ```

2.  **窗口元数据获取**：

    - 使用 `desktopCapturer.getSources({ types: ['window'], thumbnailSize: {width: 1, height: 1} })`。
    - 注意设置 `thumbnailSize` 为极小值，因为我们只需要窗口列表（标题、ID、图标），不需要真正的截图内容，这样可以极大提升性能。

3.  **macOS 兼容性处理**：
    - Electron 在 macOS 上有一个已知限制：无法获取全屏独占应用或其它虚拟桌面的窗口。
    - 如果你的目标用户包含 Mac 用户，建议通过 `exec('osascript ...')` 执行 AppleScript 来获取所有运行中应用的列表，与 Electron 的源列表进行合并补全。

### 4.3 多屏处理机制 (Multi-Monitor Strategy)

在多显示器场景下，简单的“循环截图”会导致上下文割裂和 API 成本倍增。推荐采用 **"前端拼图 (Stitching)"** 策略：

1.  **并行采集**：
    使用 `node-screenshots` 同时获取所有屏幕的图像数据（Monitor A, Monitor B...）。

2.  **智能拼接**：
    使用 `sharp` 将多个屏幕的图像按其物理布局（坐标）拼接成一张大图。

    ```javascript
    // 伪代码示例
    const compositeImage = await sharp({
      create: {
        width: totalWidth,
        height: maxHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        { input: bufferA, left: 0, top: 0 },
        { input: bufferB, left: 1920, top: 0 }, // 根据实际坐标动态计算
      ])
      .jpeg({ quality: 80 })
      .toBuffer();
    ```

3.  **统一语义化**：
    将拼接后的一张大图发送给 VLM。
    - **优势**：VLM 能完整理解跨屏操作（如“左屏看文档，右屏写代码”），且只产生一次 API 请求（Prompt Overhead 最小化）。
    - **提示词调整**：在 System Prompt 中告知 VLM "This is a composite screenshot of multiple monitors"，让其理解布局。

### 4.4 应用匹配机制 (App Matching)

项目中有三处代码涉及第三方应用的匹配和判断，理解其真正作用对于正确实现截图捕获逻辑至关重要。

#### 4.4.1 匹配代码位置

| 文件                     | 函数/位置                 | 作用                                                      |
| :----------------------- | :------------------------ | :-------------------------------------------------------- |
| `mac-window-manager.ts`  | `getAllWindows()` L94-186 | 维护 `importantApps` 和 `systemApps` 列表，用于过滤和排序 |
| `get-capture-sources.ts` | L702-734                  | 判断虚拟窗口（无真实窗口 ID）是否在任何空间可见           |
| `get-visible-source.ts`  | L96-127                   | 判断窗口当前是否可见，决定是否需要截图                    |

#### 4.4.2 匹配逻辑示例

```typescript
// get-capture-sources.ts / get-visible-source.ts
const hasWindowsOnAnySpace = activeAppsOnAllSpaces.some((activeApp) => {
  return (
    activeApp.includes(appNameLower) ||
    appNameLower.includes(activeApp) ||
    // 处理应用名不一致的情况
    (appNameLower === "msteams" && activeApp.includes("teams")) ||
    (appNameLower === "microsoft teams" && activeApp.includes("teams")) ||
    (appNameLower === "wechat" &&
      (activeApp.includes("wechat") || activeApp.includes("weixin"))) ||
    (appNameLower === "google chrome" && activeApp.includes("chrome")) ||
    (appNameLower === "visual studio code" &&
      (activeApp.includes("code") || activeApp.includes("visual studio")))
    // ...
  );
});
```

#### 4.4.3 匹配的真正作用

这些 app 匹配逻辑**不是用于 context 字段**，而是用于：

| 作用                   | 说明                                                                      | 代码位置                                             |
| :--------------------- | :------------------------------------------------------------------------ | :--------------------------------------------------- |
| **过滤系统窗口**       | 排除 MineContext、Dock、Spotlight 等不需要截图的系统组件                  | `mac-window-manager.ts` L127-136 (`systemApps` 列表) |
| **保证重要应用被包含** | 即使窗口最小化或不在屏幕上，重要应用也会被加入捕获列表                    | `get-capture-sources.ts` L194                        |
| **处理应用名不一致**   | 解决 macOS 上同一应用有多种名称的问题（如 `msteams` ↔ `Microsoft Teams`） | 上述匹配逻辑                                         |

#### 4.4.4 ⚠️ 重要：应用名未传给后端

实际传给后端的数据**不包含具体应用名**：

```typescript
// screen-monitor-task.ts L202-207
const data = {
  path: url,
  window: type === "screen" ? "screen" : "", // 只是类型标识，不是应用名
  create_time: createTime.format("YYYY-MM-DD HH:mm:ss"),
  app: type === "window" ? "window" : "", // 只是类型标识，不是应用名
};
```

后端的 `additional_info` 存储的也只是 `'screen'` 或 `'window'` 这样的类型标识。**VLM 分析截图时不依赖前端传递的应用名**，而是直接从图像中识别内容。

#### 4.4.5 "优先处理"的实现

`mac-window-manager.ts` 中的排序逻辑：

```typescript
// mac-window-manager.ts L167-172
allWindows.sort((a, b) => {
  if (a.isImportantApp && !b.isImportantApp) return -1;
  if (!a.isImportantApp && b.isImportantApp) return 1;
  return a.appName.localeCompare(b.appName);
});
```

**注意**：这只是让返回的窗口列表中重要应用排在前面。由于 `screen-monitor-task.ts` 使用 `forEach` + `PQueue` (FIFO) 处理所有可见源，排在前面的确实会先进入队列，但：

1. 差别只是毫秒级，对实际截图没有影响
2. 没有真正的优先级机制（如跳过队列、更高并发等）
3. 主要作用是**保证被包含**，而非**优先处理**

## 5. 数据流图

```mermaid
graph TD
    Screen[屏幕] -->|desktopCapturer| Capture[采集模块(Main)]
    Capture -->|sharp| Dedup[去重模块]
    Dedup -->|Base64| Queue[内存队列]

    Queue -->|Batch| VLM[Vision LLM (GPT-4o)]
    VLM -->|JSON| Merge[融合模块]

    Merge -->|Upsert| SQL[(SQLite DB)]
    Merge -->|Embedding| Vector[(Voyager Vector DB)]

    Timer[定时器] --> Monitor[ActivityMonitor]
    Monitor -->|Query| SQL
    Monitor -->|Analyze| LLM[LLM (GPT-4o-mini)]

    LLM -->|Insights| UI[前端 UI / 通知]
    UI -->|Search| Vector
```

## 6. 数据库设计详解

本项目采用 **双存储架构**：关系型数据库（SQLite）存储结构化数据，向量数据库（ChromaDB/Qdrant）存储语义向量，支持精确查询与语义检索的双重能力。

### 6.1 整体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         UnifiedStorage (统一存储层)                       │
├─────────────────────────────────┬───────────────────────────────────────┤
│     IDocumentStorageBackend     │       IVectorStorageBackend           │
│         (文档存储接口)            │          (向量存储接口)                │
├─────────────────────────────────┼───────────────────────────────────────┤
│         SQLiteBackend           │    ChromaDBBackend / QdrantBackend    │
│  ┌───────────────────────────┐  │  ┌─────────────────────────────────┐  │
│  │ • activity (活动记录)      │  │  │ • activity_context (活动向量)    │  │
│  │ • todo (待办事项)          │  │  │ • intent_context (意图向量)      │  │
│  │ • vaults (知识库文档)      │  │  │ • semantic_context (语义向量)    │  │
│  │ • tips (建议提示)          │  │  │ • entity_context (实体向量)      │  │
│  │ • conversations (对话)     │  │  │ • procedural_context (流程向量)  │  │
│  │ • messages (消息)          │  │  │ • state_context (状态向量)       │  │
│  │ • monitoring_* (监控)      │  │  │ • todo (待办去重向量)            │  │
│  └───────────────────────────┘  │  └─────────────────────────────────┘  │
└─────────────────────────────────┴───────────────────────────────────────┘
```

### 6.2 核心数据模型

#### ProcessedContext（处理后的上下文）

这是系统的核心数据模型，贯穿语义提取、合并、存储的全流程：

```typescript
// TypeScript 类型定义（用于 Node.js 纯前端实现）
interface ProcessedContext {
  id: string; // UUID，唯一标识
  properties: ContextProperties; // 上下文属性
  extracted_data: ExtractedData; // VLM 提取的数据
  vectorize: Vectorize; // 向量化信息
  metadata?: Record<string, any>; // 元数据（合并来源等）
}

interface ContextProperties {
  raw_properties: RawContextProperties[]; // 原始截图属性列表
  create_time: Date; // 首次创建时间
  event_time: Date; // 事件发生时间
  update_time: Date; // 最后更新时间
  duration_count: number; // 持续截图数量（合并计数）
  merge_count: number; // 被合并次数
  is_processed: boolean; // 是否已处理
  enable_merge: boolean; // 是否允许合并
}

interface ExtractedData {
  title: string; // 标题（如"Python 开发"）
  summary: string; // 摘要描述
  keywords: string[]; // 关键词列表
  entities: string[]; // 实体列表（人名、项目名等）
  context_type: ContextType; // 上下文类型
  confidence: number; // 置信度 (0-100)
  importance: number; // 重要性 (0-100)
}

interface Vectorize {
  content_format: "text" | "image";
  text?: string; // 用于向量化的文本
  vector?: number[]; // 嵌入向量 (1536 维)
}

// 上下文类型枚举
enum ContextType {
  ACTIVITY_CONTEXT = "activity_context", // 活动：用户正在做什么
  INTENT_CONTEXT = "intent_context", // 意图：用户想要达成什么
  SEMANTIC_CONTEXT = "semantic_context", // 语义：技术概念和知识
  ENTITY_CONTEXT = "entity_context", // 实体：人/项目/组织信息
  PROCEDURAL_CONTEXT = "procedural_context", // 流程：操作步骤
  STATE_CONTEXT = "state_context", // 状态：进度和指标
}
```

### 6.3 SQLite 表结构

#### activity 表（活动记录）

存储 ActivityMonitor 生成的高层活动摘要：

```sql
CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,           -- 活动标题（如"Python 数据处理开发"）
    content TEXT,         -- 活动描述（2-3 句话的摘要）
    resources JSON,       -- 关联资源（截图路径列表）
    metadata JSON,        -- 元数据（类别分布、洞察、建议等）
    start_time DATETIME,  -- 活动开始时间
    end_time DATETIME     -- 活动结束时间
);

-- 索引优化时间范围查询
CREATE INDEX idx_activity_time ON activity (start_time, end_time);
```

**metadata JSON 结构示例**：

```json
{
  "category_distribution": { "coding": 50, "debugging": 30, "reading": 20 },
  "insights": ["高效的文档先行工作流", "快速定位并修复了 TypeError"],
  "potential_todos": ["为数据处理函数添加单元测试", "在 README 中记录脚本用法"],
  "tips": ["考虑使用 pandas profiling 进行数据探索"]
}
```

#### todo 表（待办事项）

```sql
CREATE TABLE todo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT,           -- 待办内容
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    start_time DATETIME,    -- 开始时间
    end_time DATETIME,      -- 完成时间
    status INTEGER DEFAULT 0,  -- 0=待处理, 1=进行中, 2=已完成
    urgency INTEGER DEFAULT 0, -- 紧急程度 (0-3)
    assignee TEXT,          -- 负责人
    reason TEXT             -- 创建原因/来源
);
```

#### vaults 表（知识库文档）

```sql
CREATE TABLE vaults (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    summary TEXT,
    content TEXT,           -- Markdown 内容
    tags TEXT,              -- 标签（JSON 数组）
    parent_id INTEGER,      -- 父文件夹 ID
    is_folder BOOLEAN DEFAULT 0,
    is_deleted BOOLEAN DEFAULT 0,
    document_type TEXT DEFAULT 'vaults', -- DailyReport/WeeklyReport/Note
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES vaults (id)
);
```

#### tips 表（智能建议）

```sql
CREATE TABLE tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT,           -- 建议内容
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 6.4 向量数据库设计

向量数据库按 `context_type` 分 Collection 存储，每个 Collection 独立管理：

```
ChromaDB / Qdrant
├── activity_context    (活动上下文向量)
├── intent_context      (意图上下文向量)
├── semantic_context    (语义上下文向量)
├── entity_context      (实体上下文向量)
├── procedural_context  (流程上下文向量)
├── state_context       (状态上下文向量)
└── todo                (待办去重向量)
```

**每条记录的存储结构**：

```json
{
  "id": "uuid-xxx",
  "document": "Python Development. User is coding and debugging a data processing script using pandas...",
  "embedding": [0.023, -0.156, ...],  // 1536 维向量
  "metadata": {
    "title": "Python Development",
    "summary": "User is coding and debugging...",
    "keywords": "[\"python\", \"coding\", \"pandas\"]",
    "entities": "[\"pandas\", \"VS Code\"]",
    "context_type": "activity_context",
    "create_time": "2025-11-23T17:30:00",
    "update_time": "2025-11-23T17:45:00",
    "duration_count": 5,
    "confidence": 85
  }
}
```

### 6.5 存储职责划分

**向量数据库** 和 **SQLite** 存储不同类型的数据：

| 存储类型       | 存储内容                             | 数据来源            | 查询方式               |
| :------------- | :----------------------------------- | :------------------ | :--------------------- |
| **向量数据库** | `ProcessedContext`                   | VLM 提取 + 语义合并 | 语义搜索（相似度）     |
| **SQLite**     | `Activity`, `todo`, `vaults`, `tips` | 见下表              | 结构化查询（时间、ID） |

**SQLite 各表数据来源**：

| 表名       | 数据来源                               | 代码位置                                           |
| :--------- | :------------------------------------- | :------------------------------------------------- |
| `activity` | 自动（ActivityMonitor）                | `realtime_activity_monitor.py:92`                  |
| `todo`     | 自动（SmartTodoManager）+ 用户（前端） | `smart_todo_manager.py:98` / `ToDoService.ts:136`  |
| `vaults`   | 自动（日报生成）+ 用户（API）          | `generation_report.py:55` / `routes/vaults.py:128` |
| `tips`     | 自动（SmartTipGenerator）              | `smart_tip_generator.py:70`                        |

**定时生成机制**（由 `ConsumptionManager` 统一调度）：

| 生成器                | 默认间隔   | 数据源                        | 输出                |
| :-------------------- | :--------- | :---------------------------- | :------------------ |
| **ActivityMonitor**   | 15 分钟    | 向量数据库 `ProcessedContext` | `activity` 表       |
| **SmartTodoManager**  | 30 分钟    | 向量数据库 `ProcessedContext` | `todo` 表           |
| **SmartTipGenerator** | 1 小时     | 向量数据库 `ProcessedContext` | `tips` 表           |
| **ReportGenerator**   | 每天 08:00 | 向量数据库 `ProcessedContext` | `vaults` 表（日报） |

配置来源：`config/config.yaml` 的 `content_generation` 节

**为什么这样划分？**

- `ProcessedContext` 需要**语义检索**（"找到和 Python 调试相关的上下文"），必须有向量
- `Activity` 是**时间线展示**（"今天做了什么"），用时间范围查询更高效
- 两者是 **1:N 关系**：多个 `ProcessedContext` 聚合生成一个 `Activity`
- `vaults` 是用户主动创建的内容，与自动采集的上下文流程独立

---

### 6.6 关键设计机制

#### 6.6.1 一截图多上下文（Multi-Context Extraction）

**设计**：一张截图可以提取出**多种类型**的上下文。

```json
// 截图：VS Code 打开 pandas 文档，用户正在高亮代码
[
  {
    "context_type": "activity_context",
    "title": "Studying pandas documentation",
    "summary": "User is reading pandas merge function documentation in VS Code"
  },
  {
    "context_type": "semantic_context",
    "title": "pandas DataFrame merge",
    "summary": "pandas merge() accepts on/left_on/right_on parameters for joining DataFrames"
  }
]
```

**好处**：

| 优势           | 说明                                                   |
| :------------- | :----------------------------------------------------- |
| **关注点分离** | 用户行为（activity）与知识内容（semantic）分开存储     |
| **检索精准**   | 问"pandas 怎么用"→ 命中 `semantic_context`，无行为噪音 |
| **信息完整**   | 同时保留"用户在做什么"和"屏幕显示什么"，不丢失信息     |
| **独立合并**   | 活动可连续合并，知识独立积累，互不干扰                 |

---

#### 6.6.2 可再次合并（Progressive Merging）

**设计**：合并后的 `ProcessedContext` 会重新进入缓存，可被后续新上下文再次合并。

```
时间线：
17:30 截图1 → 上下文 A（新建，加入缓存）
17:32 截图2 → 上下文 B（新建）
       ↓ LLM 判断：A + B 主题相同 → 合并为 AB
       ↓ A、B 从缓存移除，AB 加入缓存
17:35 截图3 → 上下文 C（新建）
       ↓ LLM 判断：AB + C 主题相同 → 合并为 ABC
       ↓ AB 从缓存移除，ABC 加入缓存
17:50 截图4 → 上下文 D（新建）
       ↓ LLM 判断：ABC 和 D 主题不同 → 不合并
       ↓ D 作为新项加入缓存，ABC 保留
```

**缓存更新逻辑**（来自 `screenshot_processor.py`）：

```python
for merged_context in merged_contexts:
    # 移除被合并的旧项
    self._processed_cache[context_type] = [
        item for item in self._processed_cache[context_type]
        if item.id not in merged_context.metadata.get("merged_from", [])
    ]
    # 添加合并后的新项（可被再次合并）
    self._processed_cache[context_type].append(merged_context)
```

**好处**：

| 优势             | 说明                                           |
| :--------------- | :--------------------------------------------- |
| **渐进式聚合**   | 30 分钟编码活动 → 1 条完整记录，而非 10 条碎片 |
| **时间自动延伸** | `duration_count` 和时间范围随合并自动累积      |
| **信息滚雪球**   | 关键词、实体随每次合并不断补充完善             |
| **边界智能识别** | LLM 判断活动切换时自动停止合并，形成新记录     |

---

### 6.7 处理流水线架构

#### 6.7.1 并发模型

**VLM 提取**：多次并发请求，每张图一次请求

```python
# screenshot_processor.py:506-509
vlm_results = await asyncio.gather(
    *[self._process_vlm_single(raw_context) for raw_context in raw_contexts],
    return_exceptions=True
)
# 10 张截图 → 10 个并发 VLM 请求 → 等待全部返回
```

**LLM 合并**：按 context_type 分组并发

```python
# screenshot_processor.py:316-321
tasks = []
for context_type, new_items in items_by_type.items():
    cached_items = list(self._processed_cache.get(context_type.value, {}).values())
    tasks.append(self._merge_items_with_llm(context_type, new_items, cached_items))
results = await asyncio.gather(*tasks, return_exceptions=True)
# 6 种 context_type → 最多 6 个并发 LLM 请求
```

#### 6.7.2 同步阻塞设计

VLM 和 LLM 合并在**同一批次**中顺序执行，整体是阻塞的：

```python
# screenshot_processor.py:204-206
processed_contexts = asyncio.run(self.batch_process(unprocessed_contexts))  # 阻塞
if processed_contexts:
    get_storage().batch_upsert_processed_context(processed_contexts)
```

```
时间线：
[批次1] VLM(10张) → LLM合并 → 存储 → [批次2] VLM(10张) → LLM合并 → 存储 → ...
                                ↑
                          完成后才取下一批
```

**背压处理**：`_input_queue` 的 `maxsize=30` 提供缓冲，队列满时 `put()` 阻塞 2 秒后超时。

#### 6.7.3 存储时序

| 阶段                 | 操作             | 代码位置                      |
| :------------------- | :--------------- | :---------------------------- |
| LLM 合并中           | 删除被合并的旧项 | `screenshot_processor.py:333` |
| batch_process 返回后 | 批量存储新项     | `screenshot_processor.py:206` |

```
batch_process() 内部：
├─ _merge_contexts()：
│   └─ delete_processed_context(old_id)  ← 立即删除旧项
│
batch_process() 返回后：
└─ batch_upsert_processed_context(new_items) ← 批量存储新项
```

**设计意图**：向量数据库中始终只保留最新合并结果，不累积历史碎片。

#### 6.7.4 向量化与实体提取

LLM 合并后，对每个 ProcessedContext 并发执行**向量化**和**实体提取**：

```python
# screenshot_processor.py:452-458
async def _parse_single_context(self, item, entities):
    vectorize_task = do_vectorize_async(item.vectorize)      # 向量化
    entities_task = refresh_entities(entities_info, item.vectorize.text)  # 实体提取
    _, entities_results = await asyncio.gather(vectorize_task, entities_task)
```

**向量化内容**：`title` + `summary`

```python
# screenshot_processor.py:575-578
vectorize=Vectorize(
    text=f"{extracted_data.title} {extracted_data.summary}",  # 向量化这个
)
# 示例: "Python Development Session User is coding and debugging..."
# → Embedding API → [0.023, -0.156, ...] (1536 维)
```

> **实现方式**：调用 `GlobalEmbeddingClient`（`LLMType.EMBEDDING`），也就是专用的 **Embedding 模型接口**，而不是通用对话 LLM。实体上下文（`entity_context`）同样通过 `do_vectorize_async()` 生成向量。

**实体 (Entity)**：从文本中识别的命名对象（人名、项目名、工具名等）

| 字段      | 说明     | 示例                              |
| :-------- | :------- | :-------------------------------- |
| `name`    | 实体名称 | "VS Code"                         |
| `type`    | 类型     | tool / library / person / project |
| `aliases` | 别名列表 | ["VSCode", "vscode"]              |

**实体的用途**：

| 作用         | 说明                                               |
| :----------- | :------------------------------------------------- |
| **实体消歧** | "VSCode" 和 "VS Code" 合并为同一实体               |
| **关系追踪** | 记录哪些上下文提到了同一实体                       |
| **语义增强** | 实体本身存入 `entity_context` 向量库，支持实体搜索 |

> **精确匹配怎么做？** `entity_canonical_name` 存在 `metadata`（`ProfileContextMetadata.entity_canonical_name`）里，写入向量库时随记录一起保存。`ProfileEntityTool.find_exact_entity()` 直接调用 `get_all_processed_contexts(..., filter={"entity_canonical_name": [...]})` 对 metadata 做精确过滤；只在精确过滤找不到时才退回向量相似搜索（`find_similar_entities()`），并由 LLM 决策是否视为同一实体。

---

### 6.8 数据流转示例

以下是一个完整的数据流转示例，展示从截图到活动生成的全过程：

#### 场景：用户在 VS Code 中进行 Python 开发

**Step 1: 截图捕获 → RawContextProperties**

```
17:30:00 - 截图 1: VS Code 编辑 Python 文件
17:32:00 - 截图 2: VS Code 显示 TypeError
17:35:00 - 截图 3: VS Code 调试面板
17:38:00 - 截图 4: 浏览器查看 pandas 文档
17:42:00 - 截图 5: VS Code 代码已修复
```

每张截图生成一个 `RawContextProperties`：

```json
{
  "object_id": "raw-001",
  "content_format": "image",
  "source": "screenshot",
  "content_path": "/screenshots/2025-11-23/17-30-00.jpg",
  "create_time": "2025-11-23T17:30:00"
}
```

**Step 2: VLM 语义提取 → 多个 ProcessedContext**

VLM 分析截图后（prompt?），提取多种类型的上下文：

```json
// 截图 1 提取结果
[
  {
    "context_type": "activity_context",
    "title": "Coding Python Script",
    "summary": "User is editing a Python file in VS Code, working on data processing logic",
    "keywords": ["python", "vscode", "coding", "data"]
  },
  {
    "context_type": "semantic_context",
    "title": "Python Data Processing",
    "summary": "Using pandas DataFrame for data manipulation and transformation",
    "keywords": ["pandas", "dataframe", "data processing"]
  }
]
```

**Step 3: 语义合并 → 合并后的 ProcessedContext**

LLM 判断相似上下文并合并（prompt？） ：

```json
// 合并决策
{
  "merge_type": "merged",
  "merged_ids": ["uuid-1", "uuid-2", "uuid-3"], // 截图 1、2、3 的活动上下文
  "data": {
    "title": "Python Development Session",
    "summary": "User is coding and debugging a Python data processing script, encountered and fixed a TypeError",
    "keywords": ["python", "coding", "debugging", "pandas", "vscode"]
  }
}
```

合并后的 `ProcessedContext`：

```json
{
  "id": "uuid-merged-001",
  "properties": {
    "create_time": "2025-11-23T17:30:00",  // 最早时间
    "update_time": "2025-11-23T17:42:00",  // 最新时间
    "duration_count": 5,                    // 合并了 5 张截图
    "merge_count": 2                        // 被合并 2 次
  },
  "extracted_data": {
    "context_type": "activity_context",
    "title": "Python Development Session",
    "summary": "User is coding and debugging...",
    "keywords": ["python", "coding", "debugging", "pandas"],
    "entities": ["VS Code", "pandas"],
    "confidence": 90
  },
  "vectorize": {
    "text": "Python Development Session. User is coding and debugging...",
    "vector": [0.023, -0.156, ...]  // 1536 维
  },
  "metadata": {
    "merged_from": ["uuid-1", "uuid-2", "uuid-3"],
    "screenshot_paths": ["/screenshots/17-30-00.jpg", "/screenshots/17-32-00.jpg", ...]
  }
}
```

**Step 4: 双写存储**

1. **向量数据库**（ChromaDB `activity_context` Collection）：

```python
collection.upsert(
    ids=["uuid-merged-001"],
    documents=["Python Development Session. User is coding..."],
    embeddings=[[0.023, -0.156, ...]],
    metadatas=[{
        "title": "Python Development Session",
        "context_type": "activity_context",
        "create_time": "2025-11-23T17:30:00",
        ...
    }]
)
```

2. **SQLite** 不直接存储 `ProcessedContext`，而是由向量数据库承担此职责。

**Step 5: 活动生成 → Activity 记录**

ActivityMonitor 定时（每 15 分钟）从向量数据库检索最近的上下文，调用 LLM 生成活动摘要：

```json
// LLM 生成的活动摘要
{
  "title": "Python Data Processing Development",
  "description": "15-minute focused coding session working on a pandas-based data processing script. Started by reviewing documentation, then implemented core logic and debugged a TypeError.",
  "category_distribution": {
    "coding": 50,
    "debugging": 30,
    "reading": 20
  },
  "insights": [
    "Efficient workflow: documentation → implementation → debugging",
    "Quick problem resolution (5 minutes for TypeError)"
  ],
  "potential_todos": [
    "Add error handling for edge cases",
    "Write unit tests for data validation"
  ],
  "tips": ["Consider using pandas.DataFrame.info() for debugging data types"]
}
```

存储到 SQLite `activity` 表：

```sql
INSERT INTO activity (title, content, resources, metadata, start_time, end_time)
VALUES (
    'Python Data Processing Development',
    '15-minute focused coding session working on a pandas-based data processing script...',
    '["\/screenshots\/17-30-00.jpg", "\/screenshots\/17-32-00.jpg", ...]',
    '{"category_distribution": {"coding": 50, ...}, "insights": [...], ...}',
    '2025-11-23 17:30:00',
    '2025-11-23 17:45:00'
);
```

### 6.9 查询模式

#### 1. 时间线查询（SQLite）

```sql
-- 获取今天的所有活动
SELECT * FROM activity
WHERE start_time >= '2025-11-23 00:00:00'
ORDER BY start_time DESC;
```

#### 2. 语义搜索（向量数据库）

```python
# 搜索 "Python 调试" 相关的上下文
query_vector = embed("Python debugging error fix")
results = vector_db.search(
    collection="activity_context",
    query_vector=query_vector,
    top_k=10
)
```

#### 3. 混合查询（SQLite + 向量）

```python
# 先语义搜索找到相关上下文
contexts = vector_search("数据处理脚本")

# 再从 SQLite 获取对应时间段的活动
activities = db.query("""
    SELECT * FROM activity
    WHERE start_time BETWEEN ? AND ?
""", [start, end])
```

### 6.10 Node.js 实现建议

对于纯前端架构，推荐以下数据库方案：

| 存储类型     | 推荐方案         | 说明                                        |
| :----------- | :--------------- | :------------------------------------------ |
| **关系存储** | `better-sqlite3` | 同步 API，性能极佳，适合 Electron 主进程    |
| **向量存储** | `Voyager` (WASM) | Spotify 开源，运行在 Node.js 中，无需服务器 |
| **备选向量** | `Orama`          | 纯 TypeScript 实现，支持全文+向量搜索       |

**表结构迁移示例**（SQLite → better-sqlite3）：

```typescript
import Database from "better-sqlite3";

const db = new Database("minecontext.db");

// 创建表
db.exec(`
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    content TEXT,
    resources TEXT,  -- JSON 字符串
    metadata TEXT,   -- JSON 字符串
    start_time TEXT,
    end_time TEXT
  )
`);

// 插入活动
const insert = db.prepare(`
  INSERT INTO activity (title, content, resources, metadata, start_time, end_time)
  VALUES (?, ?, ?, ?, ?, ?)
`);

insert.run(
  "Python Development Session",
  "Focused coding session...",
  JSON.stringify(["/screenshots/1.jpg"]),
  JSON.stringify({ category_distribution: { coding: 80 } }),
  "2025-11-23T17:30:00",
  "2025-11-23T17:45:00"
);
```

---

## 7. 前端数据同步策略：IPC 推送模式

在 Electron 应用中，当数据存储在主进程（如 SQLite、本地文件）时，渲染进程需要一种可靠的方式来保持数据最新。本节介绍推荐的 **IPC 推送模式**。

### 7.1 为什么不用 `refetchOnWindowFocus`？

React Query 的 `refetchOnWindowFocus: true` 适用于 Web 应用，但在 Electron 中效果有限：

| 场景 | `refetchOnWindowFocus` 行为 | 问题 |
|:-----|:---------------------------|:-----|
| 用户切换到其他应用再切回 | ✅ 触发 refetch | 正常工作 |
| 主进程后台更新数据（用户未离开） | ❌ 不触发 | **数据不同步** |
| 用户在应用内切换页面 | ❌ 不触发 | 可能看到旧数据 |

**结论**：对于本地数据，主进程知道数据何时变化，应该**主动推送**通知渲染进程刷新。

### 7.2 架构设计

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Main Process                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐  │
│  │   SQLite    │───▶│  DataService │───▶│  IPC Event Emitter     │  │
│  │  Database   │    │  (CRUD ops)  │    │  webContents.send()    │  │
│  └─────────────┘    └─────────────┘    └───────────┬─────────────┘  │
└───────────────────────────────────────────────────┼─────────────────┘
                                                    │ IPC Channel
                                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Renderer Process                               │
│  ┌─────────────────────────┐    ┌─────────────────────────────────┐ │
│  │  IPC Listener (preload) │───▶│  QueryClient.invalidateQueries  │ │
│  │  ipcRenderer.on()       │    │  自动触发 refetch               │ │
│  └─────────────────────────┘    └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.3 实现步骤

#### Step 1: 定义 IPC 通道常量

```typescript
// shared/ipc-channels.ts
export const IPC_CHANNELS = {
  // 数据变更通知
  DATA_CHANGED: 'data:changed',
  
  // 细粒度通知（可选）
  ACTIVITY_CREATED: 'activity:created',
  ACTIVITY_UPDATED: 'activity:updated',
  ACTIVITY_DELETED: 'activity:deleted',
  TODO_CHANGED: 'todo:changed',
  SETTINGS_CHANGED: 'settings:changed',
} as const;

// 通知载荷类型
export interface DataChangedPayload {
  type: 'activity' | 'todo' | 'settings' | 'context';
  action: 'create' | 'update' | 'delete' | 'batch';
  ids?: string[];  // 受影响的记录 ID
}
```

#### Step 2: 主进程 - 数据变更时发送通知

```typescript
// electron/services/activity-service.ts
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS, DataChangedPayload } from '../../shared/ipc-channels';

class ActivityService {
  private db: Database;

  // 通知所有渲染进程
  private notifyRenderers(payload: DataChangedPayload) {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.DATA_CHANGED, payload);
      }
    });
  }

  async createActivity(data: ActivityInput): Promise<Activity> {
    const result = this.db.prepare(`
      INSERT INTO activity (title, content, start_time, end_time)
      VALUES (?, ?, ?, ?)
    `).run(data.title, data.content, data.startTime, data.endTime);

    // 数据写入后，通知渲染进程
    this.notifyRenderers({
      type: 'activity',
      action: 'create',
      ids: [String(result.lastInsertRowid)]
    });

    return this.getActivityById(result.lastInsertRowid);
  }

  async updateActivity(id: string, data: Partial<ActivityInput>): Promise<Activity> {
    // ... 更新逻辑
    
    this.notifyRenderers({
      type: 'activity',
      action: 'update',
      ids: [id]
    });

    return this.getActivityById(id);
  }

  async deleteActivity(id: string): Promise<void> {
    this.db.prepare('DELETE FROM activity WHERE id = ?').run(id);
    
    this.notifyRenderers({
      type: 'activity',
      action: 'delete',
      ids: [id]
    });
  }

  // 批量操作（如 ActivityMonitor 生成活动）
  async batchCreateActivities(activities: ActivityInput[]): Promise<void> {
    const insertMany = this.db.transaction((items: ActivityInput[]) => {
      const stmt = this.db.prepare(`
        INSERT INTO activity (title, content, start_time, end_time)
        VALUES (?, ?, ?, ?)
      `);
      const ids: string[] = [];
      for (const item of items) {
        const result = stmt.run(item.title, item.content, item.startTime, item.endTime);
        ids.push(String(result.lastInsertRowid));
      }
      return ids;
    });

    const ids = insertMany(activities);
    
    // 批量操作只发一次通知
    this.notifyRenderers({
      type: 'activity',
      action: 'batch',
      ids
    });
  }
}
```

#### Step 3: Preload 脚本 - 暴露 IPC 监听器

```typescript
// electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, DataChangedPayload } from '../shared/ipc-channels';

// 类型安全的回调
type DataChangedCallback = (payload: DataChangedPayload) => void;

contextBridge.exposeInMainWorld('electronAPI', {
  // 订阅数据变更
  onDataChanged: (callback: DataChangedCallback) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DataChangedPayload) => {
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.DATA_CHANGED, handler);
    
    // 返回取消订阅函数
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.DATA_CHANGED, handler);
    };
  },

  // 主动请求数据（用于初始加载）
  getActivities: (params: { startTime?: string; endTime?: string }) => 
    ipcRenderer.invoke('activity:getAll', params),
  
  getActivityById: (id: string) => 
    ipcRenderer.invoke('activity:getById', id),
});

// 类型声明（供渲染进程使用）
declare global {
  interface Window {
    electronAPI: {
      onDataChanged: (callback: DataChangedCallback) => () => void;
      getActivities: (params: { startTime?: string; endTime?: string }) => Promise<Activity[]>;
      getActivityById: (id: string) => Promise<Activity | null>;
    };
  }
}
```

#### Step 4: 渲染进程 - React Query 集成

```typescript
// src/hooks/useIPCSync.ts
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { DataChangedPayload } from '../../shared/ipc-channels';

/**
 * 监听主进程数据变更，自动使相关 Query 失效
 */
export function useIPCSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unsubscribe = window.electronAPI.onDataChanged((payload: DataChangedPayload) => {
      console.log('[IPC Sync] Data changed:', payload);

      // 根据变更类型，使对应的 Query 失效
      switch (payload.type) {
        case 'activity':
          // 使活动列表失效（触发 refetch）
          queryClient.invalidateQueries({ queryKey: ['activities'] });
          
          // 如果是更新/删除，也使具体记录失效
          if (payload.ids?.length && payload.action !== 'create') {
            payload.ids.forEach(id => {
              queryClient.invalidateQueries({ queryKey: ['activity', id] });
            });
          }
          break;

        case 'todo':
          queryClient.invalidateQueries({ queryKey: ['todos'] });
          break;

        case 'settings':
          queryClient.invalidateQueries({ queryKey: ['settings'] });
          break;

        case 'context':
          // ProcessedContext 变更，可能影响多个查询
          queryClient.invalidateQueries({ queryKey: ['contexts'] });
          queryClient.invalidateQueries({ queryKey: ['search'] });
          break;
      }
    });

    // 组件卸载时取消订阅
    return () => unsubscribe();
  }, [queryClient]);
}
```

#### Step 5: 在应用根组件启用同步

```typescript
// src/App.tsx
import { QueryProvider } from './providers/query-provider';
import { useIPCSync } from './hooks/useIPCSync';

function AppContent() {
  // 启用 IPC 数据同步
  useIPCSync();

  return (
    <div className="app">
      {/* 路由和页面内容 */}
    </div>
  );
}

export default function App() {
  return (
    <QueryProvider>
      <AppContent />
    </QueryProvider>
  );
}
```

#### Step 6: 使用示例 - 活动列表页面

```typescript
// src/pages/Activities.tsx
import { useQuery } from '@tanstack/react-query';

export function ActivitiesPage() {
  const { data: activities, isLoading, error } = useQuery({
    queryKey: ['activities'],
    queryFn: () => window.electronAPI.getActivities({}),
    // 不需要 refetchOnWindowFocus，IPC 推送会处理
    refetchOnWindowFocus: false,
    staleTime: Infinity,  // 数据永不过期，完全依赖 IPC 推送
  });

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <ul>
      {activities?.map(activity => (
        <li key={activity.id}>{activity.title}</li>
      ))}
    </ul>
  );
}
```

### 7.4 高级模式：乐观更新 + IPC 确认

对于需要即时反馈的操作，可以结合乐观更新：

```typescript
// src/hooks/useCreateActivity.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';

export function useCreateActivity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: ActivityInput) => 
      window.electronAPI.createActivity(data),
    
    // 乐观更新：立即在 UI 显示
    onMutate: async (newActivity) => {
      await queryClient.cancelQueries({ queryKey: ['activities'] });
      
      const previousActivities = queryClient.getQueryData(['activities']);
      
      queryClient.setQueryData(['activities'], (old: Activity[] = []) => [
        { ...newActivity, id: 'temp-' + Date.now() },  // 临时 ID
        ...old
      ]);

      return { previousActivities };
    },

    // 出错时回滚
    onError: (err, newActivity, context) => {
      queryClient.setQueryData(['activities'], context?.previousActivities);
    },

    // 注意：不需要 onSuccess 中 invalidate
    // IPC 推送会自动触发 invalidateQueries，用真实数据替换临时数据
  });
}
```

### 7.5 与其他方案对比

| 方案 | 实时性 | 复杂度 | 适用场景 |
|:----|:------|:------|:--------|
| **IPC 推送（推荐）** | ⭐⭐⭐ 即时 | 中等 | 本地数据，主进程知道变更时机 |
| `refetchOnWindowFocus` | ⭐ 延迟 | 低 | Web 应用，远程 API |
| `refetchInterval` 轮询 | ⭐⭐ 定时 | 低 | 数据变更频率可预测 |
| `staleTime: 0` | ⭐⭐ 组件挂载时 | 低 | 每次访问都需要最新数据 |

### 7.6 最佳实践

1. **批量通知**：多条记录变更时，合并为一次 IPC 通知，避免频繁 refetch
2. **细粒度 Query Key**：使用 `['activity', id]` 而非只用 `['activities']`，支持精确失效
3. **类型安全**：共享 `ipc-channels.ts` 确保主进程和渲染进程类型一致
4. **清理订阅**：在 `useEffect` 返回清理函数，避免内存泄漏
5. **错误处理**：IPC 通信可能失败，考虑添加重试或降级逻辑

---

## 8. 关键 Prompt 迁移参考

在实现时，请参考原项目 `config/prompts_en.yaml` 中的以下 Key 进行迁移：

1.  **截图语义提取**: `processing.extraction.screenshot_contextual_batch`
2.  **上下文合并**: `merging.screenshot_batch_merging`
3.  **活动分析与建议**: `generation.realtime_activity_monitor`

将这些 YAML 中的 System Prompt 和 User Prompt 模板转换为 JS 模板字符串即可直接使用。
