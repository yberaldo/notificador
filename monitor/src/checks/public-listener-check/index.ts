import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { classify } from "./classifier.js";
import { runCommand } from "./run-command.js";
import type {
  CommandResult,
  PublicListenerConfig,
  PublicListenerDiagnostic,
  PublicListenerEvidence,
  PublicListenerMetrics,
  PublicListenerStatus
} from "./types.js";

const CHECK_NAME = "public-listener-check";
const CHECK_VERSION = "v1";
const BYTE_PROBE_LIMIT = 64 * 1024;
const SNIPPET_LENGTH = 2_000;

interface HttpProbeResult {
  ok: boolean;
  status: PublicListenerStatus;
  reason: string;
  bytesReceived: number;
  contentType: string | null;
  tlsError: string | null;
  stderrSnippet: string | null;
  stdoutSnippet: string | null;
}

export async function runPublicListenerCheck(config: PublicListenerConfig): Promise<PublicListenerDiagnostic> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const metrics: PublicListenerMetrics = {
    bytesReceived: 0,
    decodedSeconds: 0,
    sampleDurationSeconds: config.sampleDurationSeconds,
    silenceDetectedSeconds: 0,
    ffprobeExitCode: null,
    ffmpegExitCode: null
  };
  const evidence: PublicListenerEvidence = {
    contentType: null,
    tlsError: null,
    ffprobeSummary: null,
    ffmpegSummary: null,
    stderrSnippet: null,
    stdoutSnippet: null
  };

  let streamUrl: URL | null = null;
  let host = "";
  let status: PublicListenerStatus = "unknown_error";
  let reason = "unhandled_error";
  let message: string | undefined;

  try {
    if (!config.streamUrl.trim()) {
      status = "unknown_error";
      reason = "missing_stream_url";
      message = "PUBLIC_LISTENER_URL ou --url e obrigatorio.";
      return buildDiagnostic(config, startedAtMs, startedAt, streamUrl, host, status, reason, message, metrics, evidence);
    }

    streamUrl = new URL(config.streamUrl);
    host = streamUrl.hostname;

    if (!["http:", "https:"].includes(streamUrl.protocol)) {
      status = "unknown_error";
      reason = "unsupported_protocol";
      message = "URL do stream deve usar http ou https.";
      return buildDiagnostic(config, startedAtMs, startedAt, streamUrl, host, status, reason, message, metrics, evidence);
    }

    if (config.requireTls && streamUrl.protocol !== "https:") {
      status = "tls_failed";
      reason = "tls_required_but_url_is_not_https";
      evidence.tlsError = reason;
      return buildDiagnostic(config, startedAtMs, startedAt, streamUrl, host, status, reason, undefined, metrics, evidence);
    }

    await withRemainingTimeout(startedAtMs, config.totalTimeoutMs, dns.lookup(host), "dns_lookup");

    const httpProbe = await probeHttpStream(streamUrl, config, remainingMs(startedAtMs, config.totalTimeoutMs));
    metrics.bytesReceived = httpProbe.bytesReceived;
    evidence.contentType = httpProbe.contentType;
    evidence.tlsError = httpProbe.tlsError;
    evidence.stderrSnippet = httpProbe.stderrSnippet;
    evidence.stdoutSnippet = httpProbe.stdoutSnippet;

    if (!httpProbe.ok) {
      return buildDiagnostic(
        config,
        startedAtMs,
        startedAt,
        streamUrl,
        host,
        httpProbe.status,
        httpProbe.reason,
        undefined,
        metrics,
        evidence
      );
    }

    if (metrics.bytesReceived <= 0) {
      return buildDiagnostic(
        config,
        startedAtMs,
        startedAt,
        streamUrl,
        host,
        "no_audio_bytes",
        "http_stream_returned_no_bytes",
        undefined,
        metrics,
        evidence
      );
    }

    const ffprobe = await runFfprobe(config, remainingMs(startedAtMs, config.totalTimeoutMs));
    metrics.ffprobeExitCode = ffprobe.exitCode;
    evidence.ffprobeSummary = summarizeFfprobe(ffprobe);
    evidence.stderrSnippet = pickSnippet(evidence.stderrSnippet, ffprobe.stderr);
    evidence.stdoutSnippet = pickSnippet(evidence.stdoutSnippet, ffprobe.stdout);

    if (ffprobe.timedOut) {
      return buildDiagnostic(config, startedAtMs, startedAt, streamUrl, host, "timeout", "ffprobe_timeout", undefined, metrics, evidence);
    }

    if (ffprobe.exitCode !== 0) {
      return buildDiagnostic(
        config,
        startedAtMs,
        startedAt,
        streamUrl,
        host,
        commandNotFound(ffprobe) ? "unknown_error" : "no_audio_bytes",
        commandNotFound(ffprobe) ? "ffprobe_not_available" : "ffprobe_could_not_open_stream",
        undefined,
        metrics,
        evidence
      );
    }

    const ffmpeg = await runFfmpeg(config, remainingMs(startedAtMs, config.totalTimeoutMs));
    metrics.ffmpegExitCode = ffmpeg.exitCode;
    metrics.decodedSeconds = estimateDecodedSeconds(ffmpeg.stderr, config.sampleDurationSeconds, ffmpeg.exitCode === 0);
    metrics.silenceDetectedSeconds = detectContinuousSilenceSeconds(ffmpeg.stderr);
    evidence.ffmpegSummary = summarizeFfmpeg(ffmpeg);
    evidence.stderrSnippet = pickSnippet(evidence.stderrSnippet, ffmpeg.stderr);
    evidence.stdoutSnippet = pickSnippet(evidence.stdoutSnippet, ffmpeg.stdout);

    if (ffmpeg.timedOut) {
      return buildDiagnostic(config, startedAtMs, startedAt, streamUrl, host, "timeout", "ffmpeg_timeout", undefined, metrics, evidence);
    }

    if (ffmpeg.exitCode !== 0) {
      return buildDiagnostic(
        config,
        startedAtMs,
        startedAt,
        streamUrl,
        host,
        commandNotFound(ffmpeg) ? "unknown_error" : "decode_failed",
        commandNotFound(ffmpeg) ? "ffmpeg_not_available" : "ffmpeg_decode_failed",
        undefined,
        metrics,
        evidence
      );
    }

    if (metrics.decodedSeconds < Math.min(1, config.sampleDurationSeconds)) {
      return buildDiagnostic(config, startedAtMs, startedAt, streamUrl, host, "decode_failed", "decoded_too_little_audio", undefined, metrics, evidence);
    }

    if (metrics.silenceDetectedSeconds >= config.continuousSilenceSeconds) {
      return buildDiagnostic(config, startedAtMs, startedAt, streamUrl, host, "silent", "continuous_silence_detected", undefined, metrics, evidence);
    }

    return buildDiagnostic(config, startedAtMs, startedAt, streamUrl, host, "healthy", "audio_decoded_without_continuous_silence", undefined, metrics, evidence);
  } catch (error) {
    const normalized = normalizeError(error);
    status = normalized.status;
    reason = normalized.reason;
    if (status === "tls_failed") {
      evidence.tlsError = normalized.message;
    }
    evidence.stderrSnippet = normalized.message;

    return buildDiagnostic(config, startedAtMs, startedAt, streamUrl, host, status, reason, undefined, metrics, evidence);
  }
}

