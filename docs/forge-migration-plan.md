# Electron Forge 迁移与发布计划（Mnemora）

日期：2026-02-05  
作者：Codex（协作产出）

> 目标：在**不改变任何业务功能**的前提下，将现有项目迁移到 Electron Forge 构建与发布体系，实现：
>
> - master 变更自动打包
> - GitHub Releases 发布
> - 客户端自动更新接入
> - 简化跨平台图标配置
> - 支持 Windows x64、Windows arm64、macOS arm64

---

## 0. 当前仓库实现状态（已落地）

以下内容已在仓库中实现（以 `origin` 为准：`mbaxszy7/Mnemora`）：

- Forge 配置：`forge.config.cjs`（makers + GitHub publisher + hooks；打包前使用现有 `vite build` 产出 `dist/` 与 `dist-electron/`）
- 脚本与依赖：`package.json` 已包含 `forge:*` scripts 与 Forge 相关 devDependencies
- 产物忽略：`.gitignore` 已忽略 `out/`（Forge 默认输出目录）
- CI：`.github/workflows/release.yml`（push `master` 产出 artifacts；tag `v*` 发布到 GitHub Releases）
- 更新接入（Windows，仅打包后）：`electron/main.ts` 中会尝试加载 `update-electron-app`；缺少依赖时会自动跳过，不影响启动

限制（本机/沙盒环境常见）：

- 如果你所在的 macOS 环境 `hdiutil create` 直接失败（例如报 “设备未配置”），这通常是系统/运行环境限制导致，无法通过 Forge 配置修复；可改用 `zip` 产物分发，或在 GitHub Actions 的 `macos-latest` runner 上生成 DMG。
- `pnpm forge:make` / `pnpm forge:publish` 需要能访问 `github.com`（下载 Electron 分发包），离线环境会失败；当前实现使用本地 Electron `checksums.json` + 仓库内 `.electron-cache/` 缓存以尽量避免联网。
- 如果 `github.com` 不可用，可设置 `ELECTRON_MIRROR`（例如 `https://npmmirror.com/mirrors/electron/`）让 Forge/packager 从镜像下载。
- 完整启用自动更新需要安装 `update-electron-app` 依赖并更新 `pnpm-lock.yaml`（通常在有网络环境执行）。

已知打包关键点（避免运行时报 i18n key / 原生模块加载失败）：

- `shared/locales/*.json` 必须在打包后存在于 `process.resourcesPath/shared/locales`，否则主进程 i18n 会退回显示 key（例如通知只显示 `notifications.*`）。
- `sharp` 依赖的 `.dylib` 需要从 `app.asar` 解包（`asar.unpack` 包含 `**/*.dylib`），否则 macOS 下会报 `Library not loaded: @rpath/libvips-cpp*.dylib`。

## 1. 结论与选型

**最终选择：Electron Forge + GitHub Publisher + update-electron-app**

理由：

- 与 GitHub Releases 和 update.electronjs.org 组合最顺畅，适合开源场景。
- Windows 使用 Squirrel.Windows 产物（RELEASES + nupkg）作为更新源。
- macOS 使用 ZIP 产物作为自动更新源（DMG 仅用于分发）。
- GitHub Actions 支持 windows arm64 runner，满足多架构打包。

**如果必须在原三种构建方式中选择（不迁移 Forge）**
优先级：`electron-builder` > `electron-packager` > `自定义脚本`

---

## 2. 当前已确认信息

- 包管理器：`pnpm`
- 版本策略：`semver`
- productName：`Mnemora`
- appId / bundleIdentifier：`com.mnemora.app`
- main 入口：`electron/main.ts`（源码），`dist-electron/main.js`（构建产物，来自 `package.json#main`）
- 图标现有位置：`public/` 下已有 `logo.ico` / `logo.icns`

发现的图标文件（来自 `public/`）：

