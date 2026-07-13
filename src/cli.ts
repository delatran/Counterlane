#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, writeDefaultConfig, DEFAULT_CONFIG_FILE } from "./config/load.js";
import { managedStatePrefixes } from "./config/managed-state.js";
import { Logger } from "./core/logger.js";
import { throwIfAborted } from "./core/abort.js";
import { validateThreadProvenance } from "./core/thread-provenance.js";
import { errorMessage, errorToJson } from "./core/errors.js";
import { runCommand } from "./core/process.js";
import { GitRepository } from "./git/repository.js";
import { CodexAppServer } from "./codex/app-server.js";
import { AutoRouter } from "./routing/router.js";
import { buildCalibrationIndex } from "./routing/calibration.js";
import { inspectVerificationCapabilities } from "./verification/detect.js";
import { deriveQuotaState } from "./routing/quota.js";
import {
  printExperiment,
  printHistory,
  printJson,
  printMetaDecision,
  printMetaExecution,
  printModels,
  printRoute,
  printSingle,
} from "./report/console.js";
import { resolvePrompt } from "./cli/prompt.js";
import { runDoctor } from "./cli/doctor.js";
import { TelemetryStore } from "./telemetry/store.js";
import { TwinRunner } from "./runner/twin.js";
import { SingleRunner } from "./runner/single.js";
import { MetaExecutionRunner } from "./runner/meta.js";
import { runMcpHttpServer, runMcpStdioServer } from "./mcp/server.js";
import type { RouteConstraints } from "./core/types.js";

function exitCleanlyOnBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
}

exitCleanlyOnBrokenPipe(process.stdout);
exitCleanlyOnBrokenPipe(process.stderr);

