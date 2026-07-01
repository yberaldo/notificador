import type { TelegramApiPayload, TelegramUpdate } from "./types.js";

export const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";
export const DEFAULT_TELEGRAM_TIMEOUT_MS = 10_000;

export interface TelegramApiClientConfig {
  botToken: string;
  apiBaseUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GetUpdatesOptions {
  offset?: number | null;
  timeoutSeconds: number;
}

export interface SendMessageOptions {
  chatId: string;
  text: string;
  threadId?: number | null;
}

export class TelegramApiClient {
  private readonly botToken: string;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TelegramApiClientConfig) {
    const botToken = normalizeNonEmptyString(config.botToken);
    if (!botToken) {
      throw new Error("telegram bot token ausente");
    }

    this.botToken = botToken;
    this.apiBaseUrl = normalizeTelegramApiBaseUrl(config.apiBaseUrl);
    this.timeoutMs = normalizePositiveInteger(config.timeoutMs, DEFAULT_TELEGRAM_TIMEOUT_MS);
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;

    if (typeof this.fetchImpl !== "function") {
      throw new Error("telegram fetch indisponivel");
    }
  }

  async getUpdates(options: GetUpdatesOptions): Promise<TelegramUpdate[]> {
    const requestUrl = this.buildRequestUrl("getUpdates");

    if (options.offset !== null && options.offset !== undefined) {
      requestUrl.searchParams.set("offset", String(options.offset));
    }

    requestUrl.searchParams.set("timeout", String(Math.max(0, Math.floor(options.timeoutSeconds))));
    requestUrl.searchParams.set("allowed_updates", JSON.stringify(["message"]));

    const payload = await this.request<TelegramUpdate[]>(requestUrl, {
      method: "GET"
    }, this.timeoutMs + Math.max(0, options.timeoutSeconds) * 1000);

    return Array.isArray(payload.result) ? payload.result : [];
  }

  async sendMessage(options: SendMessageOptions): Promise<void> {
    const requestUrl = this.buildRequestUrl("sendMessage");
    const body = {
      chat_id: options.chatId,
      text: options.text,
      ...(options.threadId !== null && options.threadId !== undefined ? { message_thread_id: options.threadId } : {})
    };

    await this.request<unknown>(requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(body)
    }, this.timeoutMs);
  }

  sanitizeText(text: string): string {
    return sanitizeTelegramText(text, this.botToken);
  }

  private async request<T>(requestUrl: URL, init: RequestInit, timeoutMs: number): Promise<TelegramApiPayload<T>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

    try {
      const response = await this.fetchImpl(requestUrl, {
        ...init,
        signal: controller.signal
      });
      const payload = await readTelegramApiResponse<T>(response);

      if (response.status >= 400) {
        throw new Error(`telegram HTTP ${response.status}: ${payload?.description ?? "sem descricao"}`);
      }

      if (!payload || payload.ok !== true) {
        throw new Error(`telegram API: ${payload?.description ?? "resposta invalida"}`);
      }

      return payload;
    } catch (error) {
      throw new Error(sanitizeTelegramText(formatError(error), this.botToken));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildRequestUrl(methodName: string): URL {
    const parsed = new URL(this.apiBaseUrl);
    const basePath = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = `${basePath}/bot${this.botToken}/${methodName}`;
    parsed.search = "";
    parsed.hash = "";
    return parsed;
  }
}

export function sanitizeTelegramText(text: string, botToken?: string | null): string {
  let sanitized = text.replace(/\/bot[^/\s]+\/(getUpdates|sendMessage)/gi, "/bot[redacted]/$1");

  if (botToken) {
    sanitized = sanitized.replaceAll(botToken, "[redacted]");
  }

  return sanitized.replace(/\/bot[^/\s]+/gi, "/bot[redacted]");
}

function normalizeTelegramApiBaseUrl(rawValue?: string | null): string {
  const candidate = normalizeNonEmptyString(rawValue) ?? DEFAULT_TELEGRAM_API_BASE_URL;

  try {
    const parsed = new URL(candidate);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("telegram api base url invalida");
  }
}

async function readTelegramApiResponse<T>(response: Response): Promise<TelegramApiPayload<T> | null> {
  try {
    const parsed = (await response.json()) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as TelegramApiPayload<T>;
  } catch {
    return null;
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
}

function normalizeNonEmptyString(value?: string | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatError(error: unknown): string {
  if (isAbortError(error)) {
    return "telegram network timeout";
  }

  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: string }).name === "AbortError");
}