- `public/logo.ico`
- `public/logo.icns`
- `public/logo.png`
- `public/logo.svg`
- `public/trayTemplate.png`
- `public/trayTemplate@2x.png`

> 注意：macOS 自动更新必须代码签名。当前没有证书，因此 **Windows 更新先行可落地**，macOS 更新在证书就绪后补齐。

---

## 2.1 现有构建基线（从仓库抽取）

- 构建入口：`pnpm build` = `build:window_inspector` → `rebuild:sqlite` → `tsc` → `vite build` → `electron-builder`
- Electron 版本：`electron@^39.2.5`（来自 `package.json`）
- 当前打包器：`electron-builder`（配置见 `electron-builder.json5`）
- `electron-builder.json5` 关键配置：`appId=com.mnemora.app`、`productName=Mnemora`、`asar=true` + `asarUnpack`（`better-sqlite3`/`bindings`/`file-uri-to-path`）、`files=dist/ + dist-electron/ + 依赖模块`、`extraResources=window_inspector`、`mac=dmg`、`win=nsis(x64)`、`linux=AppImage`
- Vite（主进程/预加载）构建要点（见 `vite.config.ts`）：`electron/main.ts` / `electron/preload.ts` → `dist-electron/`，`migrations` 与 `monitoring-static` 在 `closeBundle` 复制，main external 包含 `better-sqlite3` / `node-screenshots` / `sharp` / `hnswlib-node` / `tesseract.js`
- 原生模块重建：`pnpm rebuild:sqlite` 使用 `electron-rebuild -f -w better-sqlite3,hnswlib-node`
- 自动更新：当前未接入（仓库中未发现 `autoUpdater` / `update-electron-app`）

## 2.2 迁移需补齐项（从基线推导）

- **dist 布局不变**：运行时依赖 `dist/` 与 `dist-electron/`，Forge 打包必须包含这两者（否则 `MAIN_DIST/RENDERER_DIST` 失效）
- **packager ignore 规则**：需避免把源码/测试/旧 release 目录打进包体，同时保留 `dist/` 与 `dist-electron/`
- **原生模块处理**：`better-sqlite3` / `hnswlib-node` / `sharp` / `node-screenshots` 需确保 rebuild（建议用 `@electron-forge/plugin-electron-rebuild`）+ asar 解包（`@electron-forge/plugin-auto-unpack-natives` 或 `packagerConfig.asarUnpack`）
- **extraResources 迁移**：`window_inspector` 二进制需继续打进 `Resources/bin/`
- **构建管线选择**：方案 A（最小侵入）保留 `vite-plugin-electron` 与现有 `vite build`；方案 B（更一致）替换为 `@electron-forge/plugin-vite` 统一 build + make
- **构建前置步骤**：`build:window_inspector` 与 `vite build` 需在 `forge make` 前执行（用 hooks 或脚本串联）
- **Linux 产物取舍**：当前 `electron-builder` 仍生成 `AppImage`，需明确 Forge 阶段是否保留 Linux
- **配置文件格式**：`package.json` 为 `type: "module"`，`forge.config` 建议使用 `forge.config.cjs`（或明确 ESM 格式）
- **appId 对齐**：Forge `appId` 应与 `electron/main.ts` 中的 `app.setAppUserModelId` 保持一致（避免 Windows 更新/通知异常）
- **产物目录变化**：`electron-builder` 输出 `release/${version}`，Forge 默认 `out/`，需同步 README/脚本/CI 路径

---

## 3. 迁移原则（保证功能不变）

1. **不改运行逻辑**：只变更构建、发布、更新配置。
2. **入口保持不变**：`electron/main.ts` 与现有 preload/renderer 构建保持原样。
3. **CI 与本地构建对齐**：本地 `forge make` 和 CI 产物一致。
4. **逐步启用更新**：先发布与打包，再接入更新。

---

## 4. 迁移阶段计划

### 阶段 0：基线记录（不改代码）