interface CommonOptions {
  cwd: string;
  configPath?: string;
  json: boolean;
  verbose: boolean;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? "help";
  const rest = argv.slice(1);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (command === "plugin") {
    const subcommand = rest[0] ?? "help";
    if (subcommand !== "install-local") {
      throw new Error("Usage: counterlane plugin install-local [--home PATH] [--link|--copy] [--force]");
    }
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        home: { type: "string" },
        copy: { type: "boolean", default: false },
        link: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
      },
      strict: true,
    });
    if (values.link && values.copy) {
      throw new Error("Choose either --link or --copy, not both.");
    }
    const installer = fileURLToPath(new URL("../scripts/install-local-plugin.mjs", import.meta.url));
    const installerArgs = [
      process.execPath,
      installer,
      ...(values.home === undefined ? [] : ["--home", values.home]),
      ...(values.link ? ["--link"] : values.copy ? ["--copy"] : []),
      ...(values.force ? ["--force"] : []),
    ];
    const result = await runCommand(installerArgs, {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      timeoutMs: 60_000,
      maximumOutputBytes: 1_000_000,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.exitCode ?? 1;
  }

  if (command === "mcp") {
    const { values } = parseArgs({
      args: rest,
      options: {
        stdio: { type: "boolean", default: false },
        http: { type: "boolean", default: false },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "string", default: "8787" },
        path: { type: "string", default: "/mcp" },
        "token-env": { type: "string", default: "COUNTERLANE_MCP_TOKEN" },
        "allow-origin": { type: "string", multiple: true, default: [] },
        "allow-root": { type: "string", multiple: true, default: [] },
        "allow-config-override": { type: "boolean", default: false },
        "session-ttl-ms": { type: "string", default: "86400000" },
        "max-sessions": { type: "string", default: "1024" },
        "max-session-concurrency": { type: "string", default: "8" },
      },
      strict: true,
    });
    if (values.stdio && values.http) {
      throw new Error("Choose either --stdio or --http, not both.");
    }
    if (values.http) {
      const port = Number(values.port);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--port must be an integer between 1 and 65535.");
      }
      const path = values.path.startsWith("/") ? values.path : `/${values.path}`;
      const token = process.env[values["token-env"]];
      const sessionTtlMs = parsePositiveInteger(values["session-ttl-ms"], "--session-ttl-ms");
      const maximumSessions = parsePositiveInteger(values["max-sessions"], "--max-sessions");
      const maximumConcurrentRequestsPerSession = parsePositiveInteger(
        values["max-session-concurrency"],
        "--max-session-concurrency",
      );
      await runMcpHttpServer({
        host: values.host,
        port,
        path,
        ...(token === undefined ? {} : { bearerToken: token }),
        allowedOrigins: values["allow-origin"],
        allowedRoots: values["allow-root"].map((root) => resolve(root)),
        ...(values["allow-config-override"] ? { allowConfigOverride: true } : {}),
        sessionTtlMs,
        maximumSessions,
        maximumConcurrentRequestsPerSession,
      });
    } else {
      await runMcpStdioServer();
    }
    return 0;
  }

  if (command === "init") {
    const { values } = parseArgs({
      args: rest,
      options: {
        path: { type: "string", default: DEFAULT_CONFIG_FILE },
        force: { type: "boolean", default: false },
      },
      strict: true,
    });
    await writeDefaultConfig(values.path, values.force);
    process.stdout.write(`Created ${resolve(values.path)}\n`);
    return 0;
  }

  const parsed = parseCommandArgs(rest);
  const common: CommonOptions = {
    cwd: resolve(parsed.values.cwd),
    ...(parsed.values.config === undefined ? {} : { configPath: parsed.values.config }),
    json: parsed.values.json,
    verbose: parsed.values.verbose,
  };
  const { config } = await loadConfig({
    cwd: common.cwd,
    ...(common.configPath === undefined ? {} : { configPath: common.configPath }),
  });
  const logger = new Logger({
    level: common.verbose ? "debug" : "info",
    json: common.json,
  });
  const constraints = routeConstraintsFromValues(parsed.values);

  if (command === "doctor") {
    const cancellation = installCancellationHandlers();
    try {
      const healthy = await runDoctor({
        cwd: common.cwd,
        config,
        logger,
        json: common.json,
        signal: cancellation.signal,
      });
      throwIfAborted(cancellation.signal);
      return healthy ? 0 : 1;
    } finally {
      cancellation.dispose();
    }
  }

  const repository = await GitRepository.discover(common.cwd);
  const telemetry = new TelemetryStore(repository.root, config);
  const cancellation = installCancellationHandlers();

  try {
    switch (command) {
    case "models": {
      const server = await CodexAppServer.connect({
        config,
        cwd: repository.root,
        logger,
        signal: cancellation.signal,
      });
      let catalog;
      try {
        catalog = await server.listModels(cancellation.signal);
      } finally {
        await server.close();
      }
      throwIfAborted(cancellation.signal);
      common.json ? printJson(catalog) : printModels(catalog);
      return 0;
    }
    case "route": {
      const prompt = await resolvePrompt({
        ...(parsed.values.prompt === undefined ? {} : { prompt: parsed.values.prompt }),
        ...(parsed.values.promptFile === undefined ? {} : { promptFile: parsed.values.promptFile }),
        positionals: parsed.positionals,
      });
      const server = await CodexAppServer.connect({
        config,
        cwd: repository.root,
        logger,
        signal: cancellation.signal,
      });
      let decision;
      try {
        const [catalog, rateLimits, profile, verificationCapabilities, telemetryEvents] = await Promise.all([
          server.listModels(cancellation.signal),
          server.readRateLimits(cancellation.signal),
          repository.profile(managedStatePrefixes(config)),
          inspectVerificationCapabilities(repository.root, config),
          telemetry.readLearningEvents(),
        ]);
        const quota = deriveQuotaState(rateLimits, config.routing.reservePercent);
        decision = new AutoRouter(config).decide({
          prompt,
          repo: profile,
          catalog,
          quota,
          verificationCapabilities,
          calibration: buildCalibrationIndex(telemetryEvents),
          ...(constraints === undefined ? {} : { constraints }),
        });
      } finally {
        await server.close();
      }
      throwIfAborted(cancellation.signal);
      common.json ? printJson(decision) : printRoute(decision);
      return 0;
    }
    case "decide": {
      const prompt = await resolvePrompt({
        ...(parsed.values.prompt === undefined ? {} : { prompt: parsed.values.prompt }),
        ...(parsed.values.promptFile === undefined ? {} : { promptFile: parsed.values.promptFile }),
        positionals: parsed.positionals,
      });
      const plan = await new MetaExecutionRunner({ repository, config, logger, telemetry }).plan(
        prompt,
        constraints,
        cancellation.signal,
      );
      throwIfAborted(cancellation.signal);
      common.json ? printJson(plan) : printMetaDecision(plan.decision);
      return 0;
    }
    case "auto": {
      const prompt = await resolvePrompt({
        ...(parsed.values.prompt === undefined ? {} : { prompt: parsed.values.prompt }),
        ...(parsed.values.promptFile === undefined ? {} : { promptFile: parsed.values.promptFile }),
        positionals: parsed.positionals,
      });
      const result = await new MetaExecutionRunner({ repository, config, logger, telemetry }).run({
        prompt,
        apply: parsed.values.apply,
        ...(parsed.values.threadId === undefined ? {} : { parentThreadId: parsed.values.threadId }),
        ...(parsed.values.lastTurnId === undefined ? {} : { lastTurnId: parsed.values.lastTurnId }),
        ...(constraints === undefined ? {} : { constraints }),
        signal: cancellation.signal,
      });
      common.json ? printJson(result) : printMetaExecution(result);
      if (cancellation.signal.aborted) return 130;
      if (result.decision.action === "abstain") {
        return 3;
      }
      if (result.single !== undefined) {
        return result.single.arm.successful ? 0 : 2;
      }
      return result.twin !== undefined && (result.twin.control.successful || result.twin.treatment.successful) ? 0 : 2;
    }
    case "compare": {
      const prompt = await resolvePrompt({
        ...(parsed.values.prompt === undefined ? {} : { prompt: parsed.values.prompt }),
        ...(parsed.values.promptFile === undefined ? {} : { promptFile: parsed.values.promptFile }),
        positionals: parsed.positionals,
      });
      const runner = new TwinRunner({ repository, config, logger, telemetry });
      const result = await runner.run({
        prompt,
        applyWinner: parsed.values.applyWinner,
        ...(parsed.values.threadId === undefined ? {} : { parentThreadId: parsed.values.threadId }),
        ...(parsed.values.lastTurnId === undefined ? {} : { lastTurnId: parsed.values.lastTurnId }),
        ...(constraints === undefined ? {} : { constraints }),
        signal: cancellation.signal,
      });
      common.json ? printJson(result) : printExperiment(result);
      if (cancellation.signal.aborted) return 130;
      return result.control.successful || result.treatment.successful ? 0 : 2;
    }
    case "run": {
      const prompt = await resolvePrompt({
        ...(parsed.values.prompt === undefined ? {} : { prompt: parsed.values.prompt }),
        ...(parsed.values.promptFile === undefined ? {} : { promptFile: parsed.values.promptFile }),
        positionals: parsed.positionals,
      });
      const mode = parsed.values.mode;
      if (mode !== "static" && mode !== "auto") {
        throw new Error("--mode must be static or auto.");
      }
      if (mode === "static" && constraints !== undefined) {
        throw new Error("Route constraint flags apply to Auto. Configure routing.static for a custom static baseline.");
      }
      const runner = new SingleRunner({ repository, config, logger, telemetry });
      const result = await runner.run({
        prompt,
        mode,
        apply: parsed.values.apply,
        ...(parsed.values.threadId === undefined ? {} : { parentThreadId: parsed.values.threadId }),
        ...(parsed.values.lastTurnId === undefined ? {} : { lastTurnId: parsed.values.lastTurnId }),
        ...(constraints === undefined ? {} : { constraints }),
        signal: cancellation.signal,
      });
      common.json ? printJson(result) : printSingle(result);
      if (cancellation.signal.aborted) return 130;
      return result.arm.successful ? 0 : 2;
    }
    case "history": {
      const events = await telemetry.readRecent(parsed.values.limit);
      common.json ? printJson(events) : printHistory(events);
      return 0;
    }
      default:
        throw new Error(`Unknown command: ${command}. Run counterlane help.`);
    }
  } finally {
    cancellation.dispose();
  }
}

