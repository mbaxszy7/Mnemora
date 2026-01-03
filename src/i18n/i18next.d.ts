/**
 * Type declarations for react-i18next
 * This enables type-safe translation keys with autocomplete
 *
 * Usage: t("common.buttons.save") will have autocomplete and type checking
 */
import "i18next";
import enTranslations from "@shared/locales/en.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof enTranslations;
    };
  }
}
