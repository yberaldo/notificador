#!/usr/bin/env node
import { loadConfig, loadTargetsConfig } from "./checks/public-listener-check/config.js";
import { runPublicListenerCheck } from "./checks/public-listener-check/index.js";
import {
  buildUnhandledErrorDiagnostic,
  evaluatePublicListenerIncidents
} from "./incidents/evaluate-public-listener-incidents.js";
import type {
  PublicListenerConfig,
  PublicListenerDiagnostic,
  PublicListenerMultiDiagnostic,
  PublicListenerTargetDefinition
} from "./checks/public-listener-check/types.js";

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    const targets = loadTargetsConfig(process.env, argv);

    if (targets) {
      const diagnostic = await runPublicListenerMultiCheck(loadConfig(process.env, argv), targets);
      await writeDiagnosticOutput(diagnostic);
      process.exitCode = diagnostic.summary.failedCount === 0 ? 0 : 1;
      return;
    }

    const config = loadConfig(process.env, argv);
    const diagnostic = await runPublicListenerCheck(config);

    await writeDiagnosticOutput(diagnostic);
    process.exitCode = diagnostic.result.status === "healthy" ? 0 : 1;
  } catch (error) {
    const diagnostic = buildUnhandledErrorDiagnostic(error);
    await writeDiagnosticOutput(diagnostic);
    process.exitCode = 1;
  }
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

async function writeDiagnosticOutput(
  diagnostic: PublicListenerDiagnostic | PublicListenerMultiDiagnostic
): Promise<void> {
  const { incidentEvaluation, notifiableEvents } = await evaluatePublicListenerIncidents(diagnostic, {
    stateFilePath: process.env.PUBLIC_LISTENER_INCIDENT_STATE_PATH
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        incidentEvaluation,
        notifiableEvents,
        ...diagnostic
      },
      null,
      2
    )}\n`
  );
}

main().catch(async (error) => {
  const diagnostic = buildUnhandledErrorDiagnostic(error);
  await writeDiagnosticOutput(diagnostic);
  process.exitCode = 1;
});
