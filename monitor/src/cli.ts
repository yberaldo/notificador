#!/usr/bin/env node
import { loadConfig, loadTargetsConfig } from "./checks/public-listener-check/config.js";
import { runPublicListenerCheck } from "./checks/public-listener-check/index.js";
import type {
  PublicListenerConfig,
  PublicListenerMultiDiagnostic,
  PublicListenerTargetDefinition
} from "./checks/public-listener-check/types.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targets = loadTargetsConfig(process.env, argv);

  if (targets) {
    const diagnostic = await runPublicListenerMultiCheck(loadConfig(process.env, argv), targets);

    process.stdout.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
    process.exitCode = diagnostic.summary.failedCount === 0 ? 0 : 1;
    return;
  }

  const config = loadConfig(process.env, argv);
  const diagnostic = await runPublicListenerCheck(config);

  process.stdout.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
  process.exitCode = diagnostic.result.status === "healthy" ? 0 : 1;
}

async function runPublicListenerMultiCheck(
  baseConfig: PublicListenerConfig,
  targets: PublicListenerTargetDefinition[]
): Promise<PublicListenerMultiDiagnostic> {
  const results: PublicListenerMultiDiagnostic["results"] = [];

  for (const target of targets) {
    const diagnostic = await runPublicListenerCheck({
      ...baseConfig,
      streamUrl: target.url
    });

    results.push({
      targetId: target.id,
      targetName: target.name,
      target: diagnostic.target,
      result: diagnostic.result,
      metrics: diagnostic.metrics,
      evidence: diagnostic.evidence,
      timing: diagnostic.timing,
      debug: diagnostic.debug
    });
  }

  const healthyCount = results.filter((result) => result.result.status === "healthy").length;
  const totalCount = results.length;
  const failedCount = totalCount - healthyCount;

  return {
    checkName: "public-listener-check",
    checkVersion: "v1",
    mode: "multi",
    summary: {
      overallStatus: resolveOverallStatus(healthyCount, failedCount, totalCount),
      healthyCount,
      failedCount,
      totalCount
    },
    results
  };
}

function resolveOverallStatus(
  healthyCount: number,
  failedCount: number,
  totalCount: number
): PublicListenerMultiDiagnostic["summary"]["overallStatus"] {
  if (healthyCount === totalCount) {
    return "healthy";
  }

  if (failedCount === totalCount) {
    return "failed";
  }

  return "degraded";
}

main().catch((error) => {
  const now = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const debugEnabled = /^true$/i.test(process.env.PUBLIC_LISTENER_DEBUG ?? "");

  process.stdout.write(
    `${JSON.stringify(
      {
        checkName: "public-listener-check",
        checkVersion: "v1",
        target: {
          streamUrl: process.env.PUBLIC_LISTENER_URL ?? "",
          host: ""
        },
        result: {
          status: "unknown_error",
          reason: "cli_unhandled_error",
          severity: "critical",
          shouldOpenIncident: true,
          requiresConsecutiveFailures: false,
          message: "Erro inesperado na CLI."
        },
        metrics: {
          bytesReceived: 0,
          decodedSeconds: 0,
          sampleDurationSeconds: 0,
          silenceDetectedSeconds: 0,
          ffprobeExitCode: null,
          ffmpegExitCode: null
        },
        evidence: {
          contentType: null,
          tlsError: null,
          ffprobeSummary: null,
          ffmpegSummary: null,
          stderrSnippet: debugEnabled ? message : null,
          stdoutSnippet: null
        },
        timing: {
          startedAt: now,
          finishedAt: now,
          executionDurationMs: 0,
          checkedAt: now
        },
        debug: {
          enabled: debugEnabled
        }
      },
      null,
      2
    )}\n`
  );
  process.exitCode = 1;
});
