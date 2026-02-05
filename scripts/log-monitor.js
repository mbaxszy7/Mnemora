#!/usr/bin/env node
/**
 * Mnemora Log Monitor
 * 持续监控并分析 main.log 日志文件
 */

import fs from "fs";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { spawn } from "child_process";

const LOG_FILE = "/Users/yanzheyu/.mnemora/logs/main.log";
const STATS_INTERVAL = 30000; // 30秒统计一次
const TOP_ERRORS_COUNT = 5;

// ANSI 颜色
const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

// 日志级别颜色映射
const LEVEL_COLORS = {
  FATAL: COLORS.red + COLORS.bright,
  ERROR: COLORS.red,
  WARN: COLORS.yellow,
  INFO: COLORS.green,
  DEBUG: COLORS.gray,
  TRACE: COLORS.gray,
};

// 统计数据
const stats = {
  totalLines: 0,
  levelCounts: { FATAL: 0, ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, TRACE: 0 },
  moduleCounts: {},
  recentErrors: [],
  recentWarnings: [],
  startTime: Date.now(),
};

// 解析日志行
function parseLogLine(line) {
  // 格式: [2026-02-01 15:39:27.392 +0800] LEVEL: [module] message
  const match = line.match(
    /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ [+-]\d{4})\] (\w+): \[(.+?)\] (.+)$/
  );
  if (!match) return null;

  return {
    timestamp: match[1],
    level: match[2],
    module: match[3],
    message: match[4],
    raw: line,
  };
}

// 格式化输出日志行
function formatLogLine(parsed) {
  const levelColor = LEVEL_COLORS[parsed.level] || COLORS.reset;
  const time = parsed.timestamp.split(" ")[1].split(".")[0]; // 只显示时分秒
  return `${COLORS.gray}[${time}]${COLORS.reset} ${levelColor}${parsed.level.padEnd(5)}${COLORS.reset} ${COLORS.cyan}[${parsed.module}]${COLORS.reset} ${parsed.message}`;
}

// 更新统计
function updateStats(parsed) {
  stats.totalLines++;

  // 级别统计
  if (stats.levelCounts[parsed.level] !== undefined) {
    stats.levelCounts[parsed.level]++;
  }

  // 模块统计
  stats.moduleCounts[parsed.module] = (stats.moduleCounts[parsed.module] || 0) + 1;

  // 收集最近的错误和警告
  if (parsed.level === "ERROR") {
    stats.recentErrors.unshift({ ...parsed, time: Date.now() });
    if (stats.recentErrors.length > 10) stats.recentErrors.pop();
  }
  if (parsed.level === "WARN") {
    stats.recentWarnings.unshift({ ...parsed, time: Date.now() });
    if (stats.recentWarnings.length > 10) stats.recentWarnings.pop();
  }
}

