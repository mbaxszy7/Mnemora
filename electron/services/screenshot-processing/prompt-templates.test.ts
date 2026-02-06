import { describe, it, expect, vi, beforeEach } from "vitest";

let mockLang = "en";

vi.mock("../i18n-service", () => ({
  mainI18n: {
    getCurrentLanguage: () => mockLang,
  },
}));

vi.mock("../context-rules-store", () => ({
  contextRulesStore: {
    getSnapshot: vi.fn(() => ({ enabled: false, markdown: "", updatedAt: null })),
  },
}));

import { promptTemplates } from "./prompt-templates";
import { contextRulesStore } from "../context-rules-store";

const vlmArgs = {
  count: 2,
  localTime: "2024-01-01 12:00:00",
  timeZone: "Asia/Shanghai",
  utcOffset: "+08:00",
  now: new Date("2024-01-01T12:00:00Z"),
  nowTs: 1704110400000,
  todayStart: 1704067200000,
  todayEnd: 1704153599000,
  yesterdayStart: 1703980800000,
  yesterdayEnd: 1704067199000,
  weekAgo: 1703505600000,
  screenshotMetaJson: "[]",
  appCandidatesJson: "[]",
};

const threadArgs = {
  activeThreadsJson: "[]",
  threadRecentNodesJson: "{}",
  batchNodesJson: "[]",
  localTime: "2024-01-01 12:00:00",
  timeZone: "Asia/Shanghai",
  now: new Date("2024-01-01T12:00:00Z"),
  nowTs: 1704110400000,
  todayStart: 1704067200000,
  todayEnd: 1704153599000,
  yesterdayStart: 1703980800000,
  yesterdayEnd: 1704067199000,
  weekAgo: 1703505600000,
  appCandidatesJson: "[]",
};

const briefArgs = {
  threadJson: "{}",
  evidenceJson: "[]",
  appCandidatesJson: "[]",
};

