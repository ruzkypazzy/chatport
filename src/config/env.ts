// Centralized environment variable loading and validation.
import "dotenv/config";

export interface AppEnv {
  PORT: number;
  LOG_LEVEL: string;
  TOOL_TIMEOUT_MS: number;
  DATABASE_PATH: string;
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL: string;
  OPENAI_MODEL: string;
  MINIMAX_API_KEY: string;
  MINIMAX_BASE_URL: string;
  MINIMAX_MODEL: string;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function readString(name: string, fallback?: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) {
      throw new Error(`Environment variable ${name} is required`);
    }
    return fallback;
  }
  return raw;
}

export function loadEnv(): AppEnv {
  return {
    PORT: readNumber("PORT", 3000),
    LOG_LEVEL: readString("LOG_LEVEL", "info"),
    TOOL_TIMEOUT_MS: readNumber("TOOL_TIMEOUT_MS", 30_000),
    DATABASE_PATH: readString("DATABASE_PATH", "./chatport.db"),
    OPENAI_API_KEY: readString("OPENAI_API_KEY", ""),
    OPENAI_BASE_URL: readString("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    OPENAI_MODEL: readString("OPENAI_MODEL", "gpt-4o-mini"),
    MINIMAX_API_KEY: readString("MINIMAX_API_KEY", ""),
    MINIMAX_BASE_URL: readString("MINIMAX_BASE_URL", "https://api.minimax.io/v1"),
    MINIMAX_MODEL: readString("MINIMAX_MODEL", "MiniMax-M3"),
  };
}
