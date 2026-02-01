/**
 * Type declarations for react-i18next
 * This enables type-safe translation keys with autocomplete
 *
 * Usage: t("common.buttons.save") will have autocomplete and type checking
 */
import "i18next";
import enTranslations from "@shared/locales/en.json";

type TranslationResources = typeof enTranslations & {
  threadLens?: {
    status?: {
      active?: string;
      inactive?: string;
      closed?: string;
    };
    brief?: {
      unavailableTitle?: string;
      unavailableBody?: string;
      errorTitle?: string;
      errorBody?: string;
      openMonitoring?: string;
      retry?: string;
    };
  };
};

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: TranslationResources;
    };
  }
}