function runFfprobe(config: PublicListenerConfig, timeoutMs: number): Promise<CommandResult> {
  return runCommand(
    config.ffprobePath,
    [
      "-v",
      "error",
      "-hide_banner",
      "-user_agent",
      config.userAgent,
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      config.streamUrl
    ],
    timeoutMs
  );
}

function runFfmpeg(config: PublicListenerConfig, timeoutMs: number): Promise<CommandResult> {
  return runCommand(
    config.ffmpegPath,
    [
      "-v",
      "info",
      "-hide_banner",
      "-nostdin",
      "-user_agent",
      config.userAgent,
      "-t",
      String(config.sampleDurationSeconds),
      "-i",
      config.streamUrl,
      "-af",
      `silencedetect=noise=${config.silenceThresholdDb}dB:d=${config.continuousSilenceSeconds}`,
      "-f",
      "null",
      "-"
    ],
    timeoutMs
  );
}

async function probeHttpStream(url: URL, config: PublicListenerConfig, timeoutMs: number): Promise<HttpProbeResult> {
  const startedAt = Date.now();
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const result = await requestSomeBytes(currentUrl, config, Math.max(1, timeoutMs - (Date.now() - startedAt)));
    if (result.status === "http_failed" && result.reason.startsWith("redirect:") && result.stdoutSnippet) {
      currentUrl = new URL(result.stdoutSnippet, currentUrl);
      continue;
    }
    return result;
  }

  return {
    ok: false,
    status: "http_failed",
    reason: "too_many_redirects",
    bytesReceived: 0,
    contentType: null,
    tlsError: null,
    stderrSnippet: null,
    stdoutSnippet: null
  };
}

