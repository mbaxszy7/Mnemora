/* eslint-disable @typescript-eslint/no-var-requires */
const path = require("node:path");
const fs = require("node:fs");
const { execSync } = require("node:child_process");

const electronCacheRoot = path.resolve(__dirname, ".electron-cache");
const fallbackElectronMirror = "https://npmmirror.com/mirrors/electron/";
const appDisplayName = process.env.MNEMORA_APP_NAME ?? "Mnemora";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const electronChecksums = require("electron/checksums.json");

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function findCachedElectronZip(fileName) {
  if (!fileExists(electronCacheRoot)) {
    return null;
  }

  try {
    const entries = fs.readdirSync(electronCacheRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(electronCacheRoot, entry.name, fileName);
      if (fileExists(candidate)) return candidate;
    }
  } catch {
    // ignore
  }

  return null;
}

function ensureWindowInspectorBuilt() {
  // The build output is a folder containing the executable + _internal runtime.
  const inspectorDir = path.resolve(
    __dirname,
    "externals/python/window_inspector/dist/window_inspector"
  );

  if (fileExists(inspectorDir)) {
    return inspectorDir;
  }

  execSync("pnpm run build:window_inspector", { stdio: "inherit" });

  if (!fileExists(inspectorDir)) {
    throw new Error(
      `window_inspector output not found at ${inspectorDir}. Did build:window_inspector succeed?`
    );
  }

  // PyInstaller output can contain absolute symlinks from the CI build path
  // (e.g. /Users/runner/work/...). Rewrite them to package-local relative
  // symlinks before copying into the app bundle.
  normalizeWindowInspectorSymlinks(inspectorDir);

  return inspectorDir;
}

function resolvePackagedResourcesDir(buildPath) {
  // Electron Packager layout:
  // - win/linux: <buildPath>/resources
  // - macOS:     <buildPath>/<App>.app/Contents/Resources
  // Forge's packageAfterCopy hook may pass the *app dir* (i.e. .../Resources/app).
  const directResourcesParent = (() => {
    const parent = path.dirname(buildPath);
    if (path.basename(buildPath) === "app") {
      const parentBase = path.basename(parent);
      if (parentBase === "resources" || parentBase === "Resources") {
        return parent;
      }
    }
    return null;
  })();

  const resourcesCandidates = [
    ...(directResourcesParent ? [directResourcesParent] : []),
    path.join(buildPath, "resources"),
    path.join(buildPath, "Resources"),
  ];

  const resourcesDir =
    resourcesCandidates.find((p) => fileExists(p)) ??
    (() => {
      const apps = fs
        .readdirSync(buildPath, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.endsWith(".app"))
        .map((d) => path.join(buildPath, d.name, "Contents", "Resources"));
      return apps.find((p) => fileExists(p));
    })();

  if (!resourcesDir) {
    throw new Error(`Unable to locate packaged Resources directory under: ${buildPath}`);
  }

  return resourcesDir;
}

function copyWindowInspectorIntoResources({ buildPath }) {
  if (process.platform !== "darwin") {
    return;
  }

  const inspectorDir = ensureWindowInspectorBuilt();
  const resourcesDir = resolvePackagedResourcesDir(buildPath);

  // Matches runtime usage: `process.resourcesPath/bin/window_inspector/window_inspector`
  const destDir = path.join(resourcesDir, "bin", "window_inspector");
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(inspectorDir, destDir, { recursive: true });
  rewriteWindowInspectorAbsoluteSymlinks({ inspectorDir, destDir });

  const exePath = path.join(destDir, "window_inspector");
  if (fileExists(exePath)) {
    fs.chmodSync(exePath, 0o755);
  }
}

function walkDirectory(rootDir, visit) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      visit(fullPath, entry);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
}

function rewriteWindowInspectorAbsoluteSymlinks({ inspectorDir, destDir }) {
  const sourcePrefix = `${inspectorDir}${path.sep}`;
  const marker = `${path.sep}window_inspector${path.sep}`;

  walkDirectory(destDir, (fullPath, entry) => {
    if (!entry.isSymbolicLink()) return;

    let target = "";
    try {
      target = fs.readlinkSync(fullPath);
    } catch {
      return;
    }

    if (!path.isAbsolute(target)) return;

    let mappedTarget = "";
    if (target.startsWith(sourcePrefix)) {
      mappedTarget = path.join(destDir, path.relative(inspectorDir, target));
    } else {
      const markerIndex = target.lastIndexOf(marker);
      if (markerIndex < 0) return;
      const insideWindowInspector = target.slice(markerIndex + marker.length);
      mappedTarget = path.join(destDir, insideWindowInspector);
    }

    const relativeTarget = path.relative(path.dirname(fullPath), mappedTarget) || ".";
    fs.unlinkSync(fullPath);
    fs.symlinkSync(relativeTarget, fullPath);
  });
}

