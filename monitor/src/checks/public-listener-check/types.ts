export type PublicListenerStatus =
  | "healthy"
  | "dns_failed"
  | "tls_failed"
  | "connect_failed"
  | "http_failed"
  | "no_audio_bytes"
  | "decode_failed"
  | "silent"
  | "stalled"
  | "timeout"
  | "unknown_error";

export type Severity = "none" | "warning" | "critical";

export interface PublicListenerConfig {
  streamUrl: string;
  userAgent: string;
  totalTimeoutMs: number;
  sampleDurationSeconds: number;
  silenceThresholdDb: number;
  continuousSilenceSeconds: number;
  requireTls: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  debug: boolean;
}

export interface PublicListenerTargetDefinition {
  id: string;
  name: string;
  url: string;
}

export interface PublicListenerResult {
  status: PublicListenerStatus;
  reason: string;
  severity: Severity;
  shouldOpenIncident: boolean;
  requiresConsecutiveFailures: boolean;
  message: string;
}

export interface PublicListenerMetrics {
  bytesReceived: number;
  decodedSeconds: number;
  sampleDurationSeconds: number;
  silenceDetectedSeconds: number;
  ffprobeExitCode: number | null;
  ffmpegExitCode: number | null;
}

export interface PublicListenerEvidence {
  contentType: string | null;
  tlsError: string | null;
  ffprobeSummary: string | null;
  ffmpegSummary: string | null;
  stderrSnippet: string | null;
  stdoutSnippet: string | null;
}

export interface PublicListenerTiming {
  startedAt: string;
  finishedAt: string;
  executionDurationMs: number;
  checkedAt: string;
}

export interface PublicListenerDiagnostic {
  checkName: "public-listener-check";
  checkVersion: "v1";
  target: {
    streamUrl: string;
    host: string;
  };
  result: PublicListenerResult;
  metrics: PublicListenerMetrics;
  evidence: PublicListenerEvidence;
  timing: PublicListenerTiming;
  debug: {
    enabled: boolean;
  };
}

export type PublicListenerMultiOverallStatus = "healthy" | "degraded" | "failed";

export interface PublicListenerMultiDiagnosticResult {
  targetId: string;
  targetName: string;
  target: PublicListenerDiagnostic["target"];
  result: PublicListenerDiagnostic["result"];
  metrics: PublicListenerDiagnostic["metrics"];
  evidence: PublicListenerDiagnostic["evidence"];
  timing: PublicListenerDiagnostic["timing"];
  debug: PublicListenerDiagnostic["debug"];
}

export interface PublicListenerMultiDiagnostic {
  checkName: "public-listener-check";
  checkVersion: "v1";
  mode: "multi";
  summary: {
    overallStatus: PublicListenerMultiOverallStatus;
    healthyCount: number;
    failedCount: number;
    totalCount: number;
  };
  results: PublicListenerMultiDiagnosticResult[];
}

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number;
}
