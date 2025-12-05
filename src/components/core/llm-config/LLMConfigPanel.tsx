import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Save, Loader2, ArrowLeft } from "lucide-react";
import { EndpointConfigForm } from "./EndpointConfigForm";
import { ValidationStatus } from "./ValidationStatus";
import { isEndpointConfigComplete } from "@shared/llm-config-utils";
import { useViewTransition } from "@/components/core/view-transition";
import type {
  LLMConfig,
  LLMConfigMode,
  LLMEndpointConfig,
  LLMValidationResult,
} from "@shared/llm-config-types";

const emptyEndpoint: LLMEndpointConfig = { baseUrl: "", apiKey: "", model: "" };

interface LLMConfigPanelProps {
  showBackButton?: boolean;
  onSaveSuccess?: () => void;
}

export function LLMConfigPanel({ showBackButton = false, onSaveSuccess }: LLMConfigPanelProps) {
  const { t } = useTranslation();
  const { navigate } = useViewTransition();

  const [mode, setMode] = useState<LLMConfigMode>("unified");
  const [unifiedConfig, setUnifiedConfig] = useState<LLMEndpointConfig>(emptyEndpoint);
  const [vlmConfig, setVlmConfig] = useState<LLMEndpointConfig>(emptyEndpoint);
  const [textLlmConfig, setTextLlmConfig] = useState<LLMEndpointConfig>(emptyEndpoint);
  const [embeddingConfig, setEmbeddingConfig] = useState<LLMEndpointConfig>(emptyEndpoint);

  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<LLMValidationResult | null>(null);

  // Load existing configuration on mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const config = await window.llmConfigApi.get();
        if (config) {
          setMode(config.mode);
          if (config.mode === "unified") {
            setUnifiedConfig(config.config);
          } else {
            setVlmConfig(config.vlm);
            setTextLlmConfig(config.textLlm);
            setEmbeddingConfig(config.embeddingLlm);
          }
        }
      } catch {
        // Ignore load errors - user will configure fresh
      }
    };
    loadConfig();
  }, []);

  const buildConfig = useCallback((): LLMConfig => {
    if (mode === "unified") {
      return { mode: "unified", config: unifiedConfig };
    }
    return {
      mode: "separate",
      vlm: vlmConfig,
      textLlm: textLlmConfig,
      embeddingLlm: embeddingConfig,
    };
  }, [mode, unifiedConfig, vlmConfig, textLlmConfig, embeddingConfig]);

  const isFormComplete = useCallback((): boolean => {
    if (mode === "unified") {
      return isEndpointConfigComplete(unifiedConfig);
    }
    return (
      isEndpointConfigComplete(vlmConfig) &&
      isEndpointConfigComplete(textLlmConfig) &&
      isEndpointConfigComplete(embeddingConfig)
    );
  }, [mode, unifiedConfig, vlmConfig, textLlmConfig, embeddingConfig]);

  const handleSubmit = useCallback(async () => {
    if (!isFormComplete()) {
      toast.error(t("llmConfig.errors.incompleteConfig"));
      return;
    }

    setIsValidating(true);
    setValidationResult(null);

    try {
      const config = buildConfig();
      const result = await window.llmConfigApi.validate(config);
      setValidationResult(result);

      if (result.success) {
        await window.llmConfigApi.save(config);
        toast.success(t("llmConfig.messages.saveSuccess"));
        onSaveSuccess?.();
      } else {
        toast.error(t("llmConfig.validation.failed"));
      }
    } catch {
      toast.error(t("llmConfig.messages.saveFailed"));
    } finally {
      setIsValidating(false);
    }
  }, [isFormComplete, buildConfig, onSaveSuccess, t]);

  const handleModeChange = useCallback((value: string) => {
    setMode(value as LLMConfigMode);
    setValidationResult(null);
  }, []);

  const handleBack = useCallback(() => {
    navigate("/settings", { type: "slide-right", duration: 300 });
  }, [navigate]);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="space-y-2">
        {showBackButton && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBack}
            className="mb-2"
            disabled={isValidating}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("settings.title")}
          </Button>
        )}
        <div>
          <h1 className="text-3xl font-bold">{t("llmConfig.title")}</h1>
          <p className="text-muted-foreground mt-2">{t("llmConfig.description")}</p>
        </div>
      </div>

      <Tabs value={mode} onValueChange={handleModeChange} className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="unified" disabled={isValidating}>
            {t("llmConfig.modes.unified")}
          </TabsTrigger>
          <TabsTrigger value="separate" disabled={isValidating}>
            {t("llmConfig.modes.separate")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="unified" className="space-y-4 mt-4">
          <Alert>
            <AlertTriangle className="h-4 w-4 text-blue-500!" />
            <AlertDescription>{t("llmConfig.warnings.unifiedMode")}</AlertDescription>
          </Alert>
          <EndpointConfigForm
            value={unifiedConfig}
            onChange={setUnifiedConfig}
            disabled={isValidating}
          />
        </TabsContent>

        <TabsContent value="separate" className="space-y-6 mt-4">
          <EndpointConfigForm
            title={t("llmConfig.sections.vlm")}
            value={vlmConfig}
            onChange={setVlmConfig}
            disabled={isValidating}
          />
          <EndpointConfigForm
            title={t("llmConfig.sections.textLlm")}
            value={textLlmConfig}
            onChange={setTextLlmConfig}
            disabled={isValidating}
          />
          <EndpointConfigForm
            title={t("llmConfig.sections.embeddingLlm")}
            value={embeddingConfig}
            onChange={setEmbeddingConfig}
            disabled={isValidating}
          />
        </TabsContent>
      </Tabs>

      {(isValidating || validationResult) && (
        <ValidationStatus isValidating={isValidating} result={validationResult} />
      )}

      <Button
        className="w-full"
        onClick={handleSubmit}
        disabled={isValidating || !isFormComplete()}
      >
        {isValidating ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("llmConfig.validation.inProgress")}
          </>
        ) : (
          <>
            <Save className="mr-2 h-4 w-4" />
            {t("llmConfig.buttons.save")}
          </>
        )}
      </Button>
    </div>
  );
}
