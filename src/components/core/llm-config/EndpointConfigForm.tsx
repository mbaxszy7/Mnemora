import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Eye, EyeOff, HelpCircle } from "lucide-react";
import { isValidUrl } from "@shared/llm-config-utils";
import type { LLMEndpointConfig } from "@shared/llm-config-types";

export interface EndpointConfigFormProps {
  /** Current configuration values */
  value: LLMEndpointConfig;
  /** Callback when configuration changes */
  onChange: (config: LLMEndpointConfig) => void;
  /** Whether the form is disabled */
  disabled?: boolean;
  /** Optional title for the form section */
  title?: string;
}

interface FieldErrors {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export function EndpointConfigForm({
  value,
  onChange,
  disabled = false,
  title,
}: EndpointConfigFormProps) {
  const { t } = useTranslation();
  const [showApiKey, setShowApiKey] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<FieldErrors>({});

  const validateField = useCallback(
    (field: keyof LLMEndpointConfig, fieldValue: string): string | undefined => {
      if (field === "baseUrl") {
        if (!fieldValue.trim()) {
          return t("llmConfig.errors.requiredField");
        }
        if (!isValidUrl(fieldValue)) {
          return t("llmConfig.errors.invalidUrl");
        }
      } else if (field === "apiKey" || field === "model") {
        if (!fieldValue.trim()) {
          return t("llmConfig.errors.requiredField");
        }
      }
      return undefined;
    },
    [t]
  );

  const handleChange = useCallback(
    (field: keyof LLMEndpointConfig, fieldValue: string) => {
      const newConfig = { ...value, [field]: fieldValue };
      onChange(newConfig);

      // Validate on change if field was already touched
      if (touched[field]) {
        const error = validateField(field, fieldValue);
        setErrors((prev) => ({ ...prev, [field]: error }));
      }
    },
    [value, onChange, touched, validateField]
  );

  const handleBlur = useCallback(
    (field: keyof LLMEndpointConfig) => {
      setTouched((prev) => ({ ...prev, [field]: true }));
      const error = validateField(field, value[field]);
      setErrors((prev) => ({ ...prev, [field]: error }));
    },
    [value, validateField]
  );

  const toggleApiKeyVisibility = useCallback(() => {
    setShowApiKey((prev) => !prev);
  }, []);

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {title && <h3 className="text-lg font-semibold">{title}</h3>}

        {/* Base URL Field */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="baseUrl">{t("llmConfig.fields.baseUrl.label")}</Label>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">{t("llmConfig.fields.baseUrl.tooltip")}</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <Input
            id="baseUrl"
            type="url"
            placeholder={t("llmConfig.fields.baseUrl.placeholder")}
            value={value.baseUrl}
            onChange={(e) => handleChange("baseUrl", e.target.value)}
            onBlur={() => handleBlur("baseUrl")}
            disabled={disabled}
            className={errors.baseUrl && touched.baseUrl ? "border-destructive" : ""}
          />
          {errors.baseUrl && touched.baseUrl && (
            <p className="text-sm text-destructive">{errors.baseUrl}</p>
          )}
        </div>

        {/* API Key Field */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="apiKey">{t("llmConfig.fields.apiKey.label")}</Label>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">{t("llmConfig.fields.apiKey.tooltip")}</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="relative">
            <Input
              id="apiKey"
              type={showApiKey ? "text" : "password"}
              placeholder={t("llmConfig.fields.apiKey.placeholder")}
              value={value.apiKey}
              onChange={(e) => handleChange("apiKey", e.target.value)}
              onBlur={() => handleBlur("apiKey")}
              disabled={disabled}
              className={`pr-10 ${errors.apiKey && touched.apiKey ? "border-destructive" : ""}`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
              onClick={toggleApiKeyVisibility}
              disabled={disabled}
              aria-label={
                showApiKey ? t("llmConfig.buttons.hideApiKey") : t("llmConfig.buttons.showApiKey")
              }
            >
              {showApiKey ? (
                <EyeOff className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Eye className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          </div>
          {errors.apiKey && touched.apiKey && (
            <p className="text-sm text-destructive">{errors.apiKey}</p>
          )}
        </div>

        {/* Model Field */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="model">{t("llmConfig.fields.model.label")}</Label>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p className="max-w-xs">{t("llmConfig.fields.model.tooltip")}</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <Input
            id="model"
            type="text"
            placeholder={t("llmConfig.fields.model.placeholder")}
            value={value.model}
            onChange={(e) => handleChange("model", e.target.value)}
            onBlur={() => handleBlur("model")}
            disabled={disabled}
            className={errors.model && touched.model ? "border-destructive" : ""}
          />
          {errors.model && touched.model && (
            <p className="text-sm text-destructive">{errors.model}</p>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
