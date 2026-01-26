/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    APP_ROOT: string;
    /** /dist/ or /public/ */
    VITE_PUBLIC: string;
  }
}

// Used in Renderer process, expose in `preload.ts`
// Types are imported from shared module
interface Window {
  ipcRenderer: import("electron").IpcRenderer;
  i18nApi: {
    changeLanguage(lang: import("../shared/i18n-types").SupportedLanguage): Promise<void>;
    getLanguage(): Promise<import("../shared/i18n-types").SupportedLanguage>;
    getSystemLanguage(): Promise<import("../shared/i18n-types").SupportedLanguage>;
  };
  databaseApi: {
    settings: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string): Promise<void>;
      getAll(): Promise<Array<{ key: string; value: string | null }>>;
    };
    memories: {
      getAll(options?: { limit?: number; offset?: number }): Promise<unknown[]>;
      get(id: number): Promise<unknown | undefined>;
      create(data: unknown): Promise<unknown>;
      update(id: number, data: unknown): Promise<unknown | undefined>;
      delete(id: number): Promise<void>;
    };
    screenshots: {
      getAll(options?: { limit?: number; offset?: number }): Promise<unknown[]>;
      getDaily: (
        range: import("../shared/ipc-types").UsageTimeRangePayload
      ) => Promise<
        import("../shared/ipc-types").IPCResult<import("../shared/ipc-types").UsageDailyItem[]>
      >;
    };
  };
  llmConfigApi: {
    check(): Promise<import("../shared/llm-config-types").LLMConfigCheckResult>;
    validate(
      config: import("../shared/llm-config-types").LLMConfig
    ): Promise<import("../shared/llm-config-types").LLMValidationResult>;
    save(config: import("../shared/llm-config-types").LLMConfig): Promise<void>;
    get(): Promise<import("../shared/llm-config-types").LLMConfig | null>;
  };
  permissionApi: {
    check(): Promise<
      import("../shared/ipc-types").IPCResult<import("../shared/ipc-types").PermissionCheckResult>
    >;
    requestScreenRecording(): Promise<import("../shared/ipc-types").IPCResult<boolean>>;
    requestAccessibility(): Promise<import("../shared/ipc-types").IPCResult<boolean>>;
    openScreenRecordingSettings(): Promise<import("../shared/ipc-types").IPCResult<void>>;
    openAccessibilitySettings(): Promise<import("../shared/ipc-types").IPCResult<void>>;
    onStatusChanged(
      callback: (payload: import("../shared/ipc-types").PermissionCheckResult) => void
    ): () => void;
  };
  // TEMPORARY: Screen capture API - remove later
  screenCaptureApi: {
    start(): Promise<import("../shared/ipc-types").IPCResult<void>>;
    stop(): Promise<import("../shared/ipc-types").IPCResult<void>>;
    pause(): Promise<import("../shared/ipc-types").IPCResult<void>>;
    resume(): Promise<import("../shared/ipc-types").IPCResult<void>>;
    getState(): Promise<
      import("../shared/ipc-types").IPCResult<import("../shared/ipc-types").SchedulerStatePayload>
    >;
    onStateChanged(
      callback: (payload: import("../shared/ipc-types").SchedulerStatePayload) => void
    ): () => void;
  };
  userSettingsApi: {
    get(): Promise<
      import("../shared/ipc-types").IPCResult<
        import("../shared/user-settings-types").UserSettingsResponse
      >
    >;
    update(
      settings: import("../shared/user-settings-types").UpdateUserSettingsRequest["settings"]
    ): Promise<
      import("../shared/ipc-types").IPCResult<
        import("../shared/user-settings-types").UserSettingsResponse
      >
    >;
    setCaptureOverride(
      mode: import("../shared/user-settings-types").CaptureManualOverride
    ): Promise<
      import("../shared/ipc-types").IPCResult<
        import("../shared/user-settings-types").UserSettingsResponse
      >
    >;
  };
  captureSourceApi: {
    initServices(): Promise<import("../shared/ipc-types").IPCResult<boolean>>;
    getScreens(): Promise<
      import("../shared/ipc-types").IPCResult<
        import("../shared/capture-source-types").GetScreensResponse
      >
    >;
    getApps(): Promise<
      import("../shared/ipc-types").IPCResult<
        import("../shared/capture-source-types").GetAppsResponse
      >
    >;
    getPreferences(): Promise<
      import("../shared/ipc-types").IPCResult<
        import("../shared/capture-source-types").PreferencesResponse
      >
    >;
    setPreferences(
      preferences: Partial<import("../shared/capture-source-types").CapturePreferences>
    ): Promise<
      import("../shared/ipc-types").IPCResult<
        import("../shared/capture-source-types").PreferencesResponse
      >
    >;
  };
  contextGraphApi: {
    search(
      query: import("../shared/context-types").SearchQuery
    ): Promise<
      import("../shared/ipc-types").IPCResult<import("../shared/context-types").SearchResult>
    >;
    cancelSearch(): Promise<import("../shared/ipc-types").IPCResult<boolean>>;
    getThread(
      threadId: string
    ): Promise<
      import("../shared/ipc-types").IPCResult<
        import("../shared/context-types").ExpandedContextNode[]
      >
    >;
    getEvidence(
      nodeIds: number[]
    ): Promise<
      import("../shared/ipc-types").IPCResult<
        import("../shared/context-types").ScreenshotEvidence[]
      >
    >;
  };
  usageApi: {
    getSummary(
      range: import("../shared/ipc-types").UsageTimeRangePayload
    ): Promise<
      import("../shared/ipc-types").IPCResult<import("../shared/ipc-types").UsageSummaryResult>
    >;
    getDaily(
      range: import("../shared/ipc-types").UsageTimeRangePayload
    ): Promise<
      import("../shared/ipc-types").IPCResult<import("../shared/ipc-types").UsageDailyItem[]>
    >;
    getBreakdown(
      range: import("../shared/ipc-types").UsageTimeRangePayload
    ): Promise<
      import("../shared/ipc-types").IPCResult<import("../shared/ipc-types").UsageBreakdownItem[]>
    >;
  };
  appApi: {
    onNavigate(callback: (path: string) => void): () => void;
  };
  activityMonitorApi: {
    getTimeline(req: {
      fromTs: number;
      toTs: number;
    }): Promise<
      import("../shared/ipc-types").IPCResult<import("../shared/activity-types").TimelineResponse>
    >;
    onTimelineChanged(
      callback: (payload: import("../shared/activity-types").ActivityTimelineChangedPayload) => void
    ): () => void;
    getSummary(req: {
      windowStart: number;
      windowEnd: number;
    }): Promise<
      import("../shared/ipc-types").IPCResult<
        import("../shared/activity-types").WindowSummary | null
      >
    >;
    getEventDetails(req: {
      eventId: number;
    }): Promise<
      import("../shared/ipc-types").IPCResult<import("../shared/activity-types").ActivityEvent>
    >;
    regenerateSummary(req: {
      windowStart: number;
      windowEnd: number;
    }): Promise<
      import("../shared/ipc-types").IPCResult<
        import("../shared/activity-types").RegenerateSummaryResponse
      >
    >;
  };
  monitoringApi: {
    openDashboard(): Promise<
      import("../shared/ipc-types").IPCResult<
        import("../shared/ipc-types").MonitoringOpenDashboardResult
      >
    >;
  };
}