function normalizeWindowInspectorSymlinks(inspectorDir) {
  const marker = `${path.sep}window_inspector${path.sep}`;

  walkDirectory(inspectorDir, (fullPath, entry) => {
    if (!entry.isSymbolicLink()) return;

    let target = "";
    try {
      target = fs.readlinkSync(fullPath);
    } catch {
      return;
    }

    if (!path.isAbsolute(target)) return;

    const markerIndex = target.lastIndexOf(marker);
    if (markerIndex < 0) return;

    const insideWindowInspector = target.slice(markerIndex + marker.length);
    const mappedTarget = path.join(inspectorDir, insideWindowInspector);
    const relativeTarget = path.relative(path.dirname(fullPath), mappedTarget) || ".";

    fs.unlinkSync(fullPath);
    fs.symlinkSync(relativeTarget, fullPath);
  });
}

function copyLocalesIntoResources({ buildPath }) {
  const resourcesDir = resolvePackagedResourcesDir(buildPath);
  const localesSrc = path.resolve(__dirname, "shared", "locales");
  const localesDest = path.join(resourcesDir, "shared", "locales");

  if (!fileExists(localesSrc)) {
    throw new Error(`Locales source folder not found at: ${localesSrc}`);
  }

  fs.rmSync(localesDest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(localesDest), { recursive: true });
  fs.cpSync(localesSrc, localesDest, { recursive: true });
}

function writeBuildMetadataIntoResources({ buildPath }) {
  const resourcesDir = resolvePackagedResourcesDir(buildPath);
  const metadataDest = path.join(resourcesDir, "shared", "build-metadata.json");
  const metadata = {
    channel: process.env.MNEMORA_UPDATE_CHANNEL ?? "stable",
    buildSha: process.env.MNEMORA_BUILD_SHA ?? null,
    builtAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(metadataDest), { recursive: true });
  fs.writeFileSync(metadataDest, JSON.stringify(metadata, null, 2), "utf8");
}

function rebuildNativeModules() {
  // Replacement for @electron-forge/plugin-electron-rebuild:
  // rely on the repo's existing `electron-rebuild` workflow.
  execSync("pnpm run rebuild:sqlite", { stdio: "inherit" });
}

function getElectronZipFileName({ version, platform, arch }) {
  return `electron-v${version}-${platform}-${arch}.zip`;
}

function getElectronGitHubAssetURL({ version, fileName }) {
  return `https://github.com/electron/electron/releases/download/v${version}/${fileName}`;
}

function getElectronMirrorAssetURL({ mirror, version, fileName }) {
  const base = mirror.endsWith("/") ? mirror : `${mirror}/`;
  return new URL(`v${version}/${fileName}`, base).toString();
}

function getElectronCachePathForURL({ downloadUrl, fileName }) {
  // Use @electron/get's Cache implementation to ensure the cache key matches exactly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Cache } = require("@electron/get/dist/cjs/Cache");
  const dir = Cache.getCacheDirectory(downloadUrl);
  return path.resolve(electronCacheRoot, dir, fileName);
}

function seedElectronCacheForURL({ downloadUrl, fileName, sourceZipPath }) {
  const destPath = getElectronCachePathForURL({ downloadUrl, fileName });
  if (fileExists(destPath)) {
    return destPath;
  }
  ensureDir(path.dirname(destPath));
  fs.copyFileSync(sourceZipPath, destPath);
  return destPath;
}

