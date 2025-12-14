import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { CapturePreferences, PreferencesResponse } from "@shared/capture-source-types";
import type { IPCResult } from "@shared/ipc-types";

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
    queryKey: ["capture-preferences"],
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
      await queryClient.cancelQueries({ queryKey: ["capture-preferences"] });

      const previousPrefs = queryClient.getQueryData<IPCResult<PreferencesResponse>>([
        "capture-preferences",
      ]);

      queryClient.setQueryData<IPCResult<PreferencesResponse>>(["capture-preferences"], (old) => {
        if (!old?.success || !old.data) return old;
        return {
          ...old,
          data: {
            preferences: { ...old.data.preferences, ...newPrefs },
          },
        };
      });

      return { previousPrefs };
    },

    onError: (_err, _newPrefs, context) => {
      if (context?.previousPrefs) {
        queryClient.setQueryData(["capture-preferences"], context.previousPrefs);
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