产出：迁移基线文档

- 记录当前 Electron 版本、Node 版本（如未锁定 Node，补充 `.nvmrc` 或 CI Node 版本）
- 记录 `package.json` 脚本与现有构建流程
- 记录 `appId` / `productName` / `bundleIdentifier`

### 阶段 1：引入 Forge（最小侵入）

产出：`forge.config.cjs`（或 ESM 版 `forge.config.mjs`）+ 基础构建可运行

- 安装 Forge CLI 与 Makers + `publisher-github`
- 添加 `forge.config`（建议 `forge.config.cjs` 以兼容 `type: "module"`）
- `packagerConfig` 配置：`icon`、`appId/appBundleId`、`productName`、`asar`、`asarUnpack`、`extraResource(s)`
- 引入 `@electron-forge/plugin-electron-rebuild` 与 `@electron-forge/plugin-auto-unpack-natives`
- 决定构建管线：保留 `vite build` 或迁移到 `@electron-forge/plugin-vite`

建议 makers：

- Windows：`@electron-forge/maker-squirrel`
- macOS：`@electron-forge/maker-dmg` + `@electron-forge/maker-zip`

### 阶段 2：多平台构建矩阵

产出：本地 `pnpm forge make` 成功

- `win32 x64` 产物
- `win32 arm64` 产物
- `darwin arm64` 产物
- （可选）`linux x64` 产物（若保留 AppImage）

### 阶段 3：图标统一配置

产出：跨平台图标一致

- Windows：`public/logo.ico`
- macOS：`public/logo.icns`
- `packagerConfig.icon` 统一指向 `public/logo`

### 阶段 4：自动更新接入

产出：更新链路可用（Windows）

- 加入 `update-electron-app`
- 配置 GitHub Publisher
- Windows 使用 Squirrel.Windows 更新源
- macOS 更新：暂不启用（待证书）
- update.electronjs.org 指向正确 `owner/repo`

### 阶段 5：GitHub Actions 自动构建与发布

产出：CI Workflow

- `push master`：构建并上传 artifacts
- `tag`/`release`：发布到 GitHub Releases
- runner：`windows-2022`（x64）、`windows-11-arm`（arm64）、`macos-latest`（arm64）
- secrets：`GH_TOKEN` 或 `GITHUB_TOKEN`（publisher 发布所需）

### 阶段 6：回归验证

产出：回归清单

- 启动与核心功能无变化
- Windows 安装与更新可用
- macOS 安装可用

---

## 5. 阶段逐项检查表

### Stage 0 – 基线记录（Pending）

- 记录当前 Electron/Node 版本与打包命令（README & 本 doc；如未锁定 Node，补充）
- 抽取 `package.json` 脚本与依赖，确认 `start`/`build`/`release` 流程
- 摘要 `electron-builder.json5` 的 asar/asarUnpack/files/extraResources 基线，明确 Forge 需复刻项
- 明确 `appId`/`productName`/`bundleIdentifier`（现有基线：`com.mnemora.app` / `Mnemora`）

### Stage 1 – 引入 Forge（Pending）

- 安装 `@electron-forge/cli` 及 `@electron-forge/maker-*`、`publisher-github`
- 选择配置文件格式（推荐 `forge.config.cjs` 以兼容 `type: "module"`）
- 编写基础 `forge.config`（packagerConfig + makers + publisher + plugins）
- 增加 `@electron-forge/plugin-electron-rebuild` 与 `@electron-forge/plugin-auto-unpack-natives`
- 迁移 `extraResource(s)`（`window_inspector` → `Resources/bin/`）
- 确认 `dist/` 与 `dist-electron/` 被打包（否则运行时路径失效）
- 串联 `build:window_inspector` + `vite build` 与 `forge make`（或改用 `plugin-vite`）
- 更新 `package.json` scripts（新增 `forge:make`/`forge:publish`，必要时调整 `build`）
- 尝试 `pnpm forge package` 或 `pnpm forge make --platform=win32 --arch=x64`，确保打包成功

