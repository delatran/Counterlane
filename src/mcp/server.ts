import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { isJsonObject, type JsonValue } from "../core/json.js";
import { errorMessage } from "../core/errors.js";
import { COUNTERLANE_MCP_BUILD_ID, COUNTERLANE_TOOLS, callCounterlaneTool, type McpToolContext } from "./tools.js";

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
]);
const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_MCP_STDIO_FRAME_BYTES = 2 * 1024 * 1024;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAXIMUM_SESSIONS = 1_024;
const DEFAULT_MAXIMUM_CONCURRENT_REQUESTS = 8;
const SHUTDOWN_GRACE_MS = 5_000;

type RpcId = string | number | null;

interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
}

export interface McpHttpOptions {
  host: string;
  port: number;
  path: string;
  bearerToken?: string;
  allowedOrigins?: string[];
  allowedRoots?: string[];
  allowConfigOverride?: boolean;
  sessionTtlMs?: number;
  maximumSessions?: number;
  maximumConcurrentRequestsPerSession?: number;
}

interface McpHttpSession {
  protocolVersion: string;
  createdAt: number;
  lastAccessAt: number;
  initialized: boolean;
  activeRequests: number;
  controllers: Map<string, AbortController>;
}

export async function runMcpStdioServer(): Promise<void> {
  let initializeAccepted = false;
  let initialized = false;
  const active = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();

  try {
    for await (const frame of readBoundedStdioFrames(process.stdin)) {
      if (frame.oversized) {
        writeStdio(errorResponse(
          null,
          -32000,
          "Request frame too large",
          `MCP stdio frame exceeds ${MAX_MCP_STDIO_FRAME_BYTES} bytes`,
        ));
        continue;
      }
      const line = frame.line;
      if (line.trim().length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch (error) {
        writeStdio(errorResponse(null, -32700, "Parse error", errorMessage(error)));
        continue;
      }
      if (!isJsonObject(message)) {
        writeStdio(errorResponse(null, -32600, "Invalid Request"));
        continue;
      }
      const id = rpcId(message["id"]);
      if (message["jsonrpc"] !== "2.0") {
        if (id !== undefined) writeStdio(errorResponse(id, -32600, "Invalid Request: jsonrpc must equal 2.0"));
        continue;
      }
      const method = typeof message["method"] === "string" ? message["method"] : undefined;
      if (method === undefined) {
        if (id !== undefined) writeStdio(errorResponse(id, -32600, "Invalid Request"));
        continue;
      }

      if (id === undefined) {
        if ((method === "notifications/initialized" || method === "initialized") && initializeAccepted) initialized = true;
        else if (method === "notifications/cancelled") abortRequestedRpc(active, message["params"]);
        continue;
      }

      if (method === "initialize") {
        // Initialization is the only serialized request. Official clients wait
        // for its response before emitting notifications/initialized.
        const response = await handleRpcRequest(method, message["params"], id, false, { allowConfigOverride: false });
        initializeAccepted = response.error === undefined;
        writeStdio(response);
        continue;
      }

      const key = rpcRequestKey(id);
      if (active.has(key)) {
        writeStdio(errorResponse(id, -32600, "Duplicate in-flight request id"));
        continue;
      }
      if (active.size >= DEFAULT_MAXIMUM_CONCURRENT_REQUESTS) {
        writeStdio(errorResponse(id, -32004, "Too many concurrent MCP stdio requests"));
        continue;
      }
      const controller = new AbortController();
      active.set(key, controller);
      const task = handleRpcRequest(method, message["params"], id, initialized, {
        allowConfigOverride: false,
        signal: controller.signal,
      }).then(writeStdio).finally(() => {
        if (active.get(key) === controller) active.delete(key);
        tasks.delete(task);
      });
      tasks.add(task);
    }
  } finally {
    for (const controller of active.values()) controller.abort(cancellationError("MCP stdio transport closed."));
    await Promise.allSettled(tasks);
  }
}

export type BoundedStdioFrame =
  | { oversized: false; line: string }
  | { oversized: true };

export async function* readBoundedStdioFrames(
  input: AsyncIterable<Buffer | string>,
  maximumBytes = MAX_MCP_STDIO_FRAME_BYTES,
): AsyncGenerator<BoundedStdioFrame> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("maximumBytes must be a positive safe integer.");
  }
  let chunks: Buffer[] = [];
  let frameBytes = 0;
  let oversized = false;

  const append = (chunk: Buffer): void => {
    if (oversized || chunk.length === 0) return;
    if (chunk.length > maximumBytes - frameBytes) {
      oversized = true;
      chunks = [];
      frameBytes = 0;
      return;
    }
    chunks.push(chunk);
    frameBytes += chunk.length;
  };

  for await (const inputChunk of input) {
    const chunk = Buffer.isBuffer(inputChunk) ? inputChunk : Buffer.from(inputChunk, "utf8");
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      append(chunk.subarray(offset, end));
      if (newline === -1) break;

      if (oversized) {
        yield { oversized: true };
      } else {
        const combined = Buffer.concat(chunks, frameBytes);
        const content = combined.at(-1) === 0x0d ? combined.subarray(0, -1) : combined;
        yield { oversized: false, line: content.toString("utf8") };
      }
      chunks = [];
      frameBytes = 0;
      oversized = false;
      offset = newline + 1;
    }
  }

  if (oversized) {
    yield { oversized: true };
  } else if (frameBytes > 0) {
    const combined = Buffer.concat(chunks, frameBytes);
    const content = combined.at(-1) === 0x0d ? combined.subarray(0, -1) : combined;
    yield { oversized: false, line: content.toString("utf8") };
  }
}

