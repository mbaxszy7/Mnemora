/**
 * Popular Applications Configuration
 *
 * This module defines the list of popular applications with their icons and aliases
 * for the capture source settings feature.
 */

/**
 * Popular application configuration
 */
export interface PopularAppConfig {
  /** Icon filename (relative to public/app-icons/) */
  icon: string;
  /** Alternative names/aliases for this application */
  aliases: string[];
}

/**
 * Popular applications with their icons and aliases
 * Key is the primary application name, value contains icon path and aliases
 */
export const POPULAR_APPS: Record<string, PopularAppConfig> = {
  "Google Chrome": {
    icon: "chrome.svg",
    aliases: ["Chrome", "chrome", "Google Chrome"],
  },
  "Visual Studio Code": {
    icon: "vscode.svg",
    aliases: ["Code", "VSCode", "code", "Visual Studio Code - Insiders"],
  },
  Slack: {
    icon: "slack.svg",
    aliases: ["slack", "Slack"],
  },
  "Microsoft Teams": {
    icon: "teams.svg",
    aliases: ["Teams", "msteams", "Microsoft Teams"],
  },
  Figma: {
    icon: "figma.svg",
    aliases: ["figma", "Figma"],
  },
  Notion: {
    icon: "notion.svg",
    aliases: ["notion", "Notion"],
  },
  Safari: {
    icon: "safari.svg",
    aliases: ["safari", "Safari"],
  },
  Firefox: {
    icon: "firefox.svg",
    aliases: ["firefox", "Firefox", "Mozilla Firefox"],
  },
  Terminal: {
    icon: "terminal.svg",
    aliases: ["terminal", "Terminal", "iTerm", "iTerm2", "iTerm 2"],
  },
  Finder: {
    icon: "finder.svg",
    aliases: ["finder", "Finder"],
  },
  WeChat: {
    icon: "wechat.svg",
    aliases: ["wechat", "WeChat", "微信"],
  },
  Zoom: {
    icon: "zoom.svg",
    aliases: ["zoom.us", "Zoom", "zoom"],
  },
  Xcode: {
    icon: "xcode.svg",
    aliases: ["Xcode", "xcode"],
  },
  Spotify: {
    icon: "spotify.svg",
    aliases: ["Spotify", "spotify"],
  },
  Postman: {
    icon: "postman.svg",
    aliases: ["Postman", "postman"],
  },
  Cursor: {
    icon: "cursor.svg",
    aliases: ["Cursor", "cursor"],
  },
  Windsurf: {
    icon: "windsurf.svg",
    aliases: ["Windsurf", "windsurf"],
  },
  "Claude Code": {
    icon: "claude-code.svg",
    aliases: ["Claude Code", "claude-code", "claude code"],
  },
  Kiro: {
    icon: "kiro.svg",
    aliases: ["Kiro", "kiro"],
  },
};

/**
 * Default icon for applications not in the popular list
 */
export const DEFAULT_APP_ICON = "default-app.svg";

/**
 * Check if an application name matches any popular app (including aliases)
 * @param appName - The application name to check
 * @returns The popular app configuration if found, null otherwise
 */
export function findPopularApp(appName: string): { name: string; config: PopularAppConfig } | null {
  // First check exact matches with primary names
  for (const [primaryName, config] of Object.entries(POPULAR_APPS)) {
    if (primaryName === appName) {
      return { name: primaryName, config };
    }
  }

  // Then check aliases (case-insensitive)
  const lowerAppName = appName.toLowerCase();
  for (const [primaryName, config] of Object.entries(POPULAR_APPS)) {
    if (config.aliases.some((alias) => alias.toLowerCase() === lowerAppName)) {
      return { name: primaryName, config };
    }
  }

  return null;
}

/**
 * Get the icon path for an application
 * @param appName - The application name
 * @returns The icon path relative to public/app-icons/
 */
export function getAppIcon(appName: string): string {
  const popularApp = findPopularApp(appName);
  return popularApp ? popularApp.config.icon : DEFAULT_APP_ICON;
}

/**
 * Check if an application is popular
 * @param appName - The application name
 * @returns True if the app is in the popular list
 */
export function isPopularApp(appName: string): boolean {
  return findPopularApp(appName) !== null;
}
