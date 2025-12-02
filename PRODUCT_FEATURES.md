# MineContext 产品功能设计文档

> 基于纯前端架构（Electron + Node.js）的智能上下文感知应用

---

## 核心价值主张

**"让你的屏幕成为第二大脑"** —— 通过持续的屏幕感知、语义理解和智能分析，帮助用户：

- 自动记录工作/学习轨迹
- 获取实时洞见和建议
- 聚焦特定主题并沉淀知识

---

## 功能模块总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        MineContext 功能架构                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │   功能一      │    │   功能二      │    │   功能三      │              │
│  │  Context     │    │   Smart      │    │   Focus      │              │
│  │  Summary     │    │    Tips      │    │   Mode       │              │
│  │  定时总结推送  │    │  智能洞见系统  │    │  主题聚焦模式  │              │
│  └──────────────┘    └──────────────┘    └──────────────┘              │
│         │                   │                   │                       │
│         └───────────────────┼───────────────────┘                       │
│                             │                                           │
│                    ┌────────┴────────┐                                  │
│                    │   Core Engine   │                                  │
│                    │  截图采集→VLM→合并→存储                             │
│                    └─────────────────┘                                  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 功能一：Context Summary（上下文定时总结）

### 功能概述

每 **15 分钟** 自动分析用户的屏幕活动，生成简洁的工作/学习总结并推送通知。

### 用户场景

> _"我刚刚 15 分钟做了什么？有时候忙起来就忘了时间流向。"_

### 功能详情

| 特性         | 说明                                       |
| :----------- | :----------------------------------------- |
| **触发方式** | 定时触发（默认 15 分钟，可配置 5-60 分钟） |
| **数据来源** | 向量库中最近时间段的 `ProcessedContext`    |
| **输出形式** | 系统通知 / 应用内 Toast / 时间线卡片       |
| **可配置项** | 推送间隔、静默时段、摘要详细程度           |

### 输出示例

```
📊 过去 15 分钟总结
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 主要活动：Python 数据处理开发
📝 内容摘要：在 VS Code 中编写 pandas 数据清洗脚本，
   修复了一个 TypeError，查阅了 DataFrame.merge() 文档
⏱️ 专注度：高（单一任务）
```

### 技术实现要点

```typescript
interface SummaryConfig {
  interval: number; // 推送间隔（毫秒）
  quietHours: [number, number]; // 静默时段 [startHour, endHour]
  detailLevel: "brief" | "normal" | "detailed";
}

interface ContextSummary {
  timeRange: { start: Date; end: Date };
  mainActivity: string;
  summary: string;
  focusScore: number; // 0-100 专注度评分
  categoryDistribution: Record<string, number>;
}
```

---

## 功能二：Smart Tips（智能洞见系统）

### 功能概述

基于用户当前上下文，**主动推送** 聚焦建议、学习资源和相关资讯，帮助用户保持高效和获取有价值信息。

### 用户场景

> _"我已经在这个问题上卡了 30 分钟，有没有什么建议？"_ > _"我正在学 TypeScript，能不能自动推荐一些好的资源？"_

### 子功能 2.1：聚焦建议（Focus Suggestions）

**触发条件**：检测到用户在某项任务上持续一段时间

**输出类型**：

- **深度工作鼓励**：持续专注 25+ 分钟时，肯定用户状态
- **卡顿提醒**：检测到频繁切换或错误界面时，建议休息或换思路
- **优先级建议**：基于 todo 列表和当前活动，提醒更紧急的事项

**输出示例**：

```
💡 洞见
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
你已经在「调试 Python TypeError」上花费 35 分钟。
建议：
• 尝试在 StackOverflow 搜索相关错误信息
• 考虑使用 print debugging 隔离问题范围
• 休息 5 分钟，换个角度思考
```

### 子功能 2.2：学习路径追踪（Learning Path Tracker）

**核心能力**：自动检测学习活动，推断用户正在学习的主题，并推荐学习资源。

**触发条件**：

- 检测到文档/教程类内容（PDF、MDN、官方文档等）
- 同一技术主题出现频率超过阈值
- 用户在该主题上累计时间超过 30 分钟

**检测原理**：基于 `SEMANTIC_CONTEXT` 分布分析

学习追踪**不新增上下文类型**，而是通过分析时间窗口内 `SEMANTIC_CONTEXT` 的分布特征来推断学习行为：

