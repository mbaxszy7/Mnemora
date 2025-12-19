#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
Window Inspector for Mnemora
Uses macOS Quartz framework to get detailed window information including:
- Window ID, app name, window title
- Window bounds and visibility
- Works across all Spaces and minimized windows
"""

import sys
import json

# Disable buffering for stdout
sys.stdout = open(sys.stdout.fileno(), mode='w', buffering=1)

# Disable logging to avoid blocking on stderr
# logging is disabled when running from Electron

try:
    from Quartz import CGWindowListCopyWindowInfo, kCGWindowListOptionAll, kCGNullWindowID

    window_list = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID)

    windows = []
    
    # Important apps - merged from shared/popular-apps.ts POPULAR_APPS
    # These apps will always be included even without window titles
    important_apps = [
        # From POPULAR_APPS (canonical names and aliases)
        'GitHub Desktop', 'github', 'GitHub',
        'Google Chrome', 'Chrome', 'chrome',
        'Visual Studio Code', 'Code', 'VSCode', 'code', 'Visual Studio Code - Insiders',
        'Slack', 'slack',
        'Microsoft Teams', 'Teams', 'msteams',
        'Figma', 'figma',
        'Discord', 'discord',
        'Notion', 'notion',
        'Safari', 'safari',
        'Firefox', 'firefox', 'Mozilla Firefox',
        'Terminal', 'terminal',
        'iTerm2', 'iTerm', 'iTerm 2', 'iterm', 'iterm2',
        'Finder', 'finder',
        'WeChat', 'wechat', '微信',
        'Zoom', 'zoom.us', 'zoom',
        'Skype', 'skype',
        'Microsoft PowerPoint', 'PowerPoint', 'powerpoint', 'ppt',
        'Keynote', 'keynote', 'presentation',
        'Obsidian', 'obsidian',
        'Roam Research', 'roam', 'roam research',
        'Logseq', 'logseq',
        'IntelliJ IDEA', 'intellij', 'idea',
        'PyCharm', 'pycharm',
        'Microsoft Edge', 'edge',
        'Sketch', 'sketch',
        'Adobe Photoshop', 'photoshop', 'ps',
        'Adobe Illustrator', 'illustrator', 'ai',
        'System Preferences', 'system preferences', 'settings', '系统设置',
        'Activity Monitor', 'activity monitor',
        'Xcode', 'xcode',
        'Spotify', 'spotify',
        'Postman', 'postman',
        'Cursor', 'cursor',
        'Windsurf', 'windsurf',
        'Claude Code', 'claude-code', 'claude code',
        'Kiro', 'kiro',
        'Zen browser', 'zen browser',
        # Additional common apps
        'Microsoft Word', 'Microsoft Excel',
        'Arc', 'Brave', 'Hyper', 'Alacritty', 'Warp',
        'SourceTree', 'Insomnia', 'TablePlus', 'Sequel Pro', 'DataGrip'
    ]

    # System apps to skip - merged from types.ts DEFAULT_WINDOW_FILTER_CONFIG.systemWindows
    system_apps_to_skip = [
        # From types.ts systemWindows
        'Dock', 'Spotlight', 'Control Center', 'Notification Center',
        'SystemUIServer', 'Window Server',
        'Mnemora', 'Electron', 'Mnemora - Your Second Brain',
        # Additional system apps
        'ControlCenter', 'WindowManager', 'NotificationCenter',
        'AXVisualSupportAgent', 'universalaccessd', 'TextInputMenuAgent',
        'CoreLocationAgent', 'loginwindow', 'UserNotificationCenter',
        'CursorUIViewService', 'LinkedNotesUIService', 'Open and Save Panel Service',
        # Chinese system app names
        '程序坞', '通知中心', '聚焦', '墙纸', '微信输入法', '自动填充',
        '隐私与安全性'
    ]

    # Group windows by app
    app_windows = {}

    for i, window in enumerate(window_list):
        window_num = window.get('kCGWindowNumber', None)
        app_name = window.get('kCGWindowOwnerName')
        window_title = window.get('kCGWindowName', '')

        if not (app_name and window_num):
            continue

        if app_name in system_apps_to_skip:
            continue

        bounds = window.get('kCGWindowBounds', {})
        width = bounds.get('Width', 0)
        height = bounds.get('Height', 0)

        # Skip tiny windows
        if width < 50 or height < 50:
            continue

        # Skip high-layer windows (usually system overlays)
        layer = window.get('kCGWindowLayer', 0)
        if layer > 200:
            continue

        is_important = any(
            app.lower() in app_name.lower() or app_name.lower() in app.lower() 
            for app in important_apps
        )
        has_content = window_title.strip() != ''
        is_reasonable_size = (width > 300 and height > 200)

        should_include = (is_important or has_content or is_reasonable_size)

        if not should_include:
            continue

        window_info = {
            'windowId': window['kCGWindowNumber'],
            'appName': app_name,
            'windowTitle': window_title,
            'bounds': dict(bounds),
            'isOnScreen': window.get('kCGWindowIsOnscreen', False),
            'layer': layer,
            'isImportant': is_important,
            'area': width * height
        }

        # Add ALL windows (not just one per app) for proper matching
        windows.append(window_info)

    # Output collected windows

    # Sort: important apps first, then alphabetically
    windows.sort(key=lambda x: (not x['isImportant'], x['appName']))

    # Output JSON to stdout
    print(json.dumps(windows, indent=2, ensure_ascii=False))

except ImportError as e:
    print("[]", flush=True)
except Exception as e:
    print("[]", flush=True)