### Stage 2 – 多平台构建矩阵（Pending）

- 依次执行 `pnpm forge make`，收集 `win32 x64`、`win32 arm64`、`darwin arm64` 产物
- 验证产物文件结构（Squirrel RELEASES/nupkg、zip、dmg）
- 如保留 Linux，补 `linux x64` 产物并验证 AppImage
- 简单运行包体，确认原生模块可加载（`better-sqlite3` / `hnswlib-node` / `sharp`）

### Stage 3 – 图标统一（Pending）

- 确保 `packagerConfig.icon` 指向 `public/logo` 且输出 `ico`/`icns`
- 预留 `trayTemplate` 资源供 macOS dock/tray 使用

### Stage 4 – 自动更新（Pending）

- 在 `electron/main.ts`（或启动顺序）引入 `update-electron-app`，包裹 `if (app.isPackaged)`
- 配置 `updateElectronApp({ repo, owner })` 与日志（保证 update.electronjs.org 指向正确仓库）
- 确认 GitHub Publisher 上传的 Release 中包含 Squirrel 产物
- macOS 目标暂时不自动更新，等待签名证书

### Stage 5 – GitHub Actions（Pending）

- 制作 workflow（`release.yml`）触发：push master -> make + upload，tag/release -> publish
- 在 workflow 中添加矩阵（win x64、win arm64、mac arm64）和 `pnpm install` 前置
- 添加 `GH_TOKEN` 或 `GITHUB_TOKEN`（发布所需）

### Stage 6 – 回归验证（Pending）

- 本地安装测试：Windows 安装、更新、macOS 安装（β）
- 核心功能 smoke test（main-window、tray、auto tray etc）
- 验证 `window_inspector`、`migrations`、`monitoring-static` 在打包环境可用

---

## 6. 具体配置建议（模板）

### 6.1 forge.config.cjs（示意）

```js
// forge.config.cjs
module.exports = {
  packagerConfig: {
    icon: "public/logo",
    appBundleId: "com.mnemora.app",
    appId: "com.mnemora.app",
    name: "Mnemora",
    asar: true,
    // 如不用 auto-unpack 插件，可在这里补充 asar 解包策略
    // asar: { unpack: "**/*.node" },
    // extraResource 的目标路径需确认；如需放到 Resources/bin，可用 hooks 追加拷贝
    extraResource: ["externals/python/window_inspector/dist/window_inspector"],
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "mnemora",
      },
    },
    {
      name: "@electron-forge/maker-dmg",
      config: {
        format: "ULFO",
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
  plugins: [
    [
      "@electron-forge/plugin-electron-rebuild",
      {
        force: true,
        onlyModules: ["better-sqlite3", "hnswlib-node"],
      },
    ],
    "@electron-forge/plugin-auto-unpack-natives",
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: "YOUR_GITHUB_ORG",
          name: "YOUR_REPO_NAME",
        },
        prerelease: false,
        draft: false,
      },
    },
  ],
};
```

### 6.2 main 进程更新接入（示意）

```ts
// electron/main.ts
import { app } from "electron";
import { updateElectronApp } from "update-electron-app";

if (app.isPackaged) {
  updateElectronApp({
    repo: "YOUR_REPO_NAME",
    owner: "YOUR_GITHUB_ORG",
  });
}
```

> 实际接入位置以当前 main 初始化流程为准，保证不影响已有逻辑。

---

## 7. CI 参考（GitHub Actions）

**触发策略**

- `push` to `master` -> build + upload artifacts
- `release` / `tag` -> publish

**runner 矩阵**

- windows-2022 (x64)
- windows-11-arm (arm64)
- macos-latest (arm64)

**构建步骤（建议）**