```typescript
interface LearningDetectionConfig {
  timeWindowMinutes: number; // 分析时间窗口，默认 30 分钟
  semanticRatioThreshold: number; // SEMANTIC_CONTEXT 占比阈值，默认 0.5
  topicSimilarityThreshold: number; // 主题相似度阈值，默认 0.6
  minContextCount: number; // 最小上下文数量，默认 3
}

interface DetectedLearningSession {
  isLearning: boolean;
  topic: string | null; // 推断的学习主题（如 "TypeScript"）
  confidence: number; // 置信度 0-100
  duration: number; // 持续时长（秒）
  semanticRatio: number; // SEMANTIC_CONTEXT 实际占比
  topicSimilarity: number; // 主题相似度得分
  relatedContexts: ProcessedContext[];
  subtopics: string[]; // 涉及的子主题
}

class LearningDetector {
  /**
   * 检测是否处于学习状态
   */
  async detect(): Promise<DetectedLearningSession> {
    // 1. 获取时间窗口内的所有上下文
    const allContexts = await this.fetchRecentContexts(timeWindow);

    // 2. 计算 SEMANTIC_CONTEXT 占比
    const semanticContexts = allContexts.filter(
      (c) => c.extracted_data.context_type === "semantic_context"
    );
    const semanticRatio = semanticContexts.length / allContexts.length;

    // 3. 分析主题一致性（基于关键词重叠度）
    const topicAnalysis = this.analyzeTopicConsistency(semanticContexts);

    // 4. 综合判定
    const isLearning = semanticRatio >= 0.5 && topicAnalysis.similarity >= 0.6;

    return { isLearning, topic: topicAnalysis.mainTopic /* ... */ };
  }

  /**
   * 分析主题一致性：基于关键词重叠度
   */
  private analyzeTopicConsistency(contexts: ProcessedContext[]): TopicAnalysis {
    // 统计关键词频率
    const keywordFrequency = new Map<string, number>();
    for (const ctx of contexts) {
      for (const keyword of ctx.extracted_data.keywords) {
        keywordFrequency.set(keyword, (keywordFrequency.get(keyword) || 0) + 1);
      }
    }

    // 找出核心关键词（出现在 50%+ 的上下文中）
    const coreKeywords = [...keywordFrequency.entries()]
      .filter(([_, count]) => count >= contexts.length * 0.5)
      .map(([keyword]) => keyword);

    // 计算相似度：核心关键词覆盖的上下文比例
    const similarity =
      contexts.filter((ctx) =>
        ctx.extracted_data.keywords.some((k) => coreKeywords.includes(k))
      ).length / contexts.length;

    return { similarity, mainTopic: coreKeywords[0], coreKeywords };
  }
}
```

**输出示例**：

```
📚 学习追踪
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
检测到你正在学习：TypeScript
累计时长：2 小时 15 分钟（今日 45 分钟）
已涉及：基础类型、接口定义、泛型入门

💡 建议下一步：
• 学习 TypeScript 高级类型（Utility Types）
• 实践：将一个小型 JS 项目迁移到 TS
```

### 子功能 2.3：Web Search 资讯推送

**触发条件**：用户在某个主题上持续关注超过 **20 分钟**

**数据来源**：

- Tavily API（AI 优化搜索）
- Bing Web Search API
- 特定领域 RSS（如 Hacker News、Dev.to）

**搜索策略**：

```typescript
interface WebSearchService {
  // 从上下文提取搜索关键词
  extractSearchQuery(contexts: ProcessedContext[]): string;

  // 执行搜索
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;

  // 过滤与上下文相关的结果
  filterRelevant(
    results: SearchResult[],
    contexts: ProcessedContext[]
  ): SearchResult[];

  // 生成摘要卡片
  generateDigest(results: SearchResult[]): NewsDigest;
}

interface SearchOptions {
  recency: "day" | "week" | "month"; // 时效性
  type: "news" | "tutorial" | "documentation" | "discussion";
  maxResults: number;
}

interface NewsDigest {
  topic: string;
  items: Array<{
    title: string;
    summary: string;
    url: string;
    source: string;
    publishedAt: Date;
    relevanceScore: number;
  }>;
}
```

**输出示例**：

