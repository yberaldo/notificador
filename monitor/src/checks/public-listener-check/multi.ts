import { runPublicListenerCheck } from "./index.js";
import type {
  PublicListenerConfig,
  PublicListenerMultiDiagnostic,
  PublicListenerTargetDefinition
} from "./types.js";

export async function runPublicListenerMultiCheck(
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