// 打印统计信息
function printStats() {
  const runtime = Math.floor((Date.now() - stats.startTime) / 1000);
  const minutes = Math.floor(runtime / 60);
  const seconds = runtime % 60;

  console.log("\n" + "=".repeat(80));
  console.log(
    `${COLORS.bright}📊 日志监控统计${COLORS.reset} (运行时间: ${minutes}分${seconds}秒)`
  );
  console.log("=".repeat(80));

  // 日志级别统计
  console.log(`\n${COLORS.bright}日志级别分布:${COLORS.reset}`);
  const total = stats.totalLines;
  for (const [level, count] of Object.entries(stats.levelCounts)) {
    if (count > 0) {
      const pct = ((count / total) * 100).toFixed(1);
      const color = LEVEL_COLORS[level] || COLORS.reset;
      console.log(
        `  ${color}${level.padEnd(5)}${COLORS.reset}: ${count.toString().padStart(6)} (${pct}%)`
      );
    }
  }
  console.log(`  ${COLORS.bright}总计:${COLORS.reset} ${total}`);

  // 最活跃的模块
  console.log(`\n${COLORS.bright}最活跃的模块 (Top 5):${COLORS.reset}`);
  const sortedModules = Object.entries(stats.moduleCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  for (const [module, count] of sortedModules) {
    console.log(`  ${COLORS.cyan}${module}${COLORS.reset}: ${count}`);
  }

  // 最近的错误
  if (stats.recentErrors.length > 0) {
    console.log(
      `\n${COLORS.red}${COLORS.bright}最近的错误 (${stats.recentErrors.length}条):${COLORS.reset}`
    );
    stats.recentErrors.slice(0, TOP_ERRORS_COUNT).forEach((err) => {
      const time = err.timestamp.split(" ")[1].split(".")[0];
      console.log(
        `  ${COLORS.gray}[${time}]${COLORS.reset} ${COLORS.cyan}[${err.module}]${COLORS.reset} ${err.message.substring(0, 80)}`
      );
    });
  }

  // 最近的警告
  if (stats.recentWarnings.length > 0) {
    console.log(
      `\n${COLORS.yellow}${COLORS.bright}最近的警告 (${stats.recentWarnings.length}条):${COLORS.reset}`
    );
    stats.recentWarnings.slice(0, TOP_ERRORS_COUNT).forEach((warn) => {
      const time = warn.timestamp.split(" ")[1].split(".")[0];
      console.log(
        `  ${COLORS.gray}[${time}]${COLORS.reset} ${COLORS.cyan}[${warn.module}]${COLORS.reset} ${warn.message.substring(0, 80)}`
      );
    });
  }

  console.log("=".repeat(80) + "\n");
}

// 监控模式 - 使用 tail -f
function startTailMonitor() {
  console.log(`${COLORS.green}🚀 启动日志监控: ${LOG_FILE}${COLORS.reset}`);
  console.log(`${COLORS.gray}按 Ctrl+C 停止监控${COLORS.reset}\n`);

  // 先打印统计信息
  printStats();

  // 启动 tail 进程
  const tail = spawn("tail", ["-n", "0", "-f", LOG_FILE]);

  tail.stdout.on("data", (data) => {
    const lines = data
      .toString()
      .split("\n")
      .filter((line) => line.trim());

    for (const line of lines) {
      const parsed = parseLogLine(line);
      if (parsed) {
        updateStats(parsed);
        // 只打印 ERROR 和 WARN 级别的日志，其他级别静默处理
        if (parsed.level === "ERROR" || parsed.level === "WARN") {
          console.log(formatLogLine(parsed));
        }
      }
    }
  });

  tail.stderr.on("data", (data) => {
    console.error(`${COLORS.red}tail error: ${data}${COLORS.reset}`);
  });

  tail.on("close", (code) => {
    console.log(`\n${COLORS.yellow}tail 进程退出，代码: ${code}${COLORS.reset}`);
    process.exit(0);
  });

  // 定期打印统计
  const statsTimer = setInterval(printStats, STATS_INTERVAL);

  // 处理退出
  process.on("SIGINT", () => {
    console.log(`\n${COLORS.yellow}正在停止监控...${COLORS.reset}`);
    clearInterval(statsTimer);
    tail.kill();
    printStats();
    process.exit(0);
  });
}

// 分析历史日志
async function analyzeHistory(limit = 100) {
  console.log(`${COLORS.blue}📁 分析历史日志 (最近 ${limit} 条)...${COLORS.reset}\n`);

  const fileStream = createReadStream(LOG_FILE);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const lines = [];
  for await (const line of rl) {
    lines.push(line);
    if (lines.length > limit) lines.shift();
  }

  for (const line of lines) {
    const parsed = parseLogLine(line);
    if (parsed) {
      updateStats(parsed);
    }
  }

  printStats();
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || "monitor";

  // 检查日志文件是否存在
  if (!fs.existsSync(LOG_FILE)) {
    console.error(`${COLORS.red}错误: 日志文件不存在: ${LOG_FILE}${COLORS.reset}`);
    process.exit(1);
  }

  if (mode === "analyze") {
    const limit = parseInt(args[1]) || 1000;
    await analyzeHistory(limit);
  } else if (mode === "monitor") {
    // 先分析最近的历史记录
    await analyzeHistory(500);
    // 开始实时监控
    startTailMonitor();
  } else {
    console.log(`
用法: node log-monitor.js [mode] [options]

模式:
  monitor  - 实时监控日志文件 (默认)
  analyze  - 分析历史日志

示例:
  node log-monitor.js                    # 启动实时监控
  node log-monitor.js monitor            # 启动实时监控
  node log-monitor.js analyze 1000       # 分析最近1000条日志
    `);
  }
}

main().catch(console.error);
