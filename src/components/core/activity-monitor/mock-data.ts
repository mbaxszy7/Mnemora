// Mock data for Activity Monitor (24h timeline with 20min windows)

import type { TimeWindow, WindowSummary, ActivityEvent } from "./types";

// Generate 24h timeline with 20min windows (72 windows total)
function generateMockTimeline(): TimeWindow[] {
  const now = Date.now();
  const windows: TimeWindow[] = [];

  // Round down to current 20-min boundary
  const currentMinutes = new Date(now).getMinutes();
  const roundedMinutes = Math.floor(currentMinutes / 20) * 20;
  const currentWindowEnd = new Date(now);
  currentWindowEnd.setMinutes(roundedMinutes, 0, 0);

  const windowDuration = 20 * 60 * 1000; // 20 minutes in ms
  const windowCount = 72; // 24 hours

  const mockTitles = [
    "深度编码：完善 VLM 处理流程",
    "代码审查与重构讨论",
    "团队周会同步",
    "研究 framer-motion 动画",
    "午餐休息",
    "调试 Electron IPC 问题",
    "文档编写：API 设计说明",
    "咖啡休息 ☕",
    "阅读技术文章",
    "设计系统架构图",
    "处理 Slack 消息",
    "浏览 GitHub Issues",
    "代码提交与 PR 创建",
    "测试用例编写",
    "项目规划与任务拆分",
    "研究竞品功能",
    "数据库迁移处理",
    "UI 组件开发",
  ];

  const mockApps = [
    ["VS Code", "Terminal"],
    ["Chrome", "Notion"],
    ["Slack", "Zoom"],
    ["VS Code", "Chrome", "Terminal"],
    ["Arc", "Spotify"],
    ["VS Code", "GitHub Desktop"],
    ["Notion", "Figma"],
    ["Arc", "Twitter"],
    ["VS Code", "Terminal", "Chrome"],
    ["Figma", "Arc"],
    ["Slack", "Notion"],
    ["Chrome", "VS Code"],
  ];

  for (let i = 0; i < windowCount; i++) {
    const windowEnd = currentWindowEnd.getTime() - i * windowDuration;
    const windowStart = windowEnd - windowDuration;

    windows.push({
      id: i + 1,
      windowStart,
      windowEnd,
      title: mockTitles[i % mockTitles.length],
      status: "succeeded",
      stats: {
        topApps: mockApps[i % mockApps.length],
        topEntities: [],
        nodeCount: Math.floor(Math.random() * 20) + 5,
        screenshotCount: Math.floor(Math.random() * 10) + 2,
        threadCount: 1,
      },
    });
  }

  return windows;
}

