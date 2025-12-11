# Screen Capture 模块架构

## 1. 服务关系与架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    ScreenCaptureModule (Facade)                  │
│  - 统一入口，协调所有组件                                          │
│  - 管理生命周期和 power monitor 回调                              │
└─────────────────────────────────────────────────────────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│  Scheduler  │ │CaptureService│ │SourceProvider│ │WindowFilter │
│  定时调度    │ │  实际截图    │ │  源缓存      │ │  窗口过滤   │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ AutoRefreshCache │
                              │   通用缓存组件    │
                              └─────────────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │macOSWindowHelper│
                              │ AppleScript集成  │
                              └─────────────────┘
```

## 2. 各组件职责

| 组件                       | 职责                                     | 关键方法                                                                                     |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| **ScreenCaptureModule**    | 门面模式，统一入口                       | `start()`, `stop()`, `pause()`, `resume()`, `getState()`, `getWindows()`, `captureScreens()` |
| **ScreenCaptureScheduler** | 定时调度，延迟补偿                       | `start()`, `stop()`, `pause()`, `resume()`, `on()/off()` 事件订阅                            |
| **CaptureService**         | 使用 node-screenshots 截图，多显示器拼接 | `captureScreens()`, `getMonitorLayout()`, `calculateBoundingBox()`                           |
| **CaptureSourceProvider**  | 缓存屏幕/窗口列表                        | `getSources()`, `getScreens()`, `getWindows()`, `refresh()`                                  |
| **WindowFilter**           | 过滤系统窗口，规范化 app 名称            | `filterSystemWindows()`, `normalizeAppName()`, `shouldExclude()`                             |
| **AutoRefreshCache**       | 通用定时刷新缓存                         | `get()`, `refresh()`, `hasData()`, `dispose()`                                               |
| **macOSWindowHelper**      | macOS AppleScript 跨 Space 窗口枚举      | `getWindowsViaAppleScript()`, `getHybridWindowSources()`, `mergeSources()`                   |

## 3. 截图与 Meta Capture Source 的关系

**当前状态：独立运行**

| 功能            | 实现方式                                                              | 用途                    |
| --------------- | --------------------------------------------------------------------- | ----------------------- |
| **截图**        | `CaptureService` 使用 `node-screenshots` 直接截取所有显示器           | 生成图像文件            |
| **Meta Source** | `CaptureSourceProvider` 使用 Electron `desktopCapturer` + AppleScript | 获取窗口/屏幕元数据列表 |

**Meta Capture Source 的用途：**

1. **日志记录** - 每次截图时记录当前活跃的 app 列表
2. **未来功能** - 可用于实现选择性截图（只截特定 app）
3. **跨 Space 支持** - AppleScript 可以枚举所有虚拟桌面的窗口

## 4. 后续扩展：只截特定 App

`node-screenshots` 支持窗口级别截图：

```typescript
import { Window } from "node-screenshots";

// 获取所有窗口
const windows = Window.all();

// 找到目标 app 的窗口
const chromeWindow = windows.find((w) => w.appName === "Google Chrome");

// 只截这个窗口
if (chromeWindow) {
  const image = await chromeWindow.captureImage();
}
```

**可扩展功能：**

1. 用户配置"关注的 app 列表"
2. 只截取这些 app 的窗口
3. 结合 Meta Source 的 bounds 信息，智能裁剪或拼接
