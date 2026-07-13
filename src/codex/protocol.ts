import type { JsonObject, JsonValue } from "../core/json.js";

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: JsonValue;
}

export interface JsonRpcNotification {
  method: string;
  params?: JsonValue;
}

export interface JsonRpcSuccessResponse {
  id: JsonRpcId;
  result: JsonValue;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface JsonRpcErrorResponse {
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export function hasId(value: JsonObject): value is JsonObject & { id: JsonRpcId } {
  return typeof value["id"] === "number" || typeof value["id"] === "string";
}

export function hasMethod(value: JsonObject): value is JsonObject & { method: string } {
  return typeof value["method"] === "string";
}