```
🌐 相关资讯 · Next.js 16
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
你已关注此主题 25 分钟，以下是最新动态：

📰 Next.js 16 正式发布：Cache Components 全面升级
   来源：Vercel Blog · 2 小时前
   摘要：新版本引入了革命性的缓存机制...

📖 迁移指南：从 Next.js 15 到 16
   来源：官方文档 · 1 天前

💬 社区讨论：Cache Components 最佳实践
   来源：Reddit r/nextjs · 5 小时前
```

### 子功能 2.4：学习资源推荐

**与 Web Search 结合**：当检测到学习活动时，自动搜索并推荐优质学习资源。

**推荐类型**：
| 类型 | 说明 | 搜索关键词后缀 |
|:-----|:-----|:---------------|
| **官方文档** | 最权威的参考 | `official documentation` |
| **入门教程** | 适合初学者 | `tutorial for beginners` |
| **实战项目** | 边做边学 | `project tutorial` |
| **视频课程** | 多媒体学习 | `video course` |
| **最佳实践** | 进阶提升 | `best practices` |

**输出示例**：

```
📖 推荐学习资源 · TypeScript
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
基于你的学习进度（中级），推荐以下资源：

🎯 官方文档
   TypeScript Handbook - Utility Types
   https://www.typescriptlang.org/docs/handbook/utility-types.html

🎬 视频教程
   No BS TS - Advanced TypeScript
   https://youtube.com/...

💻 实战项目
   Build a CLI tool with TypeScript
   https://github.com/...
```

### Smart Tips 整体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        SmartTipService                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────┐                                                    │
│  │  TipTrigger     │ ← 事件驱动 / 定时检查                              │
│  │  (触发器)        │                                                    │
│  └────────┬────────┘                                                    │
│           │                                                              │
│           ▼                                                              │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐     │
│  │ FocusSuggestion │    │ LearningTracker │    │  WebSearcher    │     │
│  │   聚焦建议       │    │   学习追踪       │    │   资讯搜索      │     │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘     │
│           │                      │                      │               │
│           └──────────────────────┼──────────────────────┘               │
│                                  │                                       │
│                                  ▼                                       │
│                         ┌─────────────────┐                             │
│                         │  TipAggregator  │                             │
│                         │   (聚合 & 排序)  │                             │
│                         └────────┬────────┘                             │
│                                  │                                       │
│                                  ▼                                       │
│                         ┌─────────────────┐                             │
│                         │  TipPresenter   │                             │
│                         │  (推送 & 展示)   │                             │
│                         └─────────────────┘                             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 数据模型

```typescript
// Tip 类型枚举
enum TipType {
  FOCUS_SUGGESTION = "focus_suggestion", // 聚焦建议
  LEARNING_INSIGHT = "learning_insight", // 学习洞见
  LEARNING_RESOURCE = "learning_resource", // 学习资源
  NEWS_DIGEST = "news_digest", // 资讯推送
  BREAK_REMINDER = "break_reminder", // 休息提醒
  PRIORITY_ALERT = "priority_alert", // 优先级提醒
}

interface SmartTip {
  id: string;
  type: TipType;
  title: string;
  content: string;
  priority: "low" | "medium" | "high";
  relatedTopic?: string; // 关联主题
  relatedContextIds: string[]; // 关联的 ProcessedContext
  actionItems?: TipAction[]; // 可执行操作
  expiresAt?: Date; // 过期时间
  createdAt: Date;
}

interface TipAction {
  label: string;
  type: "link" | "dismiss" | "snooze" | "focus";
  payload: any;
}
```

### SQLite 表结构

```sql
-- 扩展 tips 表
CREATE TABLE tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,               -- TipType 枚举值
    title TEXT,
    content TEXT NOT NULL,
    priority TEXT DEFAULT 'medium',
    related_topic TEXT,               -- 关联主题（如 "TypeScript"）
    related_context_ids TEXT,         -- JSON 数组
    action_items TEXT,                -- JSON 数组
    is_read BOOLEAN DEFAULT 0,
    is_dismissed BOOLEAN DEFAULT 0,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 学习会话表（基于 SEMANTIC_CONTEXT 分析自动检测）
CREATE TABLE learning_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,              -- 推断的学习主题
    duration INTEGER NOT NULL,        -- 本次时长（秒）
    semantic_ratio REAL,              -- SEMANTIC_CONTEXT 占比
    topic_similarity REAL,            -- 主题相似度
    subtopics TEXT,                   -- JSON: 涉及的子主题
    context_ids TEXT,                 -- JSON: 关联的上下文 IDs
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 学习主题汇总视图（便于查询累计时长）
CREATE VIEW learning_topics_summary AS
SELECT
    topic,
    SUM(duration) as total_duration,
    COUNT(*) as session_count,
    MIN(created_at) as first_seen,
    MAX(created_at) as last_seen
FROM learning_sessions
GROUP BY topic;

-- 索引
CREATE INDEX idx_tips_type ON tips (type);
CREATE INDEX idx_tips_created ON tips (created_at);
CREATE INDEX idx_learning_sessions_topic ON learning_sessions (topic);
CREATE INDEX idx_learning_sessions_time ON learning_sessions (created_at);
```