function parseCommandArgs(args: string[]): {
  values: {
    cwd: string;
    config?: string;
    json: boolean;
    verbose: boolean;
    prompt?: string;
    promptFile?: string;
    applyWinner: boolean;
    apply: boolean;
    mode: string;
    threadId?: string;
    lastTurnId?: string;
    model?: string;
    family?: string;
    effort?: string;
    speed?: string;
    topology?: string;
    latencyPriority?: string;
    proofTier?: string;
    deadlineMs?: number;
    maxCredits?: number;
    limit: number;
  };
  positionals: string[];
} {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: "string", default: process.cwd() },
      config: { type: "string" },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "V", default: false },
      prompt: { type: "string", short: "p" },
      "prompt-file": { type: "string" },
      "apply-winner": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      mode: { type: "string", default: "auto" },
      "thread-id": { type: "string" },
      "last-turn-id": { type: "string" },
      model: { type: "string" },
      family: { type: "string" },
      effort: { type: "string" },
      speed: { type: "string" },
      topology: { type: "string" },
      "latency-priority": { type: "string" },
      "proof-tier": { type: "string" },
      "deadline-ms": { type: "string" },
      "max-credits": { type: "string" },
      limit: { type: "string", default: "20" },
    },
  });
  const limitText = parsed.values.limit.trim();
  const limit = Number(limitText);
  if (limitText.length === 0 || !Number.isSafeInteger(limit) || limit < 0) {
    throw new Error("--limit must be a non-negative integer.");
  }
  validateThreadProvenance({
    ...(parsed.values["thread-id"] === undefined ? {} : { parentThreadId: parsed.values["thread-id"] }),
    ...(parsed.values["last-turn-id"] === undefined ? {} : { lastTurnId: parsed.values["last-turn-id"] }),
    parentLabel: "--thread-id",
    lastTurnLabel: "--last-turn-id",
  });
  const deadlineMs = optionalPositiveInteger(parsed.values["deadline-ms"], "--deadline-ms");
  const maxCredits = optionalPositiveNumber(parsed.values["max-credits"], "--max-credits");
  return {
    values: {
      cwd: parsed.values.cwd,
      ...(parsed.values.config === undefined ? {} : { config: parsed.values.config }),
      json: parsed.values.json,
      verbose: parsed.values.verbose,
      ...(parsed.values.prompt === undefined ? {} : { prompt: parsed.values.prompt }),
      ...(parsed.values["prompt-file"] === undefined ? {} : { promptFile: parsed.values["prompt-file"] }),
      applyWinner: parsed.values["apply-winner"],
      apply: parsed.values.apply,
      mode: parsed.values.mode,
      ...(parsed.values["thread-id"] === undefined ? {} : { threadId: parsed.values["thread-id"] }),
      ...(parsed.values["last-turn-id"] === undefined ? {} : { lastTurnId: parsed.values["last-turn-id"] }),
      ...(parsed.values.model === undefined ? {} : { model: parsed.values.model }),
      ...(parsed.values.family === undefined ? {} : { family: parsed.values.family }),
      ...(parsed.values.effort === undefined ? {} : { effort: parsed.values.effort }),
      ...(parsed.values.speed === undefined ? {} : { speed: parsed.values.speed }),
      ...(parsed.values.topology === undefined ? {} : { topology: parsed.values.topology }),
      ...(parsed.values["latency-priority"] === undefined ? {} : { latencyPriority: parsed.values["latency-priority"] }),
      ...(parsed.values["proof-tier"] === undefined ? {} : { proofTier: parsed.values["proof-tier"] }),
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      ...(maxCredits === undefined ? {} : { maxCredits }),
      limit,
    },
    positionals: parsed.positionals,
  };
}

