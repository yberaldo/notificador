import { spawn } from "node:child_process";
import type { CommandResult } from "./types.js";

const MAX_CAPTURE_CHARS = 16_384;

export function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;

    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(timeoutMs, 1));

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"));
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      errorCode = error.code ?? "COMMAND_ERROR";
      errorMessage = error.message;
    });

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        command,
        args,
        exitCode,
        stdout,
        stderr,
        timedOut,
        errorCode,
        errorMessage,
        durationMs: Date.now() - startedAt
      });
    });
  });
}

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= MAX_CAPTURE_CHARS) {
    return combined;
  }

  return combined.slice(combined.length - MAX_CAPTURE_CHARS);
}
