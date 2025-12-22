# 窗口截图功能 - 问题与方案

## 问题背景

用户希望在 Mnemora 中实现**按应用程序截图**功能：

- 用户选择特定的 app（如 Google Chrome、GitHub Desktop）
- 只截取这些 app 的窗口，而不是全屏

## 核心技术挑战

### 问题：窗口标题与应用名不匹配

Electron 的 `desktopCapturer.getSources()` 返回的窗口信息：

```typescript
{
  id: "window:26751:0",
  name: "bencevans/screenshot-desktop: 💻 Capture a screenshot...",  // 这是标签页标题，不是应用名！
  thumbnail: NativeImage
}
```

**关键问题**：`name` 是窗口标题（对于浏览器是当前标签页标题），不是应用程序名称。无法从 `"bencevans/screenshot-desktop..."` 推断出这是 `"Google Chrome"` 的窗口。

### 哪些应用受影响

| 应用类型                          | 窗口标题示例                   | 能否匹配                |
| --------------------------------- | ------------------------------ | ----------------------- |
| 浏览器（Chrome, Safari, Firefox） | `"GitHub - Where software..."` | ❌ 不包含应用名         |
| IDE（VS Code, Cursor）            | `"index.ts — MyProject"`       | ⚠️ 可能包含（部分情况） |
| 普通应用（GitHub Desktop, Slack） | `"GitHub Desktop"`             | ✅ 标题就是应用名       |

## 解决方案对比

### 方案 1：纯前端匹配（当前实现）

**原理**：通过窗口标题与应用名的部分匹配

```typescript
// macos-window-helper.ts
function findAppNameForWindow(windowTitle: string, appsWithWindows: string[]) {
  const titleLower = windowTitle.toLowerCase();
  for (const appName of appsWithWindows) {
    if (titleLower.includes(appName.toLowerCase())) {
      return appName;
    }
  }
  return undefined;
}
```

**优点**：

- 无需额外依赖
- 实现简单

**缺点**：

- 无法匹配浏览器标签页
- 依赖窗口标题格式，不稳定

**当前行为**：

- ✅ GitHub Desktop、Slack 等 → 窗口截图
- ❌ Chrome、Safari 等浏览器 → 回退到全屏截图

---

### 方案 2：AppleScript 窗口标题映射（已尝试，超时）

**原理**：使用 AppleScript 获取每个窗口的标题和对应应用名

```applescript
tell application "System Events"
  repeat with p in (every application process)
    repeat with w in (every window of p)
      -- 返回 "Google Chrome:::bencevans/screenshot-desktop..."
    end repeat
  end repeat
end tell
```

**问题**：遍历所有进程和窗口太慢，经常超时（>5秒）

---

### 方案 3：Python + Quartz 框架（MineContext 的方案）⭐

**原理**：使用 macOS 的 `CGWindowListCopyWindowInfo` API

```python
# window_inspector.py
from Quartz import CGWindowListCopyWindowInfo, kCGWindowListOptionAll

windows = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, 0)
for window in windows:
    result.append({
        "windowId": window.get("kCGWindowNumber"),
        "appName": window.get("kCGWindowOwnerName"),  # 准确的应用名！
        "windowTitle": window.get("kCGWindowName"),
        "bounds": window.get("kCGWindowBounds"),
    })
```

**返回结果**：

```json
{
  "windowId": 26751,
  "appName": "Google Chrome", // ✅ 准确的应用名
  "windowTitle": "bencevans/screenshot-desktop..."
}
```

**优点**：

- 100% 准确的应用名
- 可以获取所有窗口（包括其他 Space 的）
- 性能好（直接调用系统 API）

**缺点**：

- 需要打包 Python 脚本或 native module
- 增加应用体积

---

### 方案 4：Node.js Native Module

**原理**：用 C++/Objective-C 编写 Node.js addon，调用相同的 API

可选的库：

- `node-mac-windows` - 获取窗口列表
- 自己编写 native addon

**优点**：

- 不需要 Python
- 打包更简单

**缺点**：

- 需要编译 native code
- 不同架构需要分别编译（x64, arm64）

## 当前实现状态

### 已完成

1. **`captureWindowsByApp()` 方法**
   - 使用 `desktopCapturer` 截取指定应用的窗口
   - 通过窗口标题匹配应用名

2. **截图模式切换**
   - 用户选择了特定 app → 尝试窗口截图
   - 窗口截图失败 → 回退到全屏截图

3. **Virtual Window 机制**
   - 通过 AppleScript 检测哪些 app 有窗口
   - 为无法直接匹配的 app 创建 virtual-window
   - 确保所有活跃 app 出现在选择列表中

### 待实现（可选）

- [ ] Python Quartz 脚本集成
- [ ] 或 Node.js native module

## 代码结构

```
electron/services/screen-capture/
├── capture-service.ts          # captureWindowsByApp() 实现
├── screen-capture-module.ts    # 截图模式切换逻辑
├── macos-window-helper.ts      # AppleScript 集成、窗口匹配
└── capture-source-provider.ts  # 窗口源管理
```

## 参考实现

MineContext 的实现：

- `/Users/yanzheyu/MineContext/frontend/src/main/utils/mac-window-manager.ts` - 调用 Python 脚本
- `/Users/yanzheyu/MineContext/frontend/src/main/utils/get-capture-sources.ts` - 窗口匹配逻辑

## 建议

1. **短期**：保持当前实现，接受浏览器无法精确匹配的限制
2. **中期**：集成 Python Quartz 脚本（可参考 MineContext）
3. **长期**：考虑 native module 方案，减少对 Python 的依赖
