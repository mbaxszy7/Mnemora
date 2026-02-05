#!/bin/bash
# 准备开发环境用的自定义 Electron.app（带应用图标）

set -euo pipefail

CUSTOM_ELECTRON_DIR=".electron-dev"
APP_ICON="public/logo.icns"
STAMP_FILE="$CUSTOM_ELECTRON_DIR/.stamp"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ℹ️  非 macOS，跳过自定义 Electron.app 准备步骤"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 node，无法读取 Electron 版本"
  exit 1
fi

if [[ ! -d "node_modules/electron/dist" ]]; then
  echo "✗ 未找到 node_modules/electron/dist，请先安装依赖：pnpm i"
  exit 1
fi

CURRENT_ELECTRON_VERSION="$(node -p "require('electron/package.json').version")"
ICON_SHA="none"
if [[ -f "$APP_ICON" ]]; then
  ICON_SHA="$(shasum -a 256 "$APP_ICON" | awk '{print $1}')"
fi

PREV_ELECTRON_VERSION=""
PREV_ICON_SHA=""
if [[ -f "$STAMP_FILE" ]]; then
  PREV_ELECTRON_VERSION="$(sed -n '1p' "$STAMP_FILE" || true)"
  PREV_ICON_SHA="$(sed -n '2p' "$STAMP_FILE" || true)"
fi

if [[ -d "$CUSTOM_ELECTRON_DIR/Electron.app" ]] \
  && [[ "$PREV_ELECTRON_VERSION" == "$CURRENT_ELECTRON_VERSION" ]] \
  && [[ "$PREV_ICON_SHA" == "$ICON_SHA" ]]; then
  echo "✓ 自定义 Electron 已存在且为最新 (Electron $CURRENT_ELECTRON_VERSION)"
  exit 0
fi

echo "🧹 需要重新生成自定义 Electron.app (Electron $CURRENT_ELECTRON_VERSION)"
echo "🚀 准备自定义 Electron.app..."

rm -rf "$CUSTOM_ELECTRON_DIR"
mkdir -p "$CUSTOM_ELECTRON_DIR"

# 复制原始 Electron dist（包含 Electron.app / version / licenses 等）
cp -R "node_modules/electron/dist/"* "$CUSTOM_ELECTRON_DIR/"

# 替换图标
if [[ -f "$APP_ICON" ]]; then
  cp "$APP_ICON" "$CUSTOM_ELECTRON_DIR/Electron.app/Contents/Resources/electron.icns"
  echo "✓ 替换图标完成"
else
  echo "⚠️  未找到图标文件：$APP_ICON（将使用默认 Electron 图标）"
fi

# 修改 Info.plist
PLIST="$CUSTOM_ELECTRON_DIR/Electron.app/Contents/Info.plist"

# 使用 PlistBuddy 修改 Bundle ID 和名称
if [[ -x /usr/libexec/PlistBuddy ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.mnemora.app" "$PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.mnemora.app" "$PLIST"
  
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Mnemora" "$PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Mnemora" "$PLIST"
  
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Mnemora" "$PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleName string Mnemora" "$PLIST"
  
  echo "✓ 修改 Info.plist 完成"
else
  echo "⚠️  未找到 /usr/libexec/PlistBuddy，跳过 Info.plist 修改"
fi

# 刷新图标缓存
touch "$CUSTOM_ELECTRON_DIR/Electron.app"

{
  echo "$CURRENT_ELECTRON_VERSION"
  echo "$ICON_SHA"
} > "$STAMP_FILE"

echo "✅ 自定义 Electron 准备完成！"
echo ""
echo "使用方式:"
echo "  ELECTRON_OVERRIDE_DIST_PATH=$PWD/$CUSTOM_ELECTRON_DIR pnpm dev"
