// Centralized pino logger respecting LOG_LEVEL.
import { pino } from "pino";

export function createLogger(level: string) {
  const isDev = process.env.NODE_ENV !== "production";
  return pino({
    level,
    transport: isDev
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