function requestSomeBytes(url: URL, config: PublicListenerConfig, timeoutMs: number): Promise<HttpProbeResult> {
  return new Promise((resolve) => {
    const client = url.protocol === "https:" ? https : http;
    let settled = false;
    let bytesReceived = 0;
    const chunks: Buffer[] = [];

    const request = client.get(
      url,
      {
        headers: {
          "User-Agent": config.userAgent,
          "Icy-MetaData": "0",
          Accept: "*/*"
        },
        timeout: timeoutMs
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const contentType = headerToString(response.headers["content-type"]);

        if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
          response.resume();
          settle({
            ok: false,
            status: "http_failed",
            reason: `redirect:${statusCode}`,
            bytesReceived,
            contentType,
            tlsError: null,
            stderrSnippet: null,
            stdoutSnippet: response.headers.location
          });
          return;
        }

        if (statusCode >= 400 || statusCode === 0) {
          response.resume();
          settle({
            ok: false,
            status: "http_failed",
            reason: `http_status_${statusCode}`,
            bytesReceived,
            contentType,
            tlsError: null,
            stderrSnippet: null,
            stdoutSnippet: null
          });
          return;
        }

        response.on("data", (chunk: Buffer) => {
          bytesReceived += chunk.length;
          if (Buffer.concat(chunks).length < SNIPPET_LENGTH) {
            chunks.push(chunk);
          }
          if (bytesReceived >= BYTE_PROBE_LIMIT) {
            request.destroy();
            settle({
              ok: true,
              status: "healthy",
              reason: "received_audio_bytes",
              bytesReceived,
              contentType,
              tlsError: null,
              stderrSnippet: null,
              stdoutSnippet: bufferSnippet(chunks)
            });
          }
        });

        response.on("end", () => {
          settle({
            ok: bytesReceived > 0,
            status: bytesReceived > 0 ? "healthy" : "no_audio_bytes",
            reason: bytesReceived > 0 ? "received_audio_bytes_before_end" : "http_response_ended_without_bytes",
            bytesReceived,
            contentType,
            tlsError: null,
            stderrSnippet: null,
            stdoutSnippet: bufferSnippet(chunks)
          });
        });
      }
    );

    const timeout = setTimeout(() => {
      request.destroy();
      settle({
        ok: false,
        status: bytesReceived > 0 ? "stalled" : "timeout",
        reason: bytesReceived > 0 ? "http_stream_stalled" : "http_probe_timeout",
        bytesReceived,
        contentType: null,
        tlsError: null,
        stderrSnippet: null,
        stdoutSnippet: bufferSnippet(chunks)
      });
    }, Math.max(1, timeoutMs));

    request.on("timeout", () => {
      request.destroy();
      settle({
        ok: false,
        status: bytesReceived > 0 ? "stalled" : "timeout",
        reason: bytesReceived > 0 ? "http_stream_stalled" : "http_probe_timeout",
        bytesReceived,
        contentType: null,
        tlsError: null,
        stderrSnippet: null,
        stdoutSnippet: bufferSnippet(chunks)
      });
    });

    request.on("error", (error: NodeJS.ErrnoException) => {
      const normalized = normalizeError(error);
      settle({
        ok: false,
        status: normalized.status,
        reason: normalized.reason,
        bytesReceived,
        contentType: null,
        tlsError: normalized.status === "tls_failed" ? normalized.message : null,
        stderrSnippet: normalized.message,
        stdoutSnippet: bufferSnippet(chunks)
      });
    });

    function settle(result: HttpProbeResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }
  });
}

async function withRemainingTimeout<T>(
  startedAtMs: number,
  totalTimeoutMs: number,
  promise: Promise<T>,
  label: string
): Promise<T> {
  const timeoutMs = remainingMs(startedAtMs, totalTimeoutMs);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(Object.assign(new Error(`${label}_timeout`), { code: "ETIMEDOUT" })), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function buildDiagnostic(
  config: PublicListenerConfig,
  startedAtMs: number,
  startedAt: string,
  streamUrl: URL | null,
  host: string,
  status: PublicListenerStatus,
  reason: string,
  message: string | undefined,
  metrics: PublicListenerMetrics,
  evidence: PublicListenerEvidence
): PublicListenerDiagnostic {
  const finishedAtMs = Date.now();
  const finishedAt = new Date(finishedAtMs).toISOString();

  return {
    checkName: CHECK_NAME,
    checkVersion: CHECK_VERSION,
    target: {
      streamUrl: streamUrl?.toString() ?? config.streamUrl,
      host
    },
    result: classify({ status, reason, message }),
    metrics,
    evidence: {
      contentType: evidence.contentType,
      tlsError: evidence.tlsError,
      ffprobeSummary: truncate(evidence.ffprobeSummary),
      ffmpegSummary: truncate(evidence.ffmpegSummary),
      stderrSnippet: config.debug ? truncate(evidence.stderrSnippet) : null,
      stdoutSnippet: config.debug ? truncate(evidence.stdoutSnippet) : null
    },
    timing: {
      startedAt,
      finishedAt,
      executionDurationMs: finishedAtMs - startedAtMs,
      checkedAt: finishedAt
    },
    debug: {
      enabled: config.debug
    }
  };
}

function remainingMs(startedAtMs: number, totalTimeoutMs: number): number {
  return Math.max(1, totalTimeoutMs - (Date.now() - startedAtMs));
}

function normalizeError(error: unknown): { status: PublicListenerStatus; reason: string; message: string } {
  if (!(error instanceof Error)) {
    return { status: "unknown_error", reason: "non_error_thrown", message: String(error) };
  }

  const code = (error as NodeJS.ErrnoException).code ?? "";
  const message = error.message;

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { status: "dns_failed", reason: code.toLowerCase(), message };
  }

  if (code === "ERR_INVALID_URL") {
    return { status: "unknown_error", reason: "invalid_stream_url", message };
  }

  if (code === "ETIMEDOUT") {
    return { status: "timeout", reason: "operation_timeout", message };
  }

  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
    return { status: "connect_failed", reason: code.toLowerCase(), message };
  }

  if (
    code.includes("CERT") ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    message.toLowerCase().includes("tls") ||
    message.toLowerCase().includes("certificate")
  ) {
    return { status: "tls_failed", reason: code ? code.toLowerCase() : "tls_error", message };
  }

  if (code) {
    return { status: "connect_failed", reason: code.toLowerCase(), message };
  }

  return { status: "unknown_error", reason: "unexpected_error", message };
}

