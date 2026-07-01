import type { PublicListenerMultiDiagnostic } from "../checks/public-listener-check/types.js";

export function formatStatusMessage(diagnostic: PublicListenerMultiDiagnostic): string {
  return [
    "📻 Status dos players",
    ...diagnostic.results.map((result) => {
      const label = result.targetName.trim() || result.targetId;
      const status = result.result.status === "healthy" ? "ONLINE" : "OFFLINE";
      return `${label}: ${status}`;
    })
  ].join("\n");
}