---

## 功能三：Focus Mode（主题聚焦模式）

### 功能概述

用户可以**主动设定**一个聚焦主题（如"学习 Next.js 16"），系统会自动收集所有相关上下文，并维护一份持续更新的知识文档。

### 用户场景

> _"我最近在学 Next.js 16，希望把所有看过的内容、遇到的问题、学到的东西都整理成一份文档。"_

### 与 Smart Tips 的区别

| 维度         | Smart Tips (学习追踪) | Focus Mode     |
| :----------- | :-------------------- | :------------- |
| **触发方式** | 自动检测              | 用户主动创建   |
| **主题来源** | 系统推断              | 用户指定       |
| **输出形式** | 通知推送              | 持续更新的文档 |
| **深度**     | 轻量提示              | 完整知识沉淀   |
| **时效性**   | 实时/短期             | 长期积累       |

### 功能详情

#### 3.1 创建聚焦主题

**用户输入**：

- 主题名称（必填）：如 "学习 Next.js 16"
- 补充描述（可选）：如 "重点关注 App Router 和 Cache Components"
- 关联关键词（可选）：如 ["nextjs", "react", "ssr", "cache"]

**系统处理**：

1. 使用 LLM 扩展关键词
2. 生成主题 Embedding
3. 创建初始文档框架

#### 3.2 自动关联上下文

每当新的 `ProcessedContext` 入库时：

1. 计算与所有活跃 Focus Topic 的相似度
2. 超过阈值（默认 0.7）则建立关联
3. 更新主题的统计信息

```typescript
interface FocusTopicMatcher {
  // 匹配新上下文
  matchContext(context: ProcessedContext): FocusMatch[];

  // 返回匹配结果
  interface FocusMatch {
    topicId: number;
    similarity: number;
    matchedKeywords: string[];
  }
}
```

#### 3.3 智能文档生成

**生成时机**：

- 定时生成（每 2 小时检查是否有新内容）
- 用户手动触发
- 关联上下文数量达到阈值

**文档结构**：

```markdown
# Focus: 学习 Next.js 16

> 创建于 2025-11-29 | 最后更新 2025-11-30 15:30
> 累计关注时长：4 小时 32 分钟 | 关联上下文：28 条

## 📋 概览

基于你最近的学习活动，自动整理的 Next.js 16 学习笔记。

## 🎯 核心概念

### App Router

- 文件系统路由，每个文件夹代表一个路由段
- 支持 layout.tsx、page.tsx、loading.tsx 等约定文件
- [来源：11-29 14:30 阅读官方文档]

### Cache Components

- 新的缓存机制，使用 "use cache" 指令
- 支持 cacheLife() 配置缓存策略
- [来源：11-30 10:15 观看教程视频]

## 📝 学习进度

- [x] 基础路由概念
- [x] 数据获取方式
- [ ] 缓存策略深入
- [ ] 部署优化

## 🐛 遇到的问题

### TypeError: Cannot read property 'params'

- 时间：11-29 16:45
- 原因：Next.js 16 中 params 变为 Promise
- 解决：使用 await params 或 use(params)

## 💡 收获与洞见

- Server Components 默认，需要客户端交互时才用 "use client"
- 新的 Turbopack 编译速度提升明显

## 📚 参考资源

- Next.js 16 官方文档
- Vercel Blog: What's new in Next.js 16
- YouTube: Lee Robinson - Next.js 16 Deep Dive

---

_此文档由 MineContext 自动生成和维护_
```

### 数据模型