export async function runMcpHttpServer(options: McpHttpOptions): Promise<void> {
  if (!isLoopbackHost(options.host)) {
    if (options.bearerToken === undefined || options.bearerToken.length < 16) {
      throw new Error("Non-loopback MCP binding requires a bearer token of at least 16 characters.");
    }
    if (options.allowedRoots === undefined || options.allowedRoots.length === 0) {
      throw new Error("Non-loopback MCP binding requires at least one --allow-root repository boundary.");
    }
  }
  const sessions = new Map<string, McpHttpSession>();
  const server = createServer(async (request, response) => {
    try {
      await handleHttpRequest(request, response, options, sessions);
    } catch (error) {
      writeHttpJson(response, 500, errorResponse(null, -32603, "Internal error", errorMessage(error)));
    }
  });
  server.requestTimeout = 0; // Tool requests own their cancellation/deadline policy.
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolvePromise());
  });

  process.stderr.write(`Counterlane MCP listening on http://${options.host}:${options.port}${options.path}\n`);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (reason = "Counterlane MCP server is shutting down."): Promise<void> => {
    shutdownPromise ??= (async () => {
      for (const session of sessions.values()) abortSession(session, reason);
      sessions.clear();
      const graceful = new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      const force = new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          server.closeAllConnections();
          resolvePromise();
        }, SHUTDOWN_GRACE_MS);
        timer.unref();
      });
      await Promise.race([graceful, force]);
    })();
    return shutdownPromise;
  };
  const onSigint = (): void => { void shutdown("Counterlane MCP received SIGINT."); };
  const onSigterm = (): void => { void shutdown("Counterlane MCP received SIGTERM."); };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    await new Promise<void>((resolvePromise) => server.once("close", () => resolvePromise()));
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await shutdownPromise?.catch(() => undefined);
  }
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: McpHttpOptions,
  sessions: Map<string, McpHttpSession>,
): Promise<void> {
  pruneExpiredSessions(sessions, options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/healthz" || url.pathname === "/readyz") {
    writeHttpJson(response, 200, { status: "ok", service: "counterlane-mcp" });
    return;
  }
  if (url.pathname !== options.path) {
    writeHttpJson(response, 404, { error: "not_found" });
    return;
  }
  if (!validOrigin(request, options.allowedOrigins ?? [])) {
    writeHttpJson(response, 403, errorResponse(null, -32000, "Forbidden Origin"));
    return;
  }
  applyCorsHeaders(request, response, options.allowedOrigins ?? []);
  if (!authorized(request, options.bearerToken)) {
    response.setHeader("WWW-Authenticate", "Bearer");
    writeHttpJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (request.method === "GET") {
    response.statusCode = 405;
    response.setHeader("Allow", "POST, DELETE, OPTIONS");
    response.end();
    return;
  }
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.setHeader("Allow", "POST, DELETE, OPTIONS");
    response.end();
    return;
  }
  if (request.method === "DELETE") {
    const sessionId = headerValue(request, "mcp-session-id");
    const session = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (sessionId === undefined || session === undefined) {
      writeHttpJson(response, 404, { error: "session_not_found" });
      return;
    }
    abortSession(session, "MCP session terminated by client.");
    sessions.delete(sessionId);
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method !== "POST") {
    writeHttpJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  if (!acceptsMcpResponse(request)) {
    writeHttpJson(response, 406, { error: "accept_must_include_application_json_and_text_event_stream" });
    return;
  }
  const contentType = headerValue(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    writeHttpJson(response, 415, { error: "content_type_must_be_application_json" });
    return;
  }

  let body: string;
  try {
    body = await readBody(request, MAX_HTTP_BODY_BYTES);
  } catch (error) {
    writeHttpJson(response, 413, errorResponse(null, -32000, "Request body too large", errorMessage(error)));
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(body) as unknown;
  } catch (error) {
    writeHttpJson(response, 400, errorResponse(null, -32700, "Parse error", errorMessage(error)));
    return;
  }
  if (!isJsonObject(message)) {
    writeHttpJson(response, 400, errorResponse(null, -32600, "Invalid Request"));
    return;
  }

  const id = rpcId(message["id"]);
  if (message["jsonrpc"] !== "2.0") {
    writeHttpJson(response, 400, errorResponse(id ?? null, -32600, "Invalid Request: jsonrpc must equal 2.0"));
    return;
  }
  const method = typeof message["method"] === "string" ? message["method"] : undefined;
  if (method === undefined) {
    if (id !== undefined && ("result" in message || "error" in message)) {
      response.statusCode = 202;
      response.end();
      return;
    }
    writeHttpJson(response, 400, errorResponse(id ?? null, -32600, "Invalid Request"));
    return;
  }

  if (method === "initialize") {
    if (id === undefined) {
      writeHttpJson(response, 400, errorResponse(null, -32600, "initialize must be a request"));
      return;
    }
    const requestedVersion = isJsonObject(message["params"]) && typeof message["params"]["protocolVersion"] === "string"
      ? message["params"]["protocolVersion"]
      : null;
    if (requestedVersion === null) {
      writeHttpJson(response, 400, errorResponse(id, -32602, "initialize requires a supported protocolVersion"));
      return;
    }
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)) {
      writeHttpJson(response, 400, errorResponse(id, -32602, `Unsupported MCP protocol version: ${requestedVersion}`));
      return;
    }
    const maximumSessions = options.maximumSessions ?? DEFAULT_MAXIMUM_SESSIONS;
    if (sessions.size >= maximumSessions) {
      writeHttpJson(response, 503, errorResponse(id, -32003, "MCP session capacity reached"));
      return;
    }
    // Reserve capacity before the first await. Concurrent initialize requests
    // cannot all pass a stale sessions.size check and oversubscribe the bound.
    const sessionId = randomUUID();
    const now = Date.now();
    const session: McpHttpSession = {
      protocolVersion: requestedVersion,
      createdAt: now,
      lastAccessAt: now,
      initialized: false,
      activeRequests: 1,
      controllers: new Map(),
    };
    sessions.set(sessionId, session);
    const onInitializeDisconnect = (): void => {
      if (!response.writableEnded && sessions.get(sessionId) === session) sessions.delete(sessionId);
    };
    request.once("aborted", onInitializeDisconnect);
    response.once("close", onInitializeDisconnect);
    try {
      const result = await handleRpcRequest(method, message["params"], id, false, httpToolContext(options));
      if (sessions.get(sessionId) !== session) return;
      if (result.error === undefined) {
        session.activeRequests = 0;
        session.lastAccessAt = Date.now();
        response.setHeader("MCP-Session-Id", sessionId);
        response.setHeader("MCP-Protocol-Version", requestedVersion);
      } else {
        sessions.delete(sessionId);
      }
      writeHttpJson(response, result.error === undefined ? 200 : 400, result);
    } catch (error) {
      sessions.delete(sessionId);
      throw error;
    } finally {
      request.removeListener("aborted", onInitializeDisconnect);
      response.removeListener("close", onInitializeDisconnect);
    }
    return;
  }

  const sessionId = headerValue(request, "mcp-session-id");
  if (sessionId === undefined) {
    writeHttpJson(response, 400, errorResponse(id ?? null, -32001, "MCP-Session-Id is required after initialization"));
    return;
  }
  const session = sessions.get(sessionId);
  if (session === undefined) {
    writeHttpJson(response, 404, errorResponse(id ?? null, -32001, "MCP session not found"));
    return;
  }
  session.lastAccessAt = Date.now();
  const protocolVersion = headerValue(request, "mcp-protocol-version");
  if (protocolVersion === undefined || protocolVersion !== session.protocolVersion) {
    writeHttpJson(response, 400, errorResponse(id ?? null, -32602, `MCP-Protocol-Version must equal ${session.protocolVersion}`));
    return;
  }
  response.setHeader("MCP-Protocol-Version", session.protocolVersion);

  if (id === undefined) {
    if (method === "notifications/initialized" || method === "initialized") session.initialized = true;
    else if (method === "notifications/cancelled") abortRequestedRpc(session.controllers, message["params"]);
    response.statusCode = 202;
    response.end();
    return;
  }
  const key = rpcRequestKey(id);
  if (session.controllers.has(key)) {
    writeHttpJson(response, 400, errorResponse(id, -32600, "Duplicate in-flight request id"));
    return;
  }
  const maximumConcurrent = options.maximumConcurrentRequestsPerSession ?? DEFAULT_MAXIMUM_CONCURRENT_REQUESTS;
  if (session.activeRequests >= maximumConcurrent) {
    writeHttpJson(response, 429, errorResponse(id, -32004, "Too many concurrent MCP requests for this session"));
    return;
  }
  const controller = new AbortController();
  session.controllers.set(key, controller);
  session.activeRequests += 1;
  const onDisconnect = (): void => {
    if (!response.writableEnded) controller.abort(cancellationError("MCP HTTP client disconnected."));
  };
  request.once("aborted", onDisconnect);
  response.once("close", onDisconnect);
  try {
    const result = await handleRpcRequest(method, message["params"], id, session.initialized, {
      ...httpToolContext(options),
      signal: controller.signal,
    });
    writeHttpJson(response, result.error === undefined ? 200 : 400, result);
  } finally {
    request.removeListener("aborted", onDisconnect);
    response.removeListener("close", onDisconnect);
    if (session.controllers.get(key) === controller) session.controllers.delete(key);
    session.activeRequests -= 1;
    session.lastAccessAt = Date.now();
  }
}

