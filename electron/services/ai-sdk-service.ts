import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import type { LanguageModel, EmbeddingModel } from "ai";
import { ServiceError, ErrorCode } from "@shared/errors";
import type { LLMConfig, LLMEndpointConfig } from "@shared/llm-config-types";
import { getLogger } from "./logger";

/**
 * Internal client state for each client type
 */
interface ClientState {
  provider: OpenAICompatibleProvider;
  model: string;
}

const logger = getLogger("ai-sdk-service");

type ReadBodyFailedError = {
  kind: "read_body_failed";
  error: unknown;
};

function isReadBodyFailedError(value: unknown): value is ReadBodyFailedError {
  if (!value || typeof value !== "object") return false;
  return "kind" in value && (value as { kind?: unknown }).kind === "read_body_failed";
}

/**
 * AISDKService - Unified AI client management
 * Provides vlmClient, textClient, and embeddingClient
 */
export class AISDKService {
  private static instance: AISDKService | null = null;

  private vlmClient: ClientState | null = null;
  private textClient: ClientState | null = null;
  private embeddingClient: ClientState | null = null;
  private _initialized = false;

  private constructor() {}

  static getInstance(): AISDKService {
    if (!AISDKService.instance) {
      AISDKService.instance = new AISDKService();
    }
    return AISDKService.instance;
  }

  static resetInstance(): void {
    AISDKService.instance = null;
  }

