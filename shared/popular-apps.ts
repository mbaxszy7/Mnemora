/**
 * Popular Applications Configuration
 *
 * This module defines the list of popular applications with their icons and aliases
 * for the capture source settings feature.
 *
 * Icon sources:
 * - Simple Icons (https://simpleicons.org/) - CC0 licensed icon collection
 * - Note: While Simple Icons repo is CC0, individual brand icons may have their own
 *   trademark/usage guidelines. Check each brand's guidelines when using.
 */

import {
  siFirefoxbrowser,
  siFigma,
  siGooglechrome,
  siNotion,
  siSlack,
  siSafari,
  siSpotify,
  siWechat,
  siXcode,
  siZoom,
  SimpleIcon,
  siWindsurf,
  siPostman,
  siClaude,
  siDiscord,
  siIterm2,
  siGnometerminal,
  siVscodium,
  siGithub,
} from "simple-icons";

/**
 * Popular application configuration
 */
export interface PopularAppConfig {
  /** Simple Icons icon object for rendering as data URL */
  simpleIcon?: SimpleIcon;
  /** Alternative names/aliases for this application */
  aliases: string[];
}

/**
 * Popular applications with their icons and aliases
 * Key is the primary application name, value contains icon path and aliases
 *
 * Apps with simpleIcon: Icons are rendered from Simple Icons library as data URLs
 * Apps without simpleIcon: Fall back to default app icon (AppWindow from Lucide)
 *
 * Apps without Simple Icons coverage (as of simple-icons v14):
 * - Microsoft Teams: Not available in Simple Icons
 * - Finder: macOS-specific, not in Simple Icons
 * - Cursor: Not available in Simple Icons
 * - Kiro: Custom/internal app
 */
export const POPULAR_APPS: Record<string, PopularAppConfig> = {
  "GitHub Desktop": {
    simpleIcon: siGithub,
    aliases: ["GitHub Desktop", "github", "GitHub"],
  },
  "Google Chrome": {
    simpleIcon: siGooglechrome,
    aliases: ["Chrome", "chrome", "Google Chrome"],
  },
  "Visual Studio Code": {
    simpleIcon: siVscodium, // Using VSCodium icon as closest match
    aliases: ["Code", "VSCode", "code", "Visual Studio Code - Insiders"],
  },
  Slack: {
    simpleIcon: siSlack,
    aliases: ["slack", "Slack"],
  },
  "Microsoft Teams": {
    aliases: ["Teams", "msteams", "Microsoft Teams"],
  },
  Figma: {
    simpleIcon: siFigma,
    aliases: ["figma", "Figma"],
  },
  Discord: {
    simpleIcon: siDiscord,
    aliases: ["discord", "Discord"],
  },
  Notion: {
    simpleIcon: siNotion,
    aliases: ["notion", "Notion"],
  },
  Safari: {
    simpleIcon: siSafari,
    aliases: ["safari", "Safari"],
  },
  Firefox: {
    simpleIcon: siFirefoxbrowser,
    aliases: ["firefox", "Firefox", "Mozilla Firefox"],
  },
  Terminal: {
    simpleIcon: siGnometerminal, // Using GNOME Terminal icon as generic terminal icon
    aliases: ["terminal", "Terminal"],
  },
  iTerm2: {
    simpleIcon: siIterm2,
    aliases: ["iTerm", "iTerm2", "iTerm 2", "iterm", "iterm2"],
  },
  Finder: {
    aliases: ["finder", "Finder"],
  },
  WeChat: {
    simpleIcon: siWechat,
    aliases: ["wechat", "WeChat", "微信"],
  },
  Zoom: {
    simpleIcon: siZoom,
    aliases: ["zoom.us", "Zoom", "zoom"],
  },
  Xcode: {
    simpleIcon: siXcode,
    aliases: ["Xcode", "xcode"],
  },
  Spotify: {
    simpleIcon: siSpotify,
    aliases: ["Spotify", "spotify"],
  },
  Postman: {
    simpleIcon: siPostman,
    aliases: ["Postman", "postman"],
  },
  Cursor: {
    aliases: ["Cursor", "cursor"],
  },
  Windsurf: {
    simpleIcon: siWindsurf,
    aliases: ["Windsurf", "windsurf"],
  },
  "Claude Code": {
    simpleIcon: siClaude,
    aliases: ["Claude Code", "claude-code", "claude code"],
  },
  Kiro: {
    aliases: ["Kiro", "kiro"],
  },
};

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
 * Check if an application is popular
 * @param appName - The application name
 * @returns True if the app is in the popular list
 */
export function isPopularApp(appName: string): boolean {
  return findPopularApp(appName) !== null;
}