function routeConstraintsFromValues(values: {
  model?: string;
  family?: string;
  effort?: string;
  speed?: string;
  topology?: string;
  latencyPriority?: string;
  proofTier?: string;
  deadlineMs?: number;
  maxCredits?: number;
}): RouteConstraints | undefined {
  const constraints: RouteConstraints = {};
  if (values.model !== undefined && values.model !== "auto") constraints.modelId = values.model;
  if (values.family !== undefined && values.family !== "auto") {
    if (!(["luna", "terra", "sol"] as const).includes(values.family as "luna" | "terra" | "sol")) {
      throw new Error("--family must be auto, luna, terra, or sol.");
    }
    constraints.modelFamily = values.family as "luna" | "terra" | "sol";
  }
  if (values.effort !== undefined && values.effort !== "auto") constraints.effort = values.effort;
  if (values.speed !== undefined && values.speed !== "auto") constraints.speedId = values.speed;
  if (values.topology !== undefined && values.topology !== "auto") {
    if (values.topology !== "single" && values.topology !== "ultra") {
      throw new Error("--topology must be auto, single, or ultra.");
    }
    constraints.topology = values.topology;
  }
  if (values.latencyPriority !== undefined && values.latencyPriority !== "auto") {
    if (!(["economy", "balanced", "urgent"] as const).includes(values.latencyPriority as "economy" | "balanced" | "urgent")) {
      throw new Error("--latency-priority must be auto, economy, balanced, or urgent.");
    }
    constraints.latencyPriority = values.latencyPriority as "economy" | "balanced" | "urgent";
  }
  if (values.proofTier !== undefined && values.proofTier !== "auto") {
    if (!(["basic", "standard", "strong", "adversarial"] as const).includes(values.proofTier as "basic" | "standard" | "strong" | "adversarial")) {
      throw new Error("--proof-tier must be auto, basic, standard, strong, or adversarial.");
    }
    constraints.proofTier = values.proofTier as "basic" | "standard" | "strong" | "adversarial";
  }
  if (values.deadlineMs !== undefined) constraints.deadlineMs = values.deadlineMs;
  if (values.maxCredits !== undefined) constraints.maxNormalizedCredits = values.maxCredits;
  return Object.keys(constraints).length === 0 ? undefined : constraints;
}