async function ensureElectronDownloaded({ platform, arch }) {
  const { downloadArtifact } = require("@electron/get");
  const electronVersion = require("electron/package.json").version;

  const fileName = getElectronZipFileName({ version: electronVersion, platform, arch });
  const gitHubUrl = getElectronGitHubAssetURL({ version: electronVersion, fileName });
  const mirrorUrl = getElectronMirrorAssetURL({
    mirror: process.env.ELECTRON_MIRROR ?? fallbackElectronMirror,
    version: electronVersion,
    fileName,
  });

  // If we already have the ZIP cached (even from a different mirror), seed the cache
  // for the URL that electron-packager will use (GitHub by default), so packager
  // won't attempt a network fetch later.
  const existingZip = findCachedElectronZip(fileName);
  if (existingZip) {
    seedElectronCacheForURL({ downloadUrl: gitHubUrl, fileName, sourceZipPath: existingZip });
    seedElectronCacheForURL({ downloadUrl: mirrorUrl, fileName, sourceZipPath: existingZip });
    return;
  }

  const downloadWithMirror = async (mirror) => {
    return downloadArtifact({
      version: electronVersion,
      platform,
      arch,
      artifactName: "electron",
      cacheRoot: electronCacheRoot,
      checksums: electronChecksums,
      ...(mirror ? { mirrorOptions: { mirror } } : {}),
    });
  };

  if (process.env.ELECTRON_MIRROR) {
    await downloadWithMirror(process.env.ELECTRON_MIRROR);
    const downloaded = findCachedElectronZip(fileName);
    if (downloaded) {
      seedElectronCacheForURL({ downloadUrl: gitHubUrl, fileName, sourceZipPath: downloaded });
    }
    return;
  }

  try {
    await downloadWithMirror(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shouldFallback =
      message.includes("github.com") &&
      (message.includes("ENOTFOUND") || message.includes("EAI_AGAIN") || message.includes("ECONNRESET"));

    if (!shouldFallback) {
      throw error;
    }

    process.env.ELECTRON_MIRROR = fallbackElectronMirror;
    await downloadWithMirror(process.env.ELECTRON_MIRROR);

    const downloaded = findCachedElectronZip(fileName);
    if (downloaded) {
      seedElectronCacheForURL({ downloadUrl: gitHubUrl, fileName, sourceZipPath: downloaded });
    }
  }
}

module.exports = {
  packagerConfig: {
    name: appDisplayName,
    appBundleId: "com.mnemora.app",
    icon: "public/logo",
    asar: {
      // Sharp (libvips) ships `.dylib` dependencies that must live on disk, not inside `app.asar`.
      // `plugin-auto-unpack-natives` adds `**/*.node`; we also unpack `.dylib` for macOS runtime.
      unpack: "**/*.{dylib,node}",
    },
    // Ensure Electron downloads are cached in-repo. This also makes it possible to
    // pre-download the Electron ZIP in `prePackage` and avoid flaky network/DNS.
    download: {
      cacheRoot: electronCacheRoot,
      // Prevent @electron/get from hitting GitHub for SHASUMS256.txt in offline/DNS-restricted environments.
      // Electron's npm package ships the checksums for the pinned Electron version.
      checksums: electronChecksums,
    },
    // Keep packages small. Runtime relies on `dist/`, `dist-electron/` and prod deps.
    ignore: [
      /^\/\.git($|\/)/,
      /^\/\.vscode($|\/)/,
      /^\/docs($|\/)/,
      /^\/release($|\/)/,
      /^\/scripts($|\/)/,
      /^\/src($|\/)/,
      /^\/electron($|\/)/,
      /^\/shared($|\/)/,
      /^\/externals($|\/)/,
      /^\/\.electron-dev($|\/)/,
      /^\/node_modules\/\.cache($|\/)/,
      /^\/.*\.traineddata$/i,
    ],
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "mnemora",
        authors: "Mnemora",
        description: "Mnemora - Your Second Brain",
      },
    },
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        // Unsigned DMG for manual distribution (no notarization yet).
        format: "UDZO",
        additionalDMGOptions: {
          filesystem: "APFS",
        },
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    // Note: @electron-forge/maker-appimage is not available on npm.
    // Use electron-builder for Linux AppImage builds instead.
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: "mbaxszy7",
          name: "Mnemora",
        },
        draft: false,
        prerelease: false,
      },
    },
  ],
  plugins: [
    // Note: @electron-forge/plugin-electron-rebuild does not exist.
    // Use @electron/rebuild via pnpm run rebuild:sqlite instead.
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
  ],
  hooks: {
    prePackage: async (_forgeConfig, platform, arch) => {
      const effectivePlatform = platform ?? process.platform;
      await ensureElectronDownloaded({
        platform: effectivePlatform,
        arch: arch ?? process.arch,
      });

      if (effectivePlatform === "darwin") {
        execSync("pnpm -s run build:window_inspector", { stdio: "inherit" });
        ensureWindowInspectorBuilt();
      }

      execSync("pnpm -s vite build", { stdio: "inherit" });
      rebuildNativeModules();
    },
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      copyWindowInspectorIntoResources({ buildPath });
      copyLocalesIntoResources({ buildPath });
      writeBuildMetadataIntoResources({ buildPath });
    },
  },
};
