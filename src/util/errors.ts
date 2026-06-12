// Centralized error envelope helpers.
export class ToolError extends Error {
  public readonly code: string;
  public readonly tool: string;
  public readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, tool: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.tool = tool;
    this.details = details;
  }
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    tool: string;
    details?: Record<string, unknown>;
  };
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function toEnvelope(err: unknown, tool: string): ErrorEnvelope {
  if (err instanceof ToolError) {
    return {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        tool: err.tool,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
  }
  if (err instanceof Error) {
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: err.message, tool },
    };
  }
  return {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: String(err), tool },
  };
}

export function ok<T>(data: T): SuccessEnvelope<T> {
  return { ok: true, data };
}
