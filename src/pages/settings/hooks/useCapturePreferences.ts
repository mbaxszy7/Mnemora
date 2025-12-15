import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { CapturePreferences, PreferencesResponse } from "@shared/capture-source-types";
import type { IPCResult } from "@shared/ipc-types";

export const CAPTURE_PREFERENCES_QUERY_KEY = ["capture-preferences"] as const;

/**
 * Hook to manage capture source preferences (session-level only)
 *
 * Uses useSuspenseQuery for simpler loading state handling (requires Suspense boundary).
 * Implements optimistic updates for immediate UI feedback.
 *
 * @returns Preferences data and mutation functions
 */
export function useCapturePreferences() {
  const queryClient = useQueryClient();

  const query = useSuspenseQuery<IPCResult<PreferencesResponse>>({
    queryKey: CAPTURE_PREFERENCES_QUERY_KEY,
    queryFn: async () => {
      return await window.captureSourceApi.getPreferences();
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const mutation = useMutation({
    mutationFn: async (prefs: Partial<CapturePreferences>) => {
      const result = await window.captureSourceApi.setPreferences(prefs);
      return { result, prefs };
    },

    onMutate: async (newPrefs) => {
      await queryClient.cancelQueries({ queryKey: CAPTURE_PREFERENCES_QUERY_KEY });

      const previousPrefs = queryClient.getQueryData<IPCResult<PreferencesResponse>>(
        CAPTURE_PREFERENCES_QUERY_KEY
      );

      queryClient.setQueryData<IPCResult<PreferencesResponse>>(
        CAPTURE_PREFERENCES_QUERY_KEY,
        (old) => {
          if (!old?.success || !old.data) return old;
          return {
            ...old,
            data: {
              preferences: { ...old.data.preferences, ...newPrefs },
            },
          };
        }
      );

      return { previousPrefs };
    },

    onError: (_err, _newPrefs, context) => {
      if (context?.previousPrefs) {
        queryClient.setQueryData(CAPTURE_PREFERENCES_QUERY_KEY, context.previousPrefs);
      }
    },
  });

  const preferences = query.data?.data?.preferences;

  return {
    ...query,
    preferences,
    updatePreferences: mutation.mutate,
    isUpdating: mutation.isPending,
  };
}