describe("promptTemplates", () => {
  beforeEach(() => {
    mockLang = "en";
    vi.mocked(contextRulesStore.getSnapshot).mockReturnValue({
      enabled: false,
      markdown: "",
      updatedAt: null,
    });
  });

  describe("VLM prompts", () => {
    it("returns EN system prompt by default", () => {
      const prompt = promptTemplates.getVLMSystemPrompt();
      expect(prompt).toContain("expert screenshot analyst");
    });

    it("returns ZH system prompt when lang is zh-CN", () => {
      mockLang = "zh-CN";
      const prompt = promptTemplates.getVLMSystemPrompt();
      expect(prompt).toContain("截图分析师");
    });

    it("returns EN user prompt with interpolated args", () => {
      const prompt = promptTemplates.getVLMUserPrompt(vlmArgs);
      expect(prompt).toContain("2 screenshots");
      expect(prompt).toContain("Asia/Shanghai");
    });

    it("returns ZH user prompt when lang is zh-CN", () => {
      mockLang = "zh-CN";
      const prompt = promptTemplates.getVLMUserPrompt(vlmArgs);
      expect(prompt).toContain("2 张截图");
    });
  });

  describe("Thread LLM prompts", () => {
    it("returns EN system prompt", () => {
      const prompt = promptTemplates.getThreadLlmSystemPrompt();
      expect(prompt).toContain("activity thread analyzer");
    });

    it("returns ZH system prompt when lang is zh-CN", () => {
      mockLang = "zh-CN";
      const prompt = promptTemplates.getThreadLlmSystemPrompt();
      expect(prompt).toContain("活动线索分析器");
    });

    it("returns user prompt with interpolated time context", () => {
      const prompt = promptTemplates.getThreadLlmUserPrompt(threadArgs);
      expect(prompt).toContain("Asia/Shanghai");
    });

    it("returns ZH user prompt when lang is zh-CN", () => {
      mockLang = "zh-CN";
      const prompt = promptTemplates.getThreadLlmUserPrompt(threadArgs);
      expect(prompt).toContain("分析以下批次");
    });
  });

  describe("Thread Brief prompts", () => {
    it("returns EN system prompt", () => {
      const prompt = promptTemplates.getThreadBriefSystemPrompt();
      expect(prompt).toContain("concise brief report");
    });

    it("returns ZH system prompt when lang is zh-CN", () => {
      mockLang = "zh-CN";
      const prompt = promptTemplates.getThreadBriefSystemPrompt();
      expect(prompt).toContain("本线索简报");
    });

    it("returns user prompt with thread data", () => {
      const prompt = promptTemplates.getThreadBriefUserPrompt(briefArgs);
      expect(prompt).toContain("## Thread");
    });

    it("returns ZH user prompt when lang is zh-CN", () => {
      mockLang = "zh-CN";
      const prompt = promptTemplates.getThreadBriefUserPrompt(briefArgs);
      expect(prompt).toContain("## 线索");
    });
  });

  describe("Query Understanding prompts", () => {
    it("returns EN system prompt", () => {
      const prompt = promptTemplates.getQueryUnderstandingSystemPrompt();
      expect(prompt).toContain("search query analyzer");
    });

    it("returns ZH when lang is zh-CN", () => {
      mockLang = "zh-CN";
      const prompt = promptTemplates.getQueryUnderstandingSystemPrompt();
      expect(prompt).toContain("搜索查询分析器");
    });

    it("returns user prompt with query", () => {
      const prompt = promptTemplates.getQueryUnderstandingUserPrompt({
        nowDate: new Date("2024-01-01T12:00:00Z"),
        nowTs: 1704110400000,
        timeZone: "UTC",
        todayStart: 1704067200000,
        todayEnd: 1704153599000,
        yesterdayStart: 1703980800000,
        yesterdayEnd: 1704067199000,
        weekAgo: 1703505600000,
        canonicalCandidatesJson: "[]",
        userQuery: "what did I do yesterday",
      });
      expect(prompt).toContain("what did I do yesterday");
    });
  });

  describe("Answer Synthesis prompts", () => {
    it("returns EN system prompt", () => {
      const prompt = promptTemplates.getAnswerSynthesisSystemPrompt();
      expect(prompt).toContain("answer synthesizer");
    });

    it("returns ZH when lang is zh-CN", () => {
      mockLang = "zh-CN";
      const prompt = promptTemplates.getAnswerSynthesisSystemPrompt();
      expect(prompt).toContain("答案合成器");
    });
  });

  describe("Activity Summary prompts", () => {
    it("returns EN system prompt", () => {
      const prompt = promptTemplates.getActivitySummarySystemPrompt();
      expect(prompt).toContain("activity analysis assistant");
    });

    it("returns ZH when lang is zh-CN", () => {
      mockLang = "zh-CN";
      const prompt = promptTemplates.getActivitySummarySystemPrompt();
      expect(prompt).toContain("活动分析助手");
    });

    it("returns user prompt with window times", () => {
      const prompt = promptTemplates.getActivitySummaryUserPrompt({
        nowTs: 1704110400000,
        todayStart: 1704067200000,
        todayEnd: 1704153599000,
        yesterdayStart: 1703980800000,
        yesterdayEnd: 1704067199000,
        weekAgo: 1703505600000,
        windowStart: 1704067200000,
        windowEnd: 1704068400000,
        windowStartLocal: "00:00",
        windowEndLocal: "00:20",
        contextNodesJson: "[]",
        longThreadsJson: "[]",
        statsJson: "{}",
      });
      expect(prompt).toContain("00:00");
      expect(prompt).toContain("00:20");
    });
  });

  describe("Event Details prompts", () => {
    it("returns EN system prompt", () => {
      const prompt = promptTemplates.getEventDetailsSystemPrompt();
      expect(prompt).toContain("long-running task context synthesis");
    });

    it("returns ZH when lang is zh-CN", () => {
      mockLang = "zh-CN";
      const prompt = promptTemplates.getEventDetailsSystemPrompt();
      expect(prompt).toContain("长时间运行任务");
    });

    it("returns user prompt with json", () => {
      const prompt = promptTemplates.getEventDetailsUserPrompt({
        userPromptJson: '{"test": true}',
      });
      expect(prompt).toContain('{"test": true}');
    });
  });

  describe("context rules injection", () => {
    it("appends context rules when enabled", () => {
      vi.mocked(contextRulesStore.getSnapshot).mockReturnValue({
        enabled: true,
        markdown: "Always use formal English.",
        updatedAt: Date.now(),
      });
      const prompt = promptTemplates.getVLMSystemPrompt();
      expect(prompt).toContain("User Context Rules");
      expect(prompt).toContain("Always use formal English.");
    });

    it("does not append rules when disabled", () => {
      vi.mocked(contextRulesStore.getSnapshot).mockReturnValue({
        enabled: false,
        markdown: "Some rules",
        updatedAt: Date.now(),
      });
      const prompt = promptTemplates.getVLMSystemPrompt();
      expect(prompt).not.toContain("User Context Rules");
    });

    it("does not append rules when markdown is empty", () => {
      vi.mocked(contextRulesStore.getSnapshot).mockReturnValue({
        enabled: true,
        markdown: "   ",
        updatedAt: Date.now(),
      });
      const prompt = promptTemplates.getVLMSystemPrompt();
      expect(prompt).not.toContain("User Context Rules");
    });
  });
});
