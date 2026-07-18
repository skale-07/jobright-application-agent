import { getConfig } from "../config/index.js";
import { redactObject } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = {
  application_id?: string;
  service?: string;
  action?: string;
  metadata?: Record<string, unknown>;
};

export function log(
  level: LogLevel,
  message: string,
  fields: LogFields = {},
): void {
  const config = getConfig();
  if (LEVEL_ORDER[level] < LEVEL_ORDER[config.logLevel]) {
    return;
  }
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    application_id: fields.application_id,
    service: fields.service,
    action: fields.action,
    metadata: fields.metadata ? redactObject(fields.metadata) : undefined,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, fields?: LogFields) => log("debug", message, fields),
  info: (message: string, fields?: LogFields) => log("info", message, fields),
  warn: (message: string, fields?: LogFields) => log("warn", message, fields),
  error: (message: string, fields?: LogFields) => log("error", message, fields),
};