```typescript
interface FocusTopic {
  id: number;
  title: string; // "学习 Next.js 16"
  description?: string;
  keywords: string[];
  embedding: number[]; // 1536 维向量
  isActive: boolean;
  documentId?: number; // 关联的 vaults 文档 ID
  stats: FocusStats;
  createdAt: Date;
  updatedAt: Date;
}

interface FocusStats {
  totalDuration: number; // 累计关注时长（秒）
  contextCount: number; // 关联上下文数量
  lastActivityAt: Date; // 最后活动时间
}

interface FocusDocument {
  overview: string;
  concepts: ConceptSection[];
  progress: ProgressItem[];
  problems: ProblemRecord[];
  insights: string[];
  resources: ResourceLink[];
}
```

### SQLite 表结构

```sql
-- 聚焦主题表（用户主动创建）
CREATE TABLE focus_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    keywords TEXT,                    -- JSON 数组
    embedding BLOB,                   -- 向量数据
    is_active BOOLEAN DEFAULT 1,
    document_id INTEGER,              -- 关联 vaults 表
    total_duration INTEGER DEFAULT 0,
    context_count INTEGER DEFAULT 0,
    last_activity_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (document_id) REFERENCES vaults (id)
);

-- 主题-上下文关联表
CREATE TABLE focus_topic_contexts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    context_id TEXT NOT NULL,         -- ProcessedContext UUID
    similarity REAL,                  -- 相似度分数
    matched_keywords TEXT,            -- JSON: 匹配的关键词
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES focus_topics (id),
    UNIQUE (topic_id, context_id)
);

-- 索引
CREATE INDEX idx_focus_topics_active ON focus_topics (is_active);
CREATE INDEX idx_focus_contexts_topic ON focus_topic_contexts (topic_id);
```

---

## 功能交互矩阵

| 功能                 | 数据输入                 | 处理逻辑        | 数据输出      | 用户交互  |
| :------------------- | :----------------------- | :-------------- | :------------ | :-------- |
| **Context Summary**  | ProcessedContext (15min) | LLM 摘要生成    | 系统通知      | 查看/忽略 |
| **Focus Suggestion** | ProcessedContext + todo  | LLM 分析建议    | Tips 推送     | 采纳/忽略 |
| **Learning Tracker** | ProcessedContext         | 模式识别 + LLM  | Tips + 进度卡 | 确认/调整 |
| **Web Search**       | 长时关注主题             | API 搜索 + 过滤 | 资讯卡片      | 阅读/收藏 |
| **Focus Mode**       | 用户输入 + Context       | 向量匹配 + LLM  | Markdown 文档 | 编辑/导出 |

---

## 配置项汇总

```yaml
# config/features.yaml

context_summary:
  enabled: true
  interval_minutes: 15 # 推送间隔
  quiet_hours: [23, 7] # 静默时段
  detail_level: normal # brief | normal | detailed

smart_tips:
  enabled: true

  focus_suggestion:
    enabled: true
    stuck_threshold_minutes: 20 # 卡顿检测阈值
    switch_threshold: 3 # 切换次数阈值（5分钟内）

  learning_tracker:
    enabled: true
    detection_threshold: 0.6 # 学习活动检测置信度
    min_duration_minutes: 30 # 最小累计时长

  web_search:
    enabled: true
    provider: tavily # tavily | bing | serp
    api_key: ${SEARCH_API_KEY}
    trigger_duration_minutes: 20 # 触发搜索的持续时长
    max_results: 5
    recency: week # day | week | month

focus_mode:
  enabled: true
  similarity_threshold: 0.7 # 上下文关联阈值
  document_update_interval_hours: 2 # 文档更新间隔
  auto_keyword_expansion: true # LLM 自动扩展关键词
```

---

## 技术依赖

| 组件         | 用途           | 推荐方案              |
| :----------- | :------------- | :-------------------- |
| **定时调度** | 定时任务触发   | `node-schedule`       |
| **向量计算** | 相似度匹配     | `Voyager` (WASM)      |
| **LLM 调用** | 摘要/分析/生成 | `openai` SDK          |
| **Web 搜索** | 资讯获取       | Tavily API            |
| **通知推送** | 系统通知       | Electron Notification |
| **数据存储** | 结构化数据     | `better-sqlite3`      |

---

## 后续扩展方向

- [ ] 效率仪表盘（Productivity Dashboard）
- [ ] 知识图谱可视化（Knowledge Graph）
- [ ] 跨设备同步
- [ ] 团队协作版本
- [ ] 插件系统

---

_文档版本：v1.0 | 更新日期：2025-11-29_
