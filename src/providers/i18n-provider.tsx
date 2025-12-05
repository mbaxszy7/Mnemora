import { Suspense, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";

interface I18nProviderProps {
  children: ReactNode;
}

/**
 * Loading fallback component during i18n initialization
 */
function I18nLoadingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-muted-foreground">Loading...</div>
    </div>
  );
}

/**
 * I18nProvider wraps the application with i18next context
 * Uses Suspense to handle async loading of translations
 */
export function I18nProvider({ children }: I18nProviderProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <Suspense fallback={<I18nLoadingFallback />}>{children}</Suspense>
    </I18nextProvider>
  );
}

export default I18nProvider;
