import type { IncidentOutboxEntry } from "../outbox-types.js";
import type { DispatchAdapter, DispatchAdapterResult, DispatchNoopMode } from "../dispatch-types.js";

export function createNoopDispatchAdapter(mode: DispatchNoopMode): DispatchAdapter {
  return {
    name: "noop",
    async dispatch(entry: IncidentOutboxEntry): Promise<DispatchAdapterResult> {
      switch (mode) {
        case "retryable_error":
          return {
            outcome: "retryable_error",
            message: `noop adapter simulou erro retryable para ${entry.eventId}`
          };
        case "permanent_error":
          return {
            outcome: "permanent_error",
            message: `noop adapter simulou erro permanente para ${entry.eventId}`
          };
        case "success":
        default:
          return {
            outcome: "success",
            message: null
          };
      }
    }
  };
}