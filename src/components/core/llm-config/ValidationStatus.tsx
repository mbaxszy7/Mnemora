import { useTranslation } from "react-i18next";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import type { LLMValidationResult, CapabilityValidationResult } from "@shared/llm-config-types";

export interface ValidationStatusProps {
  /** Whether validation is currently in progress */
  isValidating: boolean;
  /** The validation result (null if not yet validated) */
  result: LLMValidationResult | null;
  /** Which capabilities to show (for separate mode, only show relevant ones) */
  capabilities?: ("textCompletion" | "vision" | "embedding")[];
}

interface CapabilityStatusProps {
  label: string;
  isValidating: boolean;
  result?: CapabilityValidationResult;
}

function CapabilityStatus({ label, isValidating, result }: CapabilityStatusProps) {
  const { t } = useTranslation();

  if (isValidating) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{label}</span>
        <span className="text-sm">({t("llmConfig.validation.checking")})</span>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30" />
        <span>{label}</span>
      </div>
    );
  }

  if (result.success) {
    return (
      <div className="flex items-center gap-2 text-green-600 dark:text-green-500">
        <CheckCircle2 className="h-4 w-4" />
        <span>{label}</span>
      </div>
    );
  }

  // Translate error code to localized message
  const errorMessage = result.error
    ? t(`llmConfig.validation.${result.error}`, { defaultValue: result.error })
    : null;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-destructive">
        <XCircle className="h-4 w-4" />
        <span>{label}</span>
      </div>
      {errorMessage && <p className="text-sm text-destructive ml-6">{errorMessage}</p>}
    </div>
  );
}

export function ValidationStatus({
  isValidating,
  result,
  capabilities = ["textCompletion", "vision", "embedding"],
}: ValidationStatusProps) {
  const { t } = useTranslation();

  const capabilityLabels: Record<string, string> = {
    textCompletion: t("llmConfig.validation.textCompletion"),
    vision: t("llmConfig.validation.vision"),
    embedding: t("llmConfig.validation.embedding"),
  };

  return (
    <div className="space-y-3 p-4 rounded-lg border bg-muted/30">
      <div className="flex items-center gap-2">
        {isValidating && (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm font-medium">{t("llmConfig.validation.inProgress")}</span>
          </>
        )}
        {!isValidating && result && (
          <>
            {result.success ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500" />
                <span className="text-sm font-medium text-green-600 dark:text-green-500">
                  {t("llmConfig.validation.success")}
                </span>
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4 text-destructive" />
                <span className="text-sm font-medium text-destructive">
                  {t("llmConfig.validation.failed")}
                </span>
              </>
            )}
          </>
        )}
      </div>

      <div className="space-y-2">
        {capabilities.map((capability) => (
          <CapabilityStatus
            key={capability}
            label={capabilityLabels[capability]}
            isValidating={isValidating}
            result={result?.[capability]}
          />
        ))}
      </div>
    </div>
  );
}
