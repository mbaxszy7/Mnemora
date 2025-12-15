/**
 * Popular application configuration
 */
export interface PopularAppConfig {
  /** Alternative names/aliases for this application */
  aliases: string[];
}

export const POPULAR_APPS: Record<string, PopularAppConfig> = {
  "GitHub Desktop": {
    aliases: ["GitHub Desktop", "github", "GitHub"],
  },
  "Google Chrome": {
    aliases: ["Chrome", "chrome", "Google Chrome"],
  },
  "Visual Studio Code": {
    aliases: ["Code", "VSCode", "code", "Visual Studio Code - Insiders"],
  },
  Slack: {
    aliases: ["slack", "Slack"],
  },
  "Microsoft Teams": {
    aliases: ["Teams", "msteams", "Microsoft Teams"],
  },
  Figma: {
    aliases: ["figma", "Figma"],
  },
  Discord: {
    aliases: ["discord", "Discord"],
  },
  Notion: {
    aliases: ["notion", "Notion"],
  },
  Safari: {
    aliases: ["safari", "Safari"],
  },
  Firefox: {
    aliases: ["firefox", "Firefox", "Mozilla Firefox"],
  },
  Terminal: {
    aliases: ["terminal", "Terminal"],
  },
  iTerm2: {
    aliases: ["iTerm", "iTerm2", "iTerm 2", "iterm", "iterm2"],
  },
  Finder: {
    aliases: ["finder", "Finder"],
  },
  WeChat: {
    aliases: ["wechat", "WeChat", "微信"],
  },
  Zoom: {
    aliases: ["zoom.us", "Zoom", "zoom"],
  },
  Xcode: {
    aliases: ["Xcode", "xcode"],
  },
  Spotify: {
    aliases: ["Spotify", "spotify"],
  },
  Postman: {
    aliases: ["Postman", "postman"],
  },
  Cursor: {
    aliases: ["Cursor", "cursor"],
  },
  Windsurf: {
    aliases: ["Windsurf", "windsurf"],
  },
  "Claude Code": {
    aliases: ["Claude Code", "claude-code", "claude code"],
  },
  Kiro: {
    aliases: ["Kiro", "kiro"],
  },
  "Zen browser": {
    aliases: ["Zen browser", "zen browser"],
  },
};

export const formatAppName = (name: string): string => {
  // Extract app name from window title
  let appName = name;

  // Microsoft Teams specific patterns
  if (
    name.includes("Microsoft Teams") ||
    name.includes("MSTeams") ||
    (name.includes("Chat |") && name.includes("| Microsoft Teams"))
  ) {
    appName = "Microsoft Teams";
  }
  // WeChat specific patterns
  else if (name.includes("WeChat") || name.includes("微信")) {
    appName = "WeChat";
  }
  // Slack specific patterns
  else if (name.includes("Slack")) {
    appName = "Slack";
  }
  // Chrome specific patterns
  else if (name.includes("Google Chrome") || name.endsWith(" - Chrome")) {
    appName = "Google Chrome";
  }
  // Safari specific patterns
  else if (name.includes("Safari") || name.endsWith(" — Safari")) {
    appName = "Safari";
  }
  // Visual Studio Code
  else if (name.includes("Visual Studio Code") || name.endsWith(" - Code")) {
    appName = "Visual Studio Code";
  }
  // Terminal/iTerm
  else if (name.includes("Terminal") || name.includes("iTerm")) {
    appName = name.includes("iTerm") ? "iTerm" : "Terminal";
  }
  // For other apps, try to extract from window title more carefully
  else if (name.includes(" — ")) {
    // For apps that use em dash separator (like many Mac apps)
    // Take the last part, but only if it looks like an app name (not too long)
    const lastPart = name.split(" — ").pop();
    if (lastPart && lastPart.length < 30) {
      appName = lastPart;
    }
  } else if (name.includes(" - ")) {
    // For apps that use regular dash separator
    // Be more careful - only take the last part if it's likely an app name
    const parts = name.split(" - ");
    const lastPart = parts[parts.length - 1];

    // Check if the last part looks like an app name (starts with capital, not too long, etc.)
    if (
      lastPart &&
      lastPart.length < 30 &&
      /^[A-Z]/.test(lastPart) &&
      !lastPart.includes(".") && // Not a filename
      !lastPart.includes("/") && // Not a path
      !lastPart.match(/^\d/)
    ) {
      // Doesn't start with a number
      appName = lastPart;
    }
  }

  // Final cleanup - if appName is still the full window title and it's very long,
  // just use the first part before any separator
  if (appName === name && appName.length > 50) {
    const firstPart = appName.split(/[-—]/)[0].trim();
    if (firstPart && firstPart.length < 30) {
      appName = firstPart;
    }
  }

  return appName;
};
