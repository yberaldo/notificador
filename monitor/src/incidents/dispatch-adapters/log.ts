import type { IncidentOutboxEntry } from "../outbox-types.js";
import type { DispatchAdapter, DispatchAdapterResult } from "../dispatch-types.js";

export function createLogDispatchAdapter(): DispatchAdapter {
  return {
    name: "log",
    async dispatch(entry: IncidentOutboxEntry): Promise<DispatchAdapterResult> {
      return {
        outcome: "success",
        message: null,
        logMessage: [
          "[radio-cabrito-dispatch-outbox]",
          `type=${entry.type}`,
          `targetId=${entry.targetId}`,
          `severity=${entry.severity}`,
          `dedupeKey=${entry.dedupeKey}`,
          `eventId=${entry.eventId}`
        ].join(" ")
      };
    }
  };
}