// Generate mock events
function generateMockEvents(): ActivityEvent[] {
  const now = Date.now();
  const events: ActivityEvent[] = [
    {
      id: 1,
      eventKey: "coding-session-1",
      title: "VLM 处理模块开发",
      kind: "coding",
      startTs: now - 2 * 60 * 60 * 1000,
      endTs: now - 30 * 60 * 1000,
      durationMs: 90 * 60 * 1000, // 90 minutes
      isLong: true,
      confidence: 95,
      importance: 9,
      threadId: "thread-1",
      nodeIds: [101, 102],
      detailsStatus: "succeeded",
      details: `## VLM 处理模块开发详情

### 主要工作
- 重构了 \`vlm-processor.ts\` 的批处理逻辑
- 优化了截图分析的并发处理
- 添加了错误重试机制

### 涉及文件
- \`electron/services/screenshot-processing/vlm-processor.ts\`
- \`electron/services/screenshot-processing/reconcile-loop.ts\`
- \`electron/database/schema.ts\`

### 下一步
- 添加单元测试覆盖
- 性能压测`,
    },
    {
      id: 2,
      eventKey: "meeting-1",
      title: "产品周会",
      kind: "meeting",
      startTs: now - 4 * 60 * 60 * 1000,
      endTs: now - 3 * 60 * 60 * 1000,
      durationMs: 60 * 60 * 1000, // 60 minutes
      isLong: true,
      confidence: 90,
      importance: 8,
      threadId: "thread-2",
      nodeIds: [103],
      detailsStatus: "succeeded",
      details: `## 产品周会要点

### 讨论内容
- Milestone 6 进度同步
- Activity Monitor 设计评审
- 下周优先级排序

### 决策
- 确定 20min 窗口划分方案
- 长事件阈值定为 30min`,
    },
    {
      id: 3,
      eventKey: "browse-1",
      title: "技术调研：framer-motion",
      kind: "browse",
      startTs: now - 5 * 60 * 60 * 1000,
      endTs: now - 4.5 * 60 * 60 * 1000,
      durationMs: 30 * 60 * 1000,
      isLong: true,
      confidence: 85,
      importance: 6,
      threadId: null,
      nodeIds: null,
      details: null,
      detailsStatus: "pending",
    },
    {
      id: 4,
      eventKey: "focus-1",
      title: "文档编写",
      kind: "focus",
      startTs: now - 6 * 60 * 60 * 1000,
      endTs: now - 5.5 * 60 * 60 * 1000,
      durationMs: 30 * 60 * 1000,
      isLong: true,
      confidence: 80,
      importance: 7,
      threadId: null,
      nodeIds: null,
      details: null,
      detailsStatus: "pending",
    },
    {
      id: 5,
      eventKey: "break-1",
      title: "午餐休息",
      kind: "break",
      startTs: now - 7 * 60 * 60 * 1000,
      endTs: now - 6 * 60 * 60 * 1000,
      durationMs: 60 * 60 * 1000,
      isLong: true,
      confidence: 95,
      importance: 3,
      threadId: null,
      nodeIds: null,
      details: null,
      detailsStatus: "pending",
    },
  ];

  return events;
}

// Generate summary for a specific window
export function getMockSummary(windowStart: number, windowEnd: number): WindowSummary {
  const events = mockEvents.filter((e) => e.startTs < windowEnd && e.endTs > windowStart);

  const titles = ["深度编码：VLM 模块优化", "会议与协作时段", "技术文档整理", "休息与恢复"];

  const summaryContent = `## Core Tasks & Projects
- 持续开发 VLM 处理模块，优化批处理逻辑和错误重试机制 (node: ctx-001)
- 重构 reconcile-loop 状态机，支持多任务并发调度 (node: ctx-002)
- 完善 Activity Monitor 前端组件，添加 framer-motion 动画 (node: ctx-003)
- 优化截图去重算法，提升 pHash 计算效率 (node: ctx-004)

## Key Discussion & Decisions
- 确定 20min 窗口划分方案，对齐本地时区边界，避免跨天问题 (node: mtg-001)
- 长事件阈值定为 30min，由后端规则计算而非 LLM 判断 (node: mtg-002)
- Summary 生成使用严格 JSON schema，防止 LLM 幻觉输出 (node: mtg-003)

## Documents
- [VLM Processor API Doc](file:///docs/vlm-api.md) — 视觉语言模型处理器接口文档 (node: doc-001)
- [Activity Monitor Design](file:///docs/am-design.md) — Activity Monitor 界面设计规范 (node: doc-002)
- [Context Graph Schema](file:///docs/context-graph.md) — 上下文图谱数据库设计 (node: doc-003)

## Next Steps
- 添加 Activity Monitor 单元测试覆盖，确保组件稳定性 (node: task-001)
- 部署 staging 环境验证，进行端到端测试 (node: task-002)
- 完成 event details 的 lazy on-demand 生成逻辑 (node: task-003)`;

  return {
    windowStart,
    windowEnd,
    title: titles[Math.floor(Math.random() * titles.length)],
    summary: summaryContent,
    highlights: ["VLM 处理优化完成 ✓", "周会决策已同步", "前端组件开发中"],
    stats: {
      topApps: ["VS Code", "Chrome", "Terminal"],
      topEntities: [],
      nodeCount: 15,
      screenshotCount: 8,
      threadCount: 1,
    },
    events,
  };
}

export const mockTimeline = generateMockTimeline();
export const mockEvents = generateMockEvents();
