import type { PublicListenerConfig, PublicListenerTargetDefinition } from "./types.js";

interface CliArgs {
  [key: string]: string | boolean | undefined;
}

const DEFAULTS = {
  userAgent: "RadioCabritoPublicListenerCheck/1.0",
  totalTimeoutMs: 30_000,
  sampleDurationSeconds: 10,
  silenceThresholdDb: -45,
  continuousSilenceSeconds: 5,
  requireTls: false,
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  debug: false
};

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      args[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[withoutPrefix] = true;
      continue;
    }

    args[withoutPrefix] = next;
    index += 1;
  }

  return args;
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: string[]): PublicListenerConfig {
  const args = parseCliArgs(argv);

  const streamUrl = readString(args, env, "url", "PUBLIC_LISTENER_URL", "");
  const userAgent = readString(args, env, "user-agent", "PUBLIC_LISTENER_USER_AGENT", DEFAULTS.userAgent);
  const totalTimeoutMs = readNumber(
    args,
    env,
    "timeout-ms",
    "PUBLIC_LISTENER_TOTAL_TIMEOUT_MS",
    DEFAULTS.totalTimeoutMs
  );
  const sampleDurationSeconds = readNumber(
    args,
    env,
    "sample-duration-seconds",
    "PUBLIC_LISTENER_SAMPLE_DURATION_SECONDS",
    DEFAULTS.sampleDurationSeconds
  );
  const silenceThresholdDb = readNumber(
    args,
    env,
    "silence-threshold-db",
    "PUBLIC_LISTENER_SILENCE_THRESHOLD_DB",
    DEFAULTS.silenceThresholdDb
  );
  const continuousSilenceSeconds = readNumber(
    args,
    env,
    "continuous-silence-seconds",
    "PUBLIC_LISTENER_CONTINUOUS_SILENCE_SECONDS",
    DEFAULTS.continuousSilenceSeconds
  );
  const requireTls = readBoolean(args, env, "require-tls", "PUBLIC_LISTENER_REQUIRE_TLS", DEFAULTS.requireTls);
  const ffmpegPath = readString(args, env, "ffmpeg-path", "PUBLIC_LISTENER_FFMPEG_PATH", DEFAULTS.ffmpegPath);
  const ffprobePath = readString(args, env, "ffprobe-path", "PUBLIC_LISTENER_FFPROBE_PATH", DEFAULTS.ffprobePath);
  const debug = readBoolean(args, env, "debug", "PUBLIC_LISTENER_DEBUG", DEFAULTS.debug);

  return {
    streamUrl,
    userAgent,
    totalTimeoutMs: clamp(totalTimeoutMs, 1_000, 120_000),
    sampleDurationSeconds: clamp(sampleDurationSeconds, 1, 60),
    silenceThresholdDb,
    continuousSilenceSeconds: clamp(continuousSilenceSeconds, 1, 60),
    requireTls,
    ffmpegPath,
    ffprobePath,
    debug
  };
}

export function loadTargetsConfig(env: NodeJS.ProcessEnv, argv: string[]): PublicListenerTargetDefinition[] | null {
  const args = parseCliArgs(argv);
  const rawTargets = readString(args, env, "targets-json", "PUBLIC_LISTENER_TARGETS_JSON", "");

  if (!rawTargets) {
    return null;
  }

  return parseTargetsJson(rawTargets);
}

function readString(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
  argName: string,
  envName: string,
  fallback: string
): string {
  const argValue = args[argName];
  if (typeof argValue === "string" && argValue.trim()) {
    return argValue.trim();
  }

  const envValue = env[envName];
  if (envValue?.trim()) {
    return envValue.trim();
  }

  return fallback;
}

function parseTargetsJson(rawTargets: string): PublicListenerTargetDefinition[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawTargets);
  } catch {
    throw new Error("PUBLIC_LISTENER_TARGETS_JSON ou --targets-json deve ser um JSON valido.");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("PUBLIC_LISTENER_TARGETS_JSON ou --targets-json deve ser um array com ao menos um target.");
  }

  return parsed.map((target, index) => normalizeTarget(target, index));
}

function normalizeTarget(target: unknown, index: number): PublicListenerTargetDefinition {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error(`Target ${index + 1} em PUBLIC_LISTENER_TARGETS_JSON ou --targets-json e invalido.`);
  }

  const record = target as Record<string, unknown>;

  return {
    id: readTargetString(record, "id", index),
    name: readTargetString(record, "name", index),
    url: readTargetString(record, "url", index)
  };
}

function readTargetString(target: Record<string, unknown>, field: "id" | "name" | "url", index: number): string {
  const value = target[field];

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Target ${index + 1} precisa informar ${field}.`);
  }

  return value.trim();
}

function readNumber(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
  argName: string,
  envName: string,
  fallback: number
): number {
  const raw = readString(args, env, argName, envName, "");
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
  argName: string,
  envName: string,
  fallback: boolean
): boolean {
  const argValue = args[argName];
  if (typeof argValue === "boolean") {
    return argValue;
  }
  if (typeof argValue === "string") {
    return parseBoolean(argValue, fallback);
  }

  const envValue = env[envName];
  if (envValue === undefined) {
    return fallback;
  }

  return parseBoolean(envValue, fallback);
}

function parseBoolean(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
