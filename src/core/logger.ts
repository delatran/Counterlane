import type { JsonObject, JsonValue } from "./json.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LoggerOptions {
  level: LogLevel;
  json: boolean;
  stream?: NodeJS.WritableStream;
  context?: JsonObject;
}

export class Logger {
  readonly #level: LogLevel;
  readonly #json: boolean;
  readonly #stream: NodeJS.WritableStream;
  readonly #context: JsonObject;

  public constructor(options: LoggerOptions) {
    this.#level = options.level;
    this.#json = options.json;
    this.#stream = options.stream ?? process.stderr;
    this.#context = options.context ?? {};
  }

  public child(context: JsonObject): Logger {
    return new Logger({
      level: this.#level,
      json: this.#json,
      stream: this.#stream,
      context: { ...this.#context, ...context },
    });
  }

  public debug(message: string, fields?: JsonObject): void {
    this.#write("debug", message, fields);
  }

  public info(message: string, fields?: JsonObject): void {
    this.#write("info", message, fields);
  }

  public warn(message: string, fields?: JsonObject): void {
    this.#write("warn", message, fields);
  }

  public error(message: string, fields?: JsonObject): void {
    this.#write("error", message, fields);
  }

  #write(level: Exclude<LogLevel, "silent">, message: string, fields?: JsonObject): void {
    if (priorities[level] < priorities[this.#level]) {
      return;
    }

    const record: JsonObject = {
      ...this.#context,
      ...(fields ?? {}),
      timestamp: new Date().toISOString(),
      level,
      message,
    };

    if (this.#json) {
      this.#stream.write(`${JSON.stringify(record)}\n`);
      return;
    }

    const suffix = fields === undefined ? "" : ` ${formatFields({ ...this.#context, ...fields })}`;
    this.#stream.write(`${level.toUpperCase().padEnd(5)} ${message}${suffix}\n`);
  }
}

function formatFields(fields: JsonObject): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
}

function formatValue(value: JsonValue): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}
