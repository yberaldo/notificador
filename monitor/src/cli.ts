#!/usr/bin/env node
import { loadConfig, loadTargetsConfig } from "./checks/public-listener-check/config.js";
import { runPublicListenerCheck } from "./checks/public-listener-check/index.js";
import { runPublicListenerMultiCheck } from "./checks/public-listener-check/multi.js";
import {
  buildUnhandledErrorDiagnostic,
  evaluatePublicListenerIncidents
} from "./incidents/evaluate-public-listener-incidents.js";
import type {
  PublicListenerDiagnostic,
  PublicListenerMultiDiagnostic
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

async function writeDiagnosticOutput(
  diagnostic: PublicListenerDiagnostic | PublicListenerMultiDiagnostic
): Promise<void> {
  const { incidentEvaluation, notifiableEvents } = await evaluatePublicListenerIncidents(diagnostic, {
    stateFilePath: process.env.PUBLIC_LISTENER_INCIDENT_STATE_PATH,
    outboxFilePath: process.env.PUBLIC_LISTENER_INCIDENT_OUTBOX_PATH
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