function summarizeFfprobe(result: CommandResult): string {
  if (result.errorMessage) {
    return `${result.errorCode ?? "error"}: ${result.errorMessage}`;
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<{ codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number }>;
      format?: { format_name?: string; duration?: string; bit_rate?: string };
    };
    const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
    const parts = [
      audio?.codec_name ? `codec=${audio.codec_name}` : null,
      audio?.sample_rate ? `sample_rate=${audio.sample_rate}` : null,
      audio?.channels ? `channels=${audio.channels}` : null,
      parsed.format?.format_name ? `format=${parsed.format.format_name}` : null,
      parsed.format?.bit_rate ? `bit_rate=${parsed.format.bit_rate}` : null
    ].filter(Boolean);
    return parts.length ? parts.join(" ") : "ffprobe_ok_no_audio_stream_summary";
  } catch {
    return result.exitCode === 0 ? "ffprobe_ok" : firstLine(result.stderr) ?? "ffprobe_failed";
  }
}

function summarizeFfmpeg(result: CommandResult): string {
  if (result.errorMessage) {
    return `${result.errorCode ?? "error"}: ${result.errorMessage}`;
  }

  const audioLine = result.stderr
    .split(/\r?\n/)
    .find((line) => line.includes("Audio:") || line.includes("silence_start") || line.includes("silence_end"));
  return audioLine?.trim() ?? (result.exitCode === 0 ? "ffmpeg_decode_ok" : firstLine(result.stderr) ?? "ffmpeg_decode_failed");
}

function estimateDecodedSeconds(stderr: string, sampleDurationSeconds: number, success: boolean): number {
  const matches = [...stderr.matchAll(/time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  const last = matches.at(-1);
  if (!last) {
    return success ? sampleDurationSeconds : 0;
  }

  const hours = Number(last[1]);
  const minutes = Number(last[2]);
  const seconds = Number(last[3]);
  const decoded = hours * 3600 + minutes * 60 + seconds;
  return Math.min(Math.max(decoded, 0), sampleDurationSeconds);
}

function detectContinuousSilenceSeconds(stderr: string): number {
  let longest = 0;
  let currentStart: number | null = null;

  for (const line of stderr.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    if (start) {
      currentStart = Number(start[1]);
      continue;
    }

    const end = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (end) {
      longest = Math.max(longest, Number(end[2]));
      currentStart = null;
    }
  }

  if (currentStart !== null) {
    const lastTime = estimateDecodedSeconds(stderr, Number.MAX_SAFE_INTEGER, false);
    if (Number.isFinite(lastTime) && lastTime > currentStart) {
      longest = Math.max(longest, lastTime - currentStart);
    }
  }

  return roundSeconds(longest);
}

function commandNotFound(result: CommandResult): boolean {
  return result.errorCode === "ENOENT";
}

function headerToString(value: string | string[] | undefined): string | null {
  if (!value) {
    return null;
  }
  return Array.isArray(value) ? value.join(", ") : value;
}

function bufferSnippet(chunks: Buffer[]): string | null {
  if (chunks.length === 0) {
    return null;
  }

  return Buffer.concat(chunks).toString("hex").slice(0, SNIPPET_LENGTH);
}

function pickSnippet(current: string | null, next: string): string | null {
  if (next.trim()) {
    return next;
  }
  return current;
}

function truncate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  if (normalized.length <= SNIPPET_LENGTH) {
    return normalized;
  }

  return normalized.slice(0, SNIPPET_LENGTH);
}

function firstLine(value: string): string | null {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() ?? null;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
