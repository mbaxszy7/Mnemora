import { useState, useRef, ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ImagePlus, Loader2, AlertCircle, Sparkles } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  type VLMResponse,
  type IPCError,
  getErrorMessage,
  SUPPORTED_IMAGE_TYPES,
  type SupportedImageType,
} from "@shared/index";

interface DemoState {
  selectedImage: File | null;
  imagePreview: string | null;
  isAnalyzing: boolean;
  result: VLMResponse | null;
  error: string | null;
}

/**
 * Extracts error message from an IPCError or unknown error
 */
function extractErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const err = error as IPCError;
    if (err.code) {
      return getErrorMessage(err.code);
    }
    if ("message" in err && typeof err.message === "string") {
      return err.message;
    }
  }
  if (typeof error === "string") {
    return error;
  }
  return getErrorMessage("UNKNOWN");
}

/**
 * Validates if a file is a supported image type
 */
export function isValidImageFile(file: File): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(file.type as SupportedImageType);
}

export default function VLMDemoPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<DemoState>({
    selectedImage: null,
    imagePreview: null,
    isAnalyzing: false,
    result: null,
    error: null,
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSelectImage = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!isValidImageFile(file)) {
      setState((prev) => ({
        ...prev,
        error: t("vlmDemo.invalidImage"),
      }));
      return;
    }

    // Create preview URL
    const previewUrl = URL.createObjectURL(file);

    setState((prev) => ({
      ...prev,
      selectedImage: file,
      imagePreview: previewUrl,
      result: null,
      error: null,
    }));
  };

  const handleAnalyze = async () => {
    if (!state.selectedImage) return;

    setState((prev) => ({ ...prev, isAnalyzing: true, error: null }));

    try {
      // Read file as base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          // Remove data URL prefix to get pure base64
          const base64 = result.split(",")[1];
          resolve(base64);
        };
        reader.onerror = reject;
      });
      reader.readAsDataURL(state.selectedImage);
      const imageData = await base64Promise;

      // Call VLM API via IPC
      const response = await window.vlmApi.analyze(imageData, state.selectedImage.type);

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          isAnalyzing: false,
          result: response.data ?? null,
          error: null,
        }));
      } else {
        setState((prev) => ({
          ...prev,
          isAnalyzing: false,
          result: null,
          error: extractErrorMessage(response.error),
        }));
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isAnalyzing: false,
        result: null,
        error: extractErrorMessage(err),
      }));
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t("vlmDemo.title")}</h1>
        <p className="text-muted-foreground mt-2">{t("vlmDemo.description")}</p>
      </div>

      {/* Image Selection */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ImagePlus className="h-5 w-5" />
            {t("vlmDemo.selectImage")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={handleFileChange}
            className="hidden"
          />

          <Button onClick={handleSelectImage} variant="outline" className="w-full">
            <ImagePlus className="mr-2 h-4 w-4" />
            {t("vlmDemo.selectImage")}
          </Button>

          {/* Image Preview */}
          {state.imagePreview && (
            <div className="mt-4">
              <p className="text-sm text-muted-foreground mb-2">{t("vlmDemo.imagePreview")}:</p>
              <div className="relative rounded-lg overflow-hidden border bg-muted">
                <img
                  src={state.imagePreview}
                  alt={t("vlmDemo.imagePreview")}
                  className="max-h-64 w-full object-contain"
                />
              </div>
            </div>
          )}

          {/* Analyze Button */}
          {state.selectedImage && (
            <Button onClick={handleAnalyze} disabled={state.isAnalyzing} className="w-full">
              {state.isAnalyzing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("vlmDemo.analyzing")}
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-4 w-4" />
                  {t("vlmDemo.analyzeImage")}
                </>
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Error Display */}
      {state.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("vlmDemo.error")}</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {/* Results Display */}
      {state.result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              {t("vlmDemo.analysisResults")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h3 className="font-semibold text-lg">{state.result.title}</h3>
              <p className="text-muted-foreground mt-1">{state.result.description}</p>
            </div>

            {state.result.objects.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">{t("vlmDemo.detectedObjects")}:</p>
                <div className="flex flex-wrap gap-2">
                  {state.result.objects.map((obj, idx) => (
                    <span
                      key={idx}
                      className="px-2 py-1 bg-primary/10 text-primary rounded-md text-sm"
                    >
                      {obj}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {state.result.text && state.result.text.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">{t("vlmDemo.detectedText")}:</p>
                <p className="text-muted-foreground bg-muted p-3 rounded-md">
                  {state.result.text.join("\n")}
                </p>
              </div>
            )}

            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>{t("vlmDemo.confidence")}:</span>
              <span className="font-medium">{state.result.confidence}%</span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
