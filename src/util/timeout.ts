// withTimeout: wraps a promise with a hard timeout via setTimeout race.
// Throws a ToolError so the tool handler can map it to its own error code
// (e.g. "UPSTREAM_TIMEOUT" for LLM calls, "DB_TIMEOUT" for SQLite).
import { ToolError } from "./errors.js";

export interface WithTimeoutOptions {
  code?: string;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  options: WithTimeoutOptions = {},
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ToolError(options.code ?? "TIMEOUT", `${label} timed out after ${ms}ms`, label));
    }, ms);
  });
  try {
    return (await Promise.race([promise, timeout])) as T;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