function optionalPositiveInteger(value: string | undefined, flag: string): number | undefined {
  return value === undefined ? undefined : parsePositiveInteger(value, flag);
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function optionalPositiveNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number.`);
  }
  return parsed;
}

function installCancellationHandlers(): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  let signalCount = 0;
  const abort = (name: NodeJS.Signals): void => {
    signalCount += 1;
    if (!controller.signal.aborted) {
      const error = new Error(`Counterlane received ${name}; cancelling active Codex turns and verifier processes.`);
      error.name = "AbortError";
      controller.abort(error);
      process.stderr.write(`\nCancelling Counterlane (${name})… press again to terminate immediately.\n`);
      return;
    }
    if (signalCount >= 2) process.exit(130);
  };
  const onSigint = (): void => abort("SIGINT");
  const onSigterm = (): void => abort("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    signal: controller.signal,
    dispose(): void {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}

function printHelp(): void {
  process.stdout.write("Counterlane\n\n");
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  counterlane init [--path counterlane.config.json] [--force]\n`);
  process.stdout.write(`  counterlane plugin install-local [--home PATH] [--link|--copy] [--force]\n`);
  process.stdout.write(`  counterlane mcp [--stdio]\n`);
  process.stdout.write(`  counterlane mcp --http [--host 127.0.0.1] [--port 8787] [--path /mcp] [--allow-origin URL] [--allow-root PATH]\n`);
  process.stdout.write(`  counterlane doctor [--cwd PATH] [--config FILE]\n`);
  process.stdout.write(`  counterlane models [--json]\n`);
  process.stdout.write(`  counterlane route --prompt "TASK" [ROUTE_HINTS] [--json]\n`);
  process.stdout.write(`  counterlane decide --prompt "TASK" [ROUTE_HINTS] [--json]\n`);
  process.stdout.write(`  counterlane auto --prompt "TASK" [ROUTE_HINTS] [--apply]\n`);
  process.stdout.write(`  counterlane run --mode auto --prompt "TASK" [ROUTE_HINTS] [--apply]\n`);
  process.stdout.write(`  counterlane run --mode static --prompt "TASK" [--apply]\n`);
  process.stdout.write(`  counterlane compare --prompt "TASK" [ROUTE_HINTS] [--apply-winner]\n`);
  process.stdout.write(`  counterlane compare --thread-id THREAD [--last-turn-id TURN] --prompt "TASK"\n`);
  process.stdout.write(`  counterlane history [--limit 20] [--json]\n\n`);
  process.stdout.write(`Route hints: --model, --family, --effort, --speed, --topology, --proof-tier, --deadline-ms, --max-credits, and --latency-priority.\n`);
  process.stdout.write(`Use --speed to pin a service tier; use --latency-priority to let Auto trade latency against quota.\n`);
  process.stdout.write(`Use --proof-tier to pin evidence burden; deadlines and credit ceilings are hard safety constraints.\n`);
  process.stdout.write(`Prompts may also be supplied with --prompt-file, positional text, or stdin.\n`);
  process.stdout.write(`Install the bundled plugin, then invoke @Counterlane in ChatGPT Work/Desktop or $counterlane in Codex CLI/TUI.\n`);
  process.stdout.write(`Twin runs are isolated in Git worktrees; the original repository is unchanged unless an apply flag is explicit.\n`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const json = process.argv.includes("--json");
    if (json) {
      process.stderr.write(`${JSON.stringify({ error: errorToJson(error) }, null, 2)}\n`);
    } else {
      process.stderr.write(`ERROR ${errorMessage(error)}\n`);
      if (process.argv.includes("--verbose") || process.argv.includes("-V")) {
        process.stderr.write(`${error instanceof Error ? error.stack ?? "" : ""}\n`);
      }
    }
    process.exitCode = error instanceof Error && error.name === "AbortError" ? 130 : 1;
  },
);
