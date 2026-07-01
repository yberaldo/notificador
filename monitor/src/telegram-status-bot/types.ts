import type { PublicListenerMultiDiagnostic } from "../checks/public-listener-check/types.js";

export interface TelegramStatusOffsetSnapshot {
  schemaVersion: 1;
  updatedAt: string;
  offset: number;
}

export interface TelegramChat {
  id: number | string;
  type?: string;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: TelegramChat;
  text?: string;
  message_thread_id?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramApiPayload<T> {
  ok?: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export interface TelegramStatusBotConfig {
  botToken: string;
  chatId: string;
  apiBaseUrl: string;
  threadId: number | null;
  telegramTimeoutMs: number;
  pollTimeoutSeconds: number;
  offsetFilePath: string;
  once: boolean;
}

export type RunStatusCheck = () => Promise<PublicListenerMultiDiagnostic>;

export interface TelegramStatusBotState {
  currentCheck: Promise<void> | null;
}
