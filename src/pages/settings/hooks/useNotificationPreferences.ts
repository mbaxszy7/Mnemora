import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";

import type { IPCResult } from "@shared/ipc-types";
import type {
  NotificationPreferences,
  NotificationPreferencesResponse,
  NotificationPreferencesRequest,
} from "@shared/notification-types";

export const NOTIFICATION_PREFERENCES_QUERY_KEY = ["notification-preferences"] as const;

const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: true,
  activitySummary: true,
  llmErrors: true,
  capturePaused: true,
  soundEnabled: true,
  doNotDisturb: false,
  doNotDisturbFrom: "22:00",
  doNotDisturbTo: "08:00",
};

export function useNotificationPreferences() {
  const queryClient = useQueryClient();

  const query = useSuspenseQuery<IPCResult<NotificationPreferencesResponse>>({
    queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY,
    queryFn: async () => {
      return await window.notificationApi.getPreferences();
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const mutation = useMutation({
    mutationFn: async (patch: NotificationPreferencesRequest["preferences"]) => {
      const result = await window.notificationApi.updatePreferences(patch);
      if (!result.success) {
        throw new Error(result.error?.message ?? "Failed to update notification preferences");
      }
      return result;
    },

    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY });

      const previous = queryClient.getQueryData<IPCResult<NotificationPreferencesResponse>>(
        NOTIFICATION_PREFERENCES_QUERY_KEY
      );

      queryClient.setQueryData<IPCResult<NotificationPreferencesResponse>>(
        NOTIFICATION_PREFERENCES_QUERY_KEY,
        (old) => {
          if (!old?.success || !old.data) return old;
          return {
            ...old,
            data: {
              preferences: {
                ...old.data.preferences,
                ...patch,
              },
            },
          };
        }
      );

      return { previous };
    },

    onError: (_err, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(NOTIFICATION_PREFERENCES_QUERY_KEY, context.previous);
      }
    },

    onSuccess: (result) => {
      queryClient.setQueryData(NOTIFICATION_PREFERENCES_QUERY_KEY, result);
    },
  });

  const preferences: NotificationPreferences =
    query.data?.success && query.data.data ? query.data.data.preferences : DEFAULT_PREFERENCES;

  return {
    ...query,
    preferences,
    updatePreferences: mutation.mutate,
    updatePreferencesAsync: mutation.mutateAsync,
    isUpdating: mutation.isPending,
  };
}
