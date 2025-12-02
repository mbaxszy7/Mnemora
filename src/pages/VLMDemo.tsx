import { useState, useRef, ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ImagePlus, Loader2, AlertCircle, Sparkles } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface VLMResponse {
  title: string;
  description: string;
  objects: string[];
  text?: string[];
  confidence: number;
}

interface DemoState {
  selectedImage: File | null;
  imagePreview: string | null;
  isAnalyzing: boolean;
  result: VLMResponse | null;
  error: string | null;
}

/**
 * Maps error codes to user-friendly messages
 */
export function getErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const err = error as { code?: string; message?: string };
    switch (err.code) {
      case "API_KEY_MISSING":
        return "请配置 OpenAI API Key";
      case "VLM_ERROR":
        return "图片分析失败，请重试";
      case "VALIDATION_ERROR":
        return "响应格式异常";
      case "IMAGE_TOO_LARGE":
        return "图片过大，请选择小于 20MB 的图片";
      default:
        if (err.message && typeof err.message === "string") {
          return err.message;
        }
    }
  }
  if (typeof error === "string") {
    return error;
  }
  return "发生未知错误，请重试";
}

/**
 * Validates if a file is a supported image type
 */
export function isValidImageFile(file: File): boolean {
  const validTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  return validTypes.includes(file.type);
}

export default function VLMDemoPage() {
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
        error: "请选择有效的图片文件 (JPEG, PNG, WebP, GIF)",
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
          error: getErrorMessage(response.error),
        }));
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isAnalyzing: false,
        result: null,
        error: getErrorMessage(err),
      }));
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold">VLM Demo</h1>
        <p className="text-muted-foreground mt-2">选择一张图片，使用 AI 分析图片内容</p>
      </div>

      {/* Image Selection */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ImagePlus className="h-5 w-5" />
            选择图片
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
            选择图片文件
          </Button>

          {/* Image Preview */}
          {state.imagePreview && (
            <div className="mt-4">
              <p className="text-sm text-muted-foreground mb-2">图片预览:</p>
              <div className="relative rounded-lg overflow-hidden border bg-muted">
                <img
                  src={state.imagePreview}
                  alt="Preview"
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
                  分析中...
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-4 w-4" />
                  分析图片
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
          <AlertTitle>错误</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {/* Results Display */}
      {state.result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              分析结果
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h3 className="font-semibold text-lg">{state.result.title}</h3>
              <p className="text-muted-foreground mt-1">{state.result.description}</p>
            </div>

            {state.result.objects.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">识别到的物体:</p>
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
                <p className="text-sm font-medium mb-2">识别到的文字:</p>
                <p className="text-muted-foreground bg-muted p-3 rounded-md">
                  {state.result.text.join("\n")}
                </p>
              </div>
            )}

            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>置信度:</span>
              <span className="font-medium">{state.result.confidence}%</span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
