import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";

import type { IPCResult } from "@shared/ipc-types";
import type {
  OnboardingProgress,
  UpdateUserSettingsRequest,
  UserSettings,
  UserSettingsResponse,
} from "@shared/user-settings-types";
import { isOnboardingProgress } from "@shared/user-settings-types";
import { DEFAULT_CAPTURE_ALLOWED_WINDOWS } from "@shared/user-settings-utils";

export const USER_SETTINGS_QUERY_KEY = ["user-settings"] as const;

const DEFAULT_SETTINGS: UserSettings = {
  capturePrimaryScreenOnly: true,
  captureScheduleEnabled: true,
  captureAllowedWindows: DEFAULT_CAPTURE_ALLOWED_WINDOWS,
  captureManualOverride: "none",
  captureManualOverrideUpdatedAt: null,

  contextRulesEnabled: false,
  contextRulesMarkdown: "",
  contextRulesUpdatedAt: null,
  onboardingProgress: "pending_home",
  onboardingUpdatedAt: null,
};

export function useUserSettings() {
  const queryClient = useQueryClient();

  const query = useSuspenseQuery<IPCResult<UserSettingsResponse>>({
    queryKey: USER_SETTINGS_QUERY_KEY,
    queryFn: async () => {
      return await window.userSettingsApi.get();
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const mutation = useMutation({
    mutationFn: async (patch: UpdateUserSettingsRequest["settings"]) => {
      const result = await window.userSettingsApi.update(patch);
      if (!result.success) {
        throw new Error(result.error?.message ?? "Failed to update user settings");
      }
      return result;
    },

    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: USER_SETTINGS_QUERY_KEY });

      const previous =
        queryClient.getQueryData<IPCResult<UserSettingsResponse>>(USER_SETTINGS_QUERY_KEY);

      queryClient.setQueryData<IPCResult<UserSettingsResponse>>(USER_SETTINGS_QUERY_KEY, (old) => {
        if (!old?.success || !old.data) return old;
        return {
          ...old,
          data: {
            settings: {
              ...old.data.settings,
              ...patch,
            },
          },
        };
      });

      return { previous };
    },

    onError: (_err, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(USER_SETTINGS_QUERY_KEY, context.previous);
      }
    },

    onSuccess: (result) => {
      queryClient.setQueryData(USER_SETTINGS_QUERY_KEY, result);
    },
  });

  const onboardingMutation = useMutation({
    mutationFn: async (progress: OnboardingProgress) => {
      const result = await window.userSettingsApi.setOnboardingProgress(progress);
      if (!result.success) {
        throw new Error(result.error?.message ?? "Failed to update onboarding progress");
      }
      return result;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(USER_SETTINGS_QUERY_KEY, result);
    },
  });

  const settingsRaw =
    query.data?.success && query.data.data ? query.data.data.settings : DEFAULT_SETTINGS;
  const settings: UserSettings = {
    ...settingsRaw,
    onboardingProgress: isOnboardingProgress(settingsRaw.onboardingProgress)
      ? settingsRaw.onboardingProgress
      : "pending_home",
  };

  return {
    ...query,
    settings,
    updateSettings: mutation.mutate,
    updateSettingsAsync: mutation.mutateAsync,
    isUpdating: mutation.isPending,
    setOnboardingProgress: onboardingMutation.mutate,
    setOnboardingProgressAsync: onboardingMutation.mutateAsync,
    isUpdatingOnboarding: onboardingMutation.isPending,
  };
}
