import type { PublicListenerResult } from "../checks/public-listener-check/types.js";
import type { IncidentFailureClass, IncidentPolicySnapshot } from "./types.js";

const STRUCTURAL_REASONS = [
  "missing_stream_url",
  "unsupported_protocol",
  "invalid_stream_url",
  "ffmpeg_not_available",
  "ffprobe_not_available",
  "cli_unhandled_error",
  "tls_required_but_url_is_not_https"
] as const;

const QUALITY_STATUSES = ["silent", "stalled"] as const;

export const INCIDENT_POLICY: IncidentPolicySnapshot = {
  structuralOpenThreshold: 1,
  criticalOpenThreshold: 2,
  qualityOpenThreshold: 3,
  resolveAfterConsecutiveSuccesses: 2,
  structuralReasons: [...STRUCTURAL_REASONS],
  qualityStatuses: [...QUALITY_STATUSES]
};

const STRUCTURAL_REASON_SET = new Set<string>(STRUCTURAL_REASONS);
const QUALITY_STATUS_SET = new Set<string>(QUALITY_STATUSES);

export interface IncidentPolicyDecision {
  failureClass: IncidentFailureClass;
  structuralFailure: boolean;
  openAfterConsecutiveFailures: number | null;
  resolveAfterConsecutiveSuccesses: number;
}

export function classifyIncidentPolicy(result: Pick<PublicListenerResult, "status" | "reason">): IncidentPolicyDecision {
  if (result.status === "healthy") {
    return {
      failureClass: "healthy",
      structuralFailure: false,
      openAfterConsecutiveFailures: null,
      resolveAfterConsecutiveSuccesses: INCIDENT_POLICY.resolveAfterConsecutiveSuccesses
    };
  }

  if (STRUCTURAL_REASON_SET.has(result.reason)) {
    return {
      failureClass: "structural",
      structuralFailure: true,
      openAfterConsecutiveFailures: INCIDENT_POLICY.structuralOpenThreshold,
      resolveAfterConsecutiveSuccesses: INCIDENT_POLICY.resolveAfterConsecutiveSuccesses
    };
  }

  if (QUALITY_STATUS_SET.has(result.status)) {
    return {
      failureClass: "quality",
      structuralFailure: false,
      openAfterConsecutiveFailures: INCIDENT_POLICY.qualityOpenThreshold,
      resolveAfterConsecutiveSuccesses: INCIDENT_POLICY.resolveAfterConsecutiveSuccesses
    };
  }

  return {
    failureClass: "critical",
    structuralFailure: false,
    openAfterConsecutiveFailures: INCIDENT_POLICY.criticalOpenThreshold,
    resolveAfterConsecutiveSuccesses: INCIDENT_POLICY.resolveAfterConsecutiveSuccesses
  };
}
