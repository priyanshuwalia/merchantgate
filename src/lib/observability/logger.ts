type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  traceId?: string;
  event?: string;
  durationMs?: number;
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields: LogFields) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info(message: string, fields?: LogFields) {
    emit("info", message, fields || {});
  },
  warn(message: string, fields?: LogFields) {
    emit("warn", message, fields || {});
  },
  error(message: string, fields?: LogFields) {
    emit("error", message, fields || {});
  },
};