- `pnpm install --frozen-lockfile`
- `pnpm run build:window_inspector`
- `pnpm run build` 或 `pnpm forge make`（取决于构建管线选择）
- `pnpm forge publish`（仅 release/tag 流水线）

### Token（你现在卡住的点）

- **GitHub Actions**：不需要你手动设置 token。本仓库的 workflow 使用 `${{ secrets.GITHUB_TOKEN }}` 发布到 GitHub Releases（已配置 `permissions: contents: write`）。
- **本地执行 `pnpm forge:publish`**：需要你在环境变量里提供 `GH_TOKEN`（建议 PAT 或 fine-grained token，具备对仓库 Release 的写权限）。可参考仓库根目录 `.env.example`。

### 一键发版（推荐）

本仓库提供了本地辅助脚本（不涉及 token 设置）：

- 打 tag 并 push：`scripts/release/tag-and-push.sh`
- 本地发布（需要 `GH_TOKEN`）：`scripts/release/publish-local.sh`

---

## 8. 风险与限制

- **macOS 自动更新必须签名**：没有证书则无法使用 update.electronjs.org。
- **Windows arm64 runner 限制**：目前主要面向 public repo（你计划开源，符合）。
- **迁移初期会出现构建产物名称变化**：需要提前在 README/发布说明中明确。
- **原生模块易踩坑**：未 rebuild/未 asar 解包会导致运行时报错（`better-sqlite3`、`hnswlib-node`、`sharp` 等）。
- **打包内容缺失风险**：`dist/`、`dist-electron/`、`window_inspector` 若未被包含会导致启动失败或功能缺失。
- **构建管线切换成本**：从 `vite-plugin-electron` 迁到 `plugin-vite` 可能需要调整现有 Vite 配置与拷贝逻辑。

---

## 9. 下一步建议（可选）

1. 确认最终 `appId` / `bundleIdentifier`（建议保持一致）：`com.mnemora.app`
2. 确认 GitHub 仓库名与 owner：`mbaxszy7/Mnemora`
3. 构建管线选择：迁移 `@electron-forge/plugin-vite`
4. Linux 产物保留（如保留 AppImage）
5. 我可以直接在仓库内生成：`forge.config.cjs`、`package.json` 脚本调整、`.github/workflows/release.yml`

---

## 10. 待回答问题

1. 最终的 `appId` / `bundleIdentifier` 具体值是什么？（当前选择：`com.mnemora.app`）是否需要保持与旧 `electron-builder` 配置一致？
2. GitHub 仓库的 owner/name 是哪一个？（当前：`mbaxszy7/Mnemora`）
3. 构建管线采用哪种方案？（当前：迁移 `@electron-forge/plugin-vite`）
4. Linux 产物是否继续保留？（当前：保留）
5. macOS 签名证书准备情况如何？没有证书时是否仍需生成 `dmg` 供手动分发？（当前：仍生成 `dmg`；见下方说明）
6. 是否有额外的自动更新元数据（如 delta updates）要求？（当前：不需要）

### 10.1 「没有证书时是否仍需生成 dmg 供手动分发」是什么意思？

这里的意思是：即使你暂时**没有 Apple Developer ID 证书**（无法做代码签名 + 公证 notarization），你仍然可以选择生成 `dmg` 作为一个“用户手动下载并安装”的分发容器。

当前选择：**仍然生成 `dmg`** 供手动分发/测试（无证书阶段）。

需要注意的差异：

- 有 `dmg` 不等于能自动更新。自动更新通常使用 `zip`（macOS）或 Squirrel（Windows）产物。
- 没签名/没公证的 macOS App，用户打开时会遇到 Gatekeeper 拦截/安全提示（需要手动放行）。

所以实践上常见策略是：

- **仍然生成 dmg**：用于早期测试/手动分发（但用户体验会有“未验证开发者”的提示）。
- **自动更新暂不启用（macOS）**：等证书就绪后再补齐签名/公证 + 更新链路。
