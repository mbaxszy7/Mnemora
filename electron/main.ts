import { app, BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { initialize as initializeAISDK } from './services/ai-sdk'
import { registerVLMHandlers } from './ipc/vlm-handlers'

// createRequire is available for dynamic requires if needed
void createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

/**
 * Initialize AI SDK with API key from environment
 * Logs warning if API key is not configured
 */
function initializeServices() {
  try {
    // Initialize AI SDK - will use OPENAI_API_KEY from environment
    initializeAISDK({
      name:"MOONSHOT",
      baseURL:"https://api.moonshot.cn/v1",
      model:"kimi-latest",
      apiKey:"sk-mvcB7z8Kgln2zzEWf8V7FRVAdX8nIy09BsySNb1S4CnR9Vsg"
    })
    console.log('[AI SDK] Initialized successfully')
  } catch (error) {
    // Log warning but don't crash - user can configure API key later
    console.warn('[AI SDK] Initialization warning:', error instanceof Error ? error.message : error)
  }

  // Register IPC handlers for VLM operations
  registerVLMHandlers()
  console.log('[IPC] VLM handlers registered')
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  // Initialize services before creating window
  initializeServices()
  createWindow()
})
