export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

/** Minimal structured logger interface so callers can plug in pino, winston, etc. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Logger that writes one JSON line per entry to stderr, keeping stdout free for
 * machine-readable command output.
 */
export function createLogger(
  level: LogLevel = "info",
  write: (line: string) => void = (line) => process.stderr.write(line + "\n"),
): Logger {
  const threshold = LEVEL_ORDER[level];
  const log =
    (lvl: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      if (LEVEL_ORDER[lvl] < threshold) return;
      write(JSON.stringify({ time: new Date().toISOString(), level: lvl, message, ...fields }));
    };
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

/** Logger that discards everything. Handy as a default in libraries and tests. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
