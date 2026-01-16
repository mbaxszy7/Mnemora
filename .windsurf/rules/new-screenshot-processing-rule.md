---
trigger: always_on
---

Activation Mode

Always On
This rule will always be applied
Content

# Screenshot Processing — Milestone Implementation Plan

> 基于：
>
> - [Implementation plan](alpha-implementation-plan.md)
> - [Prompt templates](alpha-prompt-templates.md)

---

## 命名与目录迁移规则（必须遵守）

本计划中的 “alpha” **只代表临时目录名**，不代表任何代码层面的命名。

- **[临时目录]** 新实现将放在 `screenshot-processing-alpha/` 目录下（用于与旧版 `screenshot-processing/` 并存开发）。
- **[文档路径口径]** 本文中出现的代码路径（例如 `electron/services/screenshot-processing/...`）默认以**最终目录名** `screenshot-processing/` 为准；在实现阶段可先落在 `screenshot-processing-alpha/` 下，待全部 Milestones 完成后通过目录重命名完成对齐。
- **[最终目录]** 全部 Milestones 完成后：
  - 删除旧的 `screenshot-processing/` 目录（旧 pipeline 全量移除）
  - 将 `screenshot-processing-alpha/` 重命名为 `screenshot-processing/`
- **[代码命名禁用 alpha]** 在代码设计与命名中，禁止出现 `alpha` 字样，包括但不限于：
  - 模块/类/函数/类型/接口名（禁止 `Alpha*`）
  - IPC channel 名称
  - DB 表/字段/JSON key
  - config key（例如 `processingConfig.*`）
  - monitoring/queue/status 相关字段与 UI label
- **[说明]** 本文引用的权威文档文件名包含 `alpha`（如 `docs/alpha-implementation-plan.md`、`docs/alpha-prompt-templates.md`），这是文档命名，不应反向影响代码命名。

## 命名与字段转换规则（强制）

为避免输入/输出/入库的字段命名不一致（snake_case vs camelCase）导致漏字段、错字段，必须遵守：

- **LLM 边界命名**：所有与 LLM 直接交互的 JSON（prompt 中嵌入的 metadata、以及 LLM 输出）必须使用 **snake_case**，并严格对齐 `docs/alpha-prompt-templates.md`。
- **内部命名**：代码内部类型（service/scheduler/DB 入库 payload）必须使用 **camelCase**。
- **单点转换**：`snake_case → camelCase` 的转换 **只能存在一个地方**：
  - `electron/services/screenshot-processing(-alpha)/schemas.ts` 的 `VLMOutputProcessedSchema.transform(...)`
  - 禁止在 scheduler / persistence 层手写字段映射（例如 [BatchVlmScheduler.persistResults()](cci:1://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing-alpha/schedulers/batch-vlm-scheduler.ts:281:2-384:3) 逐字段转换）
- **类型出口**：scheduler/DB 入库必须只依赖 processed 后的 [VLMContextNode](cci:2://file:///c:/frank-repos/Mnemora/electron/services/screenshot-processing-alpha/schemas.ts:152:0-152:56)（camelCase），不得在下游继续接触 raw LLM schema。

## 核心决策（已确认）

- `context_edges` 表物理删除/停用（不再写入/不再读取）
- 历史数据不迁移，新 pipeline 重新开始
- 本地 OCR 为准（VLM 不再产出 `ocr_text`）

---

## 目标与 DoD（Definition of Done）

- Capture → screenshots 入库
- Batch：每个 source buffer 触发（2 张或 60 秒）
- VLM：每张截图产出 1 个 Context Node
- Thread：跨窗口延续；长事件：≥25min（排除 gap>10min）
- OCR：仅对 knowledge 且语言 en/zh 做本地 OCR
- Search/Activity：不依赖 context_edges
- 鲁棒性：stale recovery + retry（全局配置：maxAttempts=2，delayMs=60s） + 幂等
- 可观测：LLMUsage + trace + Event Bus (推荐用于调度与数据状态观测)

---

# Milestones（按实现顺序）

- M0 — DB Schema/Migrations + shared types/IPC 适配（移除 edges，引入 threads，补 OCR 状态）
- M1 — Pipeline 落地方式与入口切换（只启动 schedulers）
- M2 — BatchScheduler(VLM)：batch → VLM (Stateless) → 单图单 node 入库 + **图片删除（无 OCR 场景）**
- M3 — OCRScheduler：knowledge(en/zh) → 本地 OCR (Region optimized) + **图片删除（OCR 场景）** → 与 M4 并行执行
- M4 — ThreadScheduler：thread assignment + continuity tracking + snapshot → 与 M3 并行执行
- M5 — Vector/Search：vector_documents + embedding + index + evidence 回溯（无 edges）
- M6 — ActivityTimeline：20min summary + long events + details 触发
- M7 — Monitoring/Queue Inspector：dashboard 适配新状态机
- M8 — Hardening：幂等/崩溃恢复/清理策略（含兜底 Cleanup）与回归 checklist

> 📁 **截图文件生命周期**：详见上方 [截图文件生命周期（Image Lifecycle）](#截图文件生命周期image-lifecycle) 章节，横跨 M2 和 M3。

---
