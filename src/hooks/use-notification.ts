import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import type {
  NotificationClickPayload,
  NotificationToastPayload,
  NotificationPayload,
} from "@shared/notification-types";

function getToastTitleBody(t: (k: string, o?: unknown) => string, n: NotificationPayload) {
  const title = t(n.title, n.data);
  const body = t(n.body, n.data);
  return { title, body };
}

export function useNotification(): void {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const tt = t as unknown as (k: string, o?: unknown) => string;

  const handleClick = useCallback(
    (payload: NotificationClickPayload) => {
      switch (payload.notificationType) {
        case "activity-summary":
          if (typeof payload.data?.windowStart === "number") {
            navigate(`/?window=${payload.data.windowStart}`);
          } else {
            navigate("/");
          }
          return;
        case "llm-broken":
          navigate("/settings/llm-config");
          return;
        case "capture-paused":
          navigate("/settings/capture-sources");
          return;
        case "app-update-available":
        case "app-update-downloaded":
          navigate("/settings");
          return;
        default:
          return;
      }
    },
    [navigate]
  );

  const handleToast = useCallback(
    (payload: NotificationToastPayload) => {
      const n = payload.notification;
      const { title, body } = getToastTitleBody(tt, n);

      if (n.type === "llm-broken") {
        const primary = n.toastActions?.[0];
        toast.error(title, {
          id: n.id,
          description: body,
          duration: Infinity,
          action: primary
            ? {
                label: tt(primary.label),
                onClick: () => navigate("/settings/llm-config"),
              }
            : {
                label: tt("notifications.actions.openLlmConfig"),
                onClick: () => navigate("/settings/llm-config"),
              },
        });
        return;
      }

      if (n.type === "capture-paused") {
        toast.warning(title, {
          id: n.id,
          description: body,
        });
        return;
      }

      if (n.type === "app-update-downloaded") {
        toast.success(title, {
          id: n.id,
          description: body,
          action: {
            label: tt("notifications.actions.openSettingsUpdate"),
            onClick: () => navigate("/settings"),
          },
        });
        return;
      }

      toast.info(title, {
        id: n.id,
        description: body,
      });
    },
    [navigate, tt]
  );

  useEffect(() => {
    const unsubscribe = window.notificationApi.onNotificationClick(handleClick);
    return () => unsubscribe();
  }, [handleClick]);

  useEffect(() => {
    const unsubscribe = window.notificationApi.onNotificationToast(handleToast);
    return () => unsubscribe();
  }, [handleToast]);
}