  /**
   * Initialize from LLMConfig (unified or separate mode)
   * This is the primary initialization method
   */
  initialize(config: LLMConfig): void {
    this.reset();

    try {
      if (config.mode === "unified") {
        // Unified mode - same config for all clients
        const state = this.createClientState(config.config);
        this.vlmClient = state;
        this.textClient = state;
        this.embeddingClient = state;
      } else {
        // Separate mode - distinct configs
        this.vlmClient = this.createClientState(config.vlm);
        this.textClient = this.createClientState(config.textLlm);
        this.embeddingClient = this.createClientState(config.embeddingLlm);
      }

      this._initialized = true;
    } catch (error) {
      this.reset();
      if (error instanceof ServiceError) {
        throw error;
      }
      throw new ServiceError(
        ErrorCode.INITIALIZATION_ERROR,
        `AI SDK initialization failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Reset all clients
   */
  private reset(): void {
    this.vlmClient = null;
    this.textClient = null;
    this.embeddingClient = null;
    this._initialized = false;
  }

  /**
   * Create client state from endpoint config
   */
  private createClientState(endpoint: LLMEndpointConfig): ClientState {
    this.validateEndpoint(endpoint);

    const baseUrlLower = endpoint.baseUrl.toLowerCase();
    const shouldDisableCompression = baseUrlLower.includes("deepseek.com");

    /* v8 ignore start -- deepSeekFetch is integration-heavy; tested via e2e */
    const deepSeekFetch: typeof fetch = async (input, init) => {
      const getUrlString = () => {
        if (typeof input === "string") return input;
        if (input instanceof URL) return input.toString();
        const anyInput = input as unknown as { url?: string };
        return anyInput?.url ?? "unknown";
      };

      const isStreamingRequest = () => {
        const headers = new Headers((init?.headers as HeadersInit | undefined) ?? undefined);
        const accept = headers.get("accept") ?? "";
        if (accept.toLowerCase().includes("text/event-stream")) return true;

        const body = init?.body;
        if (typeof body !== "string") return false;
        return body.includes('"stream":true') || body.includes('"stream": true');
      };

      const tryBufferJsonResponse = async (res: Response) => {
        const contentType = res.headers.get("content-type") ?? "";
        const isJsonLike =
          contentType.toLowerCase().includes("application/json") ||
          contentType.toLowerCase().includes("+json") ||
          contentType.toLowerCase().includes("text/json") ||
          contentType.trim() === "";

        if (!res.ok || !isJsonLike || isStreamingRequest()) {
          return res;
        }

        let text: string;
        try {
          text = await res.text();
        } catch (error) {
          throw { kind: "read_body_failed", error };
        }

        const trimmed = text.trim();
        try {
          JSON.parse(trimmed);
        } catch (error) {
          const url = getUrlString();
          const textSnippet = trimmed.slice(0, 800);
          logger.error(
            {
              url,
              status: res.status,
              contentType,
              dsTraceId: res.headers.get("x-ds-trace-id"),
              cfId: res.headers.get("x-amz-cf-id"),
              textSnippet,
              error,
            },
            "DeepSeek returned non-JSON response body"
          );
        }

        const headers = new Headers(res.headers);
        return new Response(text, { status: res.status, statusText: res.statusText, headers });
      };

      const doFetch = async (override?: { connectionClose?: boolean }) => {
        if (!override?.connectionClose) {
          return fetch(input, init);
        }

        const nextHeaders = new Headers((init?.headers as HeadersInit | undefined) ?? undefined);
        nextHeaders.set("connection", "close");
        if (shouldDisableCompression) {
          nextHeaders.set("accept-encoding", "identity");
        }

        const nextInit: RequestInit = { ...init, headers: nextHeaders };
        return fetch(input, nextInit);
      };

      try {
        const res = await doFetch();
        return await tryBufferJsonResponse(res);
      } catch (err) {
        const url = getUrlString();
        if (isReadBodyFailedError(err)) {
          logger.warn(
            {
              url,
              error: err.error,
            },
            "DeepSeek response body read failed; retrying once with connection: close"
          );

          const res = await doFetch({ connectionClose: true });
          return await tryBufferJsonResponse(res);
        }

        logger.error({ url, error: err }, "DeepSeek fetch failed");
        throw err;
      }
    };
    /* v8 ignore stop */

    const provider = createOpenAICompatible({
      name: "mnemora",
      baseURL: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      fetch: shouldDisableCompression ? deepSeekFetch : undefined,
      headers: {
        authorization: `Bearer ${endpoint.apiKey}`,

        ...(shouldDisableCompression ? { "accept-encoding": "identity" } : {}),
      },
    });
    return { provider, model: endpoint.model };
  }

  /**
   * Validate endpoint configuration
   */
  private validateEndpoint(endpoint: LLMEndpointConfig): void {
    if (!endpoint.apiKey?.trim()) {
      throw new ServiceError(ErrorCode.API_KEY_MISSING, "API Key is required");
    }
    if (!endpoint.baseUrl?.trim()) {
      throw new ServiceError(ErrorCode.INITIALIZATION_ERROR, "Base URL is required");
    }
    if (!endpoint.model?.trim()) {
      throw new ServiceError(ErrorCode.INITIALIZATION_ERROR, "Model is required");
    }
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Get VLM (Vision Language Model) client
   */
  getVLMClient(): LanguageModel {
    if (!this._initialized || !this.vlmClient) {
      throw new ServiceError(ErrorCode.NOT_INITIALIZED, "VLM client not initialized");
    }
    return this.vlmClient.provider(this.vlmClient.model);
  }

  /**
   * Get Text LLM client
   */
  getTextClient(): LanguageModel {
    if (!this._initialized || !this.textClient) {
      throw new ServiceError(ErrorCode.NOT_INITIALIZED, "Text LLM client not initialized");
    }
    return this.textClient.provider(this.textClient.model);
  }

  /**
   * Get Embedding client
   */
  getEmbeddingClient(): EmbeddingModel<string> {
    if (!this._initialized || !this.embeddingClient) {
      throw new ServiceError(ErrorCode.NOT_INITIALIZED, "Embedding client not initialized");
    }
    return this.embeddingClient.provider.textEmbeddingModel(this.embeddingClient.model);
  }

  /**
   * Get VLM Model Name
   */
  getVLMModelName(): string {
    if (!this._initialized || !this.vlmClient) {
      return "unknown";
    }
    return this.vlmClient.model;
  }

  /**
   * Get Text LLM Model Name
   */
  getTextModelName(): string {
    if (!this._initialized || !this.textClient) {
      return "unknown";
    }
    return this.textClient.model;
  }

  /**
   * Get Embedding Model Name
   */
  getEmbeddingModelName(): string {
    if (!this._initialized || !this.embeddingClient) {
      return "unknown";
    }
    return this.embeddingClient.model;
  }
}