async function handleRpcRequest(
  method: string,
  params: JsonValue | undefined,
  id: RpcId,
  initialized: boolean,
  toolContext: McpToolContext,
): Promise<RpcResponse> {
  if (method !== "initialize" && !initialized) return errorResponse(id, -32002, "Not initialized");
  try {
    switch (method) {
      case "initialize": {
        const requestedVersion = isJsonObject(params) && typeof params["protocolVersion"] === "string"
          ? params["protocolVersion"]
          : null;
        if (requestedVersion === null || !SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)) {
          return errorResponse(
            id,
            -32602,
            requestedVersion === null
              ? "initialize requires a supported protocolVersion"
              : `Unsupported MCP protocol version: ${requestedVersion}`,
          );
        }
        return successResponse(id, {
          protocolVersion: requestedVersion,
          capabilities: { tools: { listChanged: false }, logging: {} },
          serverInfo: { name: "counterlane", title: "Counterlane", version: COUNTERLANE_MCP_BUILD_ID },
          instructions:
            "Counterlane jointly routes Codex model, reasoning effort, speed/service tier, topology, and verification. MCP execution delegates to a nested Counterlane control plane; it cannot retroactively change the already-running parent turn.",
        });
      }
      case "ping":
      case "logging/setLevel":
        return successResponse(id, {});
      case "tools/list":
        return successResponse(id, { tools: COUNTERLANE_TOOLS as unknown as JsonValue });
      case "tools/call": {
        if (!isJsonObject(params) || typeof params["name"] !== "string") {
          return errorResponse(id, -32602, "tools/call requires a string name");
        }
        const result = await callCounterlaneTool(params["name"], params["arguments"], toolContext);
        return successResponse(id, result as unknown as JsonValue);
      }
      case "resources/list":
        return successResponse(id, { resources: [] });
      case "prompts/list":
        return successResponse(id, { prompts: [] });
      default:
        return errorResponse(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    return errorResponse(id, -32603, "Internal error", errorMessage(error));
  }
}

function successResponse(id: RpcId, result: JsonValue): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: RpcId, code: number, message: string, data?: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function rpcId(value: JsonValue | undefined): RpcId | undefined {
  return typeof value === "string" || typeof value === "number" || value === null ? value : undefined;
}

function rpcRequestKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

function abortRequestedRpc(active: Map<string, AbortController>, params: JsonValue | undefined): void {
  if (!isJsonObject(params)) return;
  const requestId = rpcId(params["requestId"]);
  if (requestId === undefined) return;
  const reason = typeof params["reason"] === "string" ? params["reason"] : "MCP request cancelled by client.";
  active.get(rpcRequestKey(requestId))?.abort(cancellationError(reason));
}

function cancellationError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function abortSession(session: McpHttpSession, reason: string): void {
  for (const controller of session.controllers.values()) controller.abort(cancellationError(reason));
  session.controllers.clear();
}

function writeStdio(value: RpcResponse): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeHttpJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

export function httpToolContext(options: McpHttpOptions): McpToolContext {
  return {
    defaultCwd: process.cwd(),
    ...(options.allowedRoots === undefined || options.allowedRoots.length === 0 ? {} : { allowedRoots: options.allowedRoots }),
    allowConfigOverride: options.allowConfigOverride ?? false,
  };
}

function applyCorsHeaders(request: IncomingMessage, response: ServerResponse, allowedOrigins: readonly string[]): void {
  const origin = headerValue(request, "origin");
  if (origin === undefined || !allowedOrigins.includes(origin)) return;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Session-Id, MCP-Protocol-Version");
  response.setHeader("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
  response.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id, MCP-Protocol-Version");
}

function validOrigin(request: IncomingMessage, allowedOrigins: readonly string[]): boolean {
  const origin = headerValue(request, "origin");
  return origin === undefined || allowedOrigins.includes(origin);
}

function acceptsMcpResponse(request: IncomingMessage): boolean {
  const accept = headerValue(request, "accept");
  if (accept === undefined) return false;
  const values = new Set(accept.split(",").map((value) => value.split(";", 1)[0]?.trim().toLowerCase()));
  return values.has("application/json") && values.has("text/event-stream");
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function authorized(request: IncomingMessage, expectedToken: string | undefined): boolean {
  if (expectedToken === undefined || expectedToken.length === 0) return true;
  const actual = request.headers.authorization;
  if (typeof actual !== "string") return false;
  const expected = `Bearer ${expectedToken}`;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function pruneExpiredSessions(sessions: Map<string, McpHttpSession>, sessionTtlMs: number): void {
  const cutoff = Date.now() - sessionTtlMs;
  for (const [sessionId, session] of sessions) {
    if (session.lastAccessAt < cutoff && session.activeRequests === 0) {
      abortSession(session, "MCP session expired.");
      sessions.delete(sessionId);
    }
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error(`HTTP body exceeds ${limit} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
