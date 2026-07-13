import type { JsonObject } from "./json.js";

export class CounterlaneError extends Error {
  public readonly code: string;
  public readonly details?: JsonObject;

  public constructor(message: string, code = "COUNTERLANE_ERROR", details?: JsonObject) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export class ConfigurationError extends CounterlaneError {
  public constructor(message: string, details?: JsonObject) {
    super(message, "CONFIGURATION_ERROR", details);
  }
}

export class SafetyError extends CounterlaneError {
  public constructor(message: string, details?: JsonObject) {
    super(message, "SAFETY_ERROR", details);
  }
}

export class MetaPlanInvalidatedError extends CounterlaneError {
  public constructor(message: string, details?: JsonObject) {
    super(message, "META_PLAN_INVALIDATED", details);
  }
}

export class GitError extends CounterlaneError {
  public constructor(message: string, details?: JsonObject) {
    super(message, "GIT_ERROR", details);
  }
}

export class CommandExecutionError extends CounterlaneError {
  public constructor(message: string, details?: JsonObject) {
    super(message, "COMMAND_EXECUTION_ERROR", details);
  }
}

export class CodexProtocolError extends CounterlaneError {
  public readonly rpcCode?: number;

  public constructor(message: string, rpcCode?: number, details?: JsonObject) {
    super(message, "CODEX_PROTOCOL_ERROR", details);
    if (rpcCode !== undefined) {
      this.rpcCode = rpcCode;
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorToJson(error: unknown): JsonObject {
  if (error instanceof CounterlaneError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error instanceof CodexProtocolError && error.rpcCode !== undefined ? { rpcCode: error.rpcCode } : {}),
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}
