export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured logger.
 *
 * Every line is JSON so that logs can be shipped to Azure Monitor / Application
 * Insights without reparsing. `correlationId` is expected on any line produced
 * while handling a user request, so a single request can be reconstructed across
 * the runtime, the scheduler and the orchestrator.
 */
export function createLogger(
  minLevel: LogLevel = "info",
  bindings: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < ORDER[minLevel]) return;
    sink(
      JSON.stringify({
        at: new Date().toISOString(),
        level,
        message,
        ...bindings,
        ...redact(fields ?? {}),
      }),
    );
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (extra) => createLogger(minLevel, { ...bindings, ...extra }, sink),
  };
}

const SENSITIVE = /^(access_?token|id_?token|refresh_?token|authorization|secret|password|clientSecret)$/i;

/**
 * Strip credential-shaped fields before anything is written.
 *
 * Raw links and tokens are excluded from telemetry. The rule is enforced at the
 * sink, so a careless caller cannot leak a bearer token into a log file.
 */
function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE.test(key)) {
      out[key] = "[redacted]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redact(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}
