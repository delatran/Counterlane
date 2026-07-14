import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseModelCatalog } from "../../src/codex/catalog.js";
import type { QuotaState, RepoProfile } from "../../src/core/types.js";
import { AutoRouter, requireAdmissibleRoute } from "../../src/routing/router.js";
import { summarizeRoute } from "../../src/mcp/tools.js";
import { testConfig } from "../helpers.js";

const catalog = parseModelCatalog({
  data: [
    entry("gpt-5.6-luna", false, ["low", "medium", "high", "max"]),
    entry("gpt-5.6-terra", false, ["low", "medium", "high", "xhigh", "max"]),
    entry("gpt-5.6-sol", true, ["low", "medium", "high", "xhigh", "max", "ultra"]),
  ],
});

const repo: RepoProfile = {
  root: "/repo",
  headCommit: "abc",
  branch: "main",
  dirty: false,
  trackedFileCount: 200,
  untrackedFileCount: 0,
  changedFileCount: 0,
  packageCount: 1,
  testFileCount: 40,
  languages: { TypeScript: 180 },
  sensitivePathHits: [],
  manifests: ["package.json"],
  verifierHints: ["node"],
  profileHash: "hash",
};

const healthyQuota: QuotaState = {
  known: true,
  exhausted: false,
  rateLimitReachedType: null,
  usedPercent: 10,
  remainingPercent: 90,
  resetAt: null,
  minutesUntilReset: null,
  pressure: 0.1,
  healthy: true,
  sourceLimitId: "codex",
};

void test("mechanical, testable work avoids the most expensive family", () => {
  const decision = new AutoRouter(testConfig()).decide({
    prompt: "Rename the typo in src/name.ts exactly as specified and run the existing tests and typecheck.",
    repo,
    catalog,
    quota: healthyQuota,
  });
  assert.notEqual(decision.selected.modelFamily, "sol");
  assert.equal(decision.selected.topology, "single");
  assert.ok(decision.selected.admissible);
  assert.equal(
    decision.selected.predictedNormalizedCredits,
    Math.min(...decision.candidates.filter((candidate) => candidate.admissible)
      .map((candidate) => candidate.predictedNormalizedCredits)),
  );
});

void test("dense algorithmic contracts require completion strength before minimizing route cost", () => {
  const prompt = `Implement a production-quality deterministic causal event-stream reconciler in src/reconcile.ts.

Requirements:
- streams must be validated before applying events;
- replica identifiers must be unique non-empty strings;
- sequence numbers must be positive safe integers;
- dependencies must reference existing events;
- the dependency graph must be acyclic;
- each event must include an exact operation shape;
- set operations must deep clone JSON values;
- delete operations must preserve prototype safety;
- increment operations must reject safe-integer overflow;
- the immediately previous event is an implicit dependency;
- error classes must distinguish wrong types from invalid values;
- returned snapshots must be independent deep-cloned objects;
- unknown dependencies must fail before state mutation;
- output keys and ordering must be deterministic and exact.

Treat this as production reconciliation code and run the task-specific tests.`;
  const wordingVariant = prompt
    .replaceAll("production-quality", "robust")
    .replaceAll("production reconciliation code", "robust reconciliation logic")
    .replaceAll("immediately previous", "prior")
    .replaceAll("independent deep-cloned", "separately deep-cloned")
    .replaceAll("unknown dependencies", "missing dependencies");
  const config = testConfig();

  for (const candidatePrompt of [prompt, wordingVariant]) {
    const decision = new AutoRouter(config).decide({
      prompt: candidatePrompt,
      repo,
      catalog,
      quota: healthyQuota,
    });
    assert.equal(decision.features.taskKind, "feature");
    assert.ok(decision.features.depth >= 0.72, `expected elevated depth, received ${decision.features.depth}`);
    assert.equal(decision.features.latencySensitivity, 0);
    assert.ok(decision.features.parallelizability < 0.62);
    assert.ok(decision.selected.successEstimate >= config.routing.minimumCompletion.elevated);
    assert.ok(decision.rationale.some((reason) => reason.includes("heuristic prior")));
    assert.equal(
      decision.selected.predictedNormalizedCredits,
      Math.min(...decision.candidates.filter((candidate) => candidate.admissible)
        .map((candidate) => candidate.predictedNormalizedCredits)),
    );

    const terraLow = decision.candidates.find((candidate) =>
      candidate.modelFamily === "terra" && candidate.effort === "low" &&
      candidate.speedId === "standard" && candidate.proofTier === "standard"
    );
    assert.ok(terraLow);
    assert.equal(terraLow?.admissible, false);
    assert.ok(terraLow?.rejectionReasons.some((reason) => reason.includes("completion estimate")));
  }
});

void test("diagnostic fallback routes cannot be promoted into execution policies", () => {
  const decision = new AutoRouter(testConfig()).decide({
    prompt: "Implement a production bounded concurrency feature with cancellation and retry semantics.",
    repo,
    catalog,
    quota: healthyQuota,
    verificationCapabilities: {
      availableTiers: ["basic"],
      commandCountByTier: { basic: 1, standard: 1, strong: 1, adversarial: 1 },
      taskSpecificCommandCountByTier: { basic: 0, standard: 0, strong: 0, adversarial: 0 },
      taskSpecificRequired: false,
      requiredCountByTier: { basic: 1, standard: 1, strong: 2, adversarial: 2 },
      estimatedCostWeightByTier: { basic: 0.2, standard: 0.55, strong: 1, adversarial: 1.8 },
      fingerprint: "basic-only",
    },
  });

  assert.equal(decision.selected.admissible, false);
  assert.equal(
    decision.selected.badEscapeEstimate,
    Math.min(...decision.candidates.map((candidate) => candidate.badEscapeEstimate)),
    "the diagnostic fallback must still choose the least-bad escape estimate",
  );
  assert.throws(
    () => requireAdmissibleRoute(decision),
    /no admissible execution route/u,
  );
  const summary = summarizeRoute(decision);
  assert.equal(summary["action"], "abstain");
  assert.equal(summary["admissible"], false);
  assert.deepEqual(summary["rejectionReasons"], decision.selected.rejectionReasons);
  assert.equal(
    (summary["selected"] as Record<string, unknown>)["completionEstimateSource"],
    "heuristic-prior",
  );
});

void test("high-risk authentication work receives the Sol floor", () => {
  const decision = new AutoRouter(testConfig()).decide({
    prompt: "Investigate an intermittent production OAuth authorization bypass and fix the root cause across services.",
    repo: { ...repo, sensitivePathHits: ["auth/session.ts", "oauth/token.ts"] },
    catalog,
    quota: healthyQuota,
  });
  assert.equal(decision.selected.modelFamily, "sol");
});

void test("repository-wide filesystem destruction is classified as critical and never routed to Luna", () => {
  for (const prompt of [
    "Delete all files recursively and overwrite the repository.",
    "Purge the entire repository with rm -rf.",
    "Xóa toàn bộ tệp trong kho mã nguồn theo cách đệ quy.",
    "Remove-Item -Recurse -Force *",
    "Remove-Item -Force *",
    "rd /s /q .",
    "del /s /q *",
    "git clean -f",
    "git clean -fdx",
  ]) {
    const decision = new AutoRouter(testConfig()).decide({ prompt, repo, catalog, quota: healthyQuota });
    assert.ok(decision.features.destructivePotential >= 0.72);
    assert.equal(decision.selected.modelFamily, "sol");
  }
});

void test("routine generated cleanup and source edits are not mislabeled repository destruction", () => {
  for (const prompt of [
    "Run rm -rf dist to remove generated build artifacts, then rebuild and test.",
    "Remove-Item -Force dist",
    "git clean -nd",
    "Remove trailing whitespace from all files and run tests.",
    "Remove a deprecated import from every file and run typecheck.",
  ]) {
    const decision = new AutoRouter(testConfig()).decide({ prompt, repo, catalog, quota: healthyQuota });
    assert.ok(decision.features.destructivePotential < 0.72, prompt);
  }
});

void test("Vietnamese security and production wording receives the same critical safety floor", () => {
  const decision = new AutoRouter(testConfig()).decide({
    prompt: "Khắc phục lỗ hổng vượt quyền xác thực trên hệ thống sản xuất và kiểm tra phân quyền.",
    repo,
    catalog,
    quota: healthyQuota,
  });
  assert.ok(decision.features.risk >= 0.72);
  assert.equal(decision.features.taskKind, "security");
  assert.equal(decision.selected.modelFamily, "sol");
});

void test("plain Vietnamese security wording matches the English risk and task kind", () => {
  const router = new AutoRouter(testConfig());
  const english = router.decide({ prompt: "Review security.", repo, catalog, quota: healthyQuota });
  const vietnamese = router.decide({ prompt: "Kiểm tra bảo mật.", repo, catalog, quota: healthyQuota });
  assert.equal(vietnamese.features.risk, english.features.risk);
  assert.equal(vietnamese.features.taskKind, "security");
  assert.equal(english.features.taskKind, "security");
});

void test("Vietnamese finance and migration wording receives English-equivalent risk", () => {
  const router = new AutoRouter(testConfig());
  const financeEnglish = router.decide({
    prompt: "Process the payment refund and billing workflow.",
    repo,
    catalog,
    quota: healthyQuota,
  });
  const financeVietnamese = router.decide({
    prompt: "Xử lý quy trình thanh toán, hoàn tiền và hóa đơn.",
    repo,
    catalog,
    quota: healthyQuota,
  });
  const migrationEnglish = router.decide({
    prompt: "Run the data migration and schema change.",
    repo,
    catalog,
    quota: healthyQuota,
  });
  const migrationVietnamese = router.decide({
    prompt: "Di chuyển dữ liệu và thay đổi lược đồ.",
    repo,
    catalog,
    quota: healthyQuota,
  });

  assert.equal(financeVietnamese.features.risk, financeEnglish.features.risk);
  assert.equal(migrationVietnamese.features.risk, migrationEnglish.features.risk);
  assert.equal(migrationVietnamese.features.taskKind, "migration");
});

void test("Vietnamese task verbs map to their matching task kinds", () => {
  for (const [prompt, taskKind] of [
    ["Đánh giá diff và xem xét cách triển khai hiện tại.", "review"],
    ["Nghiên cứu và so sánh phương án lưu trữ.", "research"],
    ["Tái cấu trúc module mà không đổi hành vi.", "refactor"],
    ["Sửa lỗi hồi quy khiến ứng dụng bị hỏng.", "bugfix"],
    ["Triển khai tính năng xuất báo cáo mới.", "feature"],
  ] as const) {
    const decision = new AutoRouter(testConfig()).decide({ prompt, repo, catalog, quota: healthyQuota });
    assert.equal(decision.features.taskKind, taskKind, prompt);
  }
});

void test("mixed Vietnamese and English repository-wide wording raises breadth", () => {
  const decision = new AutoRouter(testConfig()).decide({
    prompt: "Đọc toàn bộ source code và sửa toàn bộ các bug đang có.",
    repo,
    catalog,
    quota: healthyQuota,
  });

  assert.ok(decision.features.breadth >= 0.5);
  assert.equal(decision.features.taskKind, "bugfix");
});

void test("static Ultra effort carries Ultra topology metadata", () => {
  const config = testConfig({
    routing: {
      ...testConfig().routing,
      static: { family: "sol", effort: "ultra", speed: "standard" },
    },
  });
  const route = new AutoRouter(config).staticPolicy(catalog);
  assert.equal(route.effort, "ultra");
  assert.equal(route.topology, "ultra");
});

void test("Ultra is represented as topology and remains gated by default", () => {
  const decision = new AutoRouter(testConfig()).decide({
    prompt: "Audit the entire monorepo in parallel using independent workstreams for frontend, backend, database, CI, and security. Run tests for each.",
    repo: { ...repo, trackedFileCount: 20_000, packageCount: 20 },
    catalog,
    quota: healthyQuota,
  });
  const ultra = decision.candidates.find((candidate) => candidate.effort === "ultra");
  assert.ok(ultra);
  if (ultra === undefined) throw new Error("expected an Ultra candidate");
  assert.equal(ultra.topology, "ultra");
  assert.equal(ultra.admissible, false);
  assert.ok(ultra.rejectionReasons.some((reason) => reason.includes("disabled")));
});

function entry(id: string, isDefault: boolean, efforts: string[], supportsFast = false): Record<string, unknown> {
  return {
    id,
    model: id,
    displayName: id,
    description: id,
    hidden: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
    serviceTiers: supportsFast ? [{ id: "fast", name: "Fast", description: "1.5x latency tier" }] : [],
    defaultServiceTier: null,
    isDefault,
  };
}

void test("speed is routed independently and Fast wins only for a time-critical task", () => {
  const speedCatalog = parseModelCatalog({
    data: [
      entry("gpt-5.6-luna", false, ["low", "medium", "high", "max"]),
      entry("gpt-5.6-terra", false, ["low", "medium", "high", "xhigh", "max"], true),
      entry("gpt-5.6-sol", true, ["low", "medium", "high", "xhigh", "max", "ultra"], true),
    ],
  });
  const router = new AutoRouter(testConfig());
  const ordinary = router.decide({
    prompt: "Rename the typo in src/name.ts exactly as specified and run tests.",
    repo,
    catalog: speedCatalog,
    quota: healthyQuota,
  });
  const urgent = router.decide({
    prompt: "Urgent interactive task blocking me right now: rename the typo in src/name.ts exactly and run tests.",
    repo,
    catalog: speedCatalog,
    quota: healthyQuota,
    constraints: { deadlineMs: 72_000 },
  });

  assert.equal(ordinary.selected.speedId, "standard");
  assert.equal(ordinary.selected.serviceTier, null);
  assert.equal(urgent.selected.speedId, "fast");
  assert.equal(urgent.selected.serviceTier, "fast");
  const standardTwin = urgent.candidates.find((candidate) =>
    candidate.modelId === urgent.selected.modelId &&
    candidate.effort === urgent.selected.effort &&
    candidate.topology === urgent.selected.topology &&
    candidate.proofTier === urgent.selected.proofTier &&
    candidate.speedId === "standard"
  );
  assert.ok(standardTwin, "expected a same-capability Standard candidate");
  if (standardTwin === undefined) throw new Error("missing Standard speed twin");
  assert.equal(urgent.selected.capabilityScore, standardTwin.capabilityScore);
  assert.equal(urgent.selected.successEstimate, standardTwin.successEstimate);
  assert.equal(urgent.selected.detectionEstimate, standardTwin.detectionEstimate);
  assert.ok(urgent.selected.predictedDurationMs < standardTwin.predictedDurationMs);
  assert.ok(urgent.selected.predictedNormalizedCredits > standardTwin.predictedNormalizedCredits);
  assert.ok(urgent.selected.speedCostMultiplier > 1);
  assert.ok(urgent.selected.speedLatencyMultiplier < 1);
});

void test("product speed modes require structured premium permission and never change capability", () => {
  const speedCatalog = parseModelCatalog({
    data: [
      entry("gpt-5.6-luna", false, ["low", "medium", "high", "max"]),
      entry("gpt-5.6-terra", true, ["low", "medium", "high", "xhigh", "max"], true),
    ],
  });
  const router = new AutoRouter(testConfig());
  const prompt = "Urgent ASAP: rename the typo in src/name.ts exactly and run tests.";
  const off = router.decide({
    prompt,
    repo,
    catalog: speedCatalog,
    quota: healthyQuota,
    constraints: { speedMode: "off", executionContext: "foreground", latencyPriority: "urgent" },
  });
  const autoWithoutContext = router.decide({
    prompt,
    repo,
    catalog: speedCatalog,
    quota: healthyQuota,
    constraints: { speedMode: "auto" },
  });
  const auto = router.decide({
    prompt,
    repo,
    catalog: speedCatalog,
    quota: healthyQuota,
    constraints: {
      speedMode: "auto",
      executionContext: "foreground",
      latencyPriority: "urgent",
      deadlineMs: 80_000,
    },
  });
  const fast = router.decide({
    prompt,
    repo,
    catalog: speedCatalog,
    quota: healthyQuota,
    constraints: { speedMode: "fast", executionContext: "foreground" },
  });

  assert.equal(off.selected.speedId, "standard");
  assert.equal(autoWithoutContext.selected.speedId, "standard");
  const rejectedAutoFast = autoWithoutContext.candidates.find((candidate) => candidate.speedId === "fast");
  assert.ok(rejectedAutoFast?.rejectionReasons.some((reason) => reason.includes("foreground execution context")));
  assert.equal(auto.selected.speedId, "fast");
  assert.equal(fast.selected.speedId, "fast");
  const autoStandard = auto.candidates.find((candidate) =>
    candidate.modelId === auto.selected.modelId &&
    candidate.effort === auto.selected.effort &&
    candidate.topology === auto.selected.topology &&
    candidate.proofTier === auto.selected.proofTier &&
    candidate.speedId === "standard"
  );
  assert.ok(autoStandard);
  assert.equal(auto.selected.capabilityScore, autoStandard?.capabilityScore);
  assert.equal(auto.selected.successEstimate, autoStandard?.successEstimate);
});

void test("product Fast fails closed when no advertised premium tier exists", () => {
  assert.throws(
    () => new AutoRouter(testConfig()).decide({
      prompt: "Rename the typo and run tests.",
      repo,
      catalog,
      quota: healthyQuota,
      constraints: { speedMode: "fast", executionContext: "foreground" },
    }),
    /No Codex route matches the requested constraints/u,
  );
});

void test("premium speed is quota-gated even when latency is urgent", () => {
  const speedCatalog = parseModelCatalog({
    data: [
      entry("gpt-5.6-luna", false, ["low", "medium", "high", "max"]),
      entry("gpt-5.6-terra", false, ["low", "medium", "high", "xhigh", "max"], true),
      entry("gpt-5.6-sol", true, ["low", "medium", "high", "xhigh", "max", "ultra"], true),
    ],
  });
  const decision = new AutoRouter(testConfig()).decide({
    prompt: "Urgent interactive task blocking me right now with a deadline: rename the typo in src/name.ts exactly and run tests.",
    repo,
    catalog: speedCatalog,
    quota: { ...healthyQuota, usedPercent: 45, remainingPercent: 55, pressure: 0.45, healthy: true },
  });
  assert.equal(decision.selected.speedId, "standard");
  const fast = decision.candidates.find((candidate) => candidate.speedId === "fast");
  assert.ok(fast);
  assert.ok(fast?.rejectionReasons.some((reason) => reason.includes("premium-speed")));
});

void test("unavailable quota blocks premium, Max, and Ultra but keeps a Standard single route", () => {
  const speedCatalog = parseModelCatalog({
    data: [
      entry("gpt-5.6-luna", false, ["low", "medium", "high", "max"]),
      entry("gpt-5.6-terra", false, ["low", "medium", "high", "xhigh", "max"], true),
      entry("gpt-5.6-sol", true, ["low", "medium", "high", "xhigh", "max", "ultra"], true),
    ],
  });
  const config = testConfig({
    routing: { ...testConfig().routing, enableMax: true, enableUltra: true },
  });
  const unknownQuota: QuotaState = {
    known: false,
    exhausted: false,
    rateLimitReachedType: null,
    usedPercent: null,
    remainingPercent: null,
    resetAt: null,
    minutesUntilReset: null,
    pressure: 1,
    healthy: false,
    sourceLimitId: null,
  };
  const decision = new AutoRouter(config).decide({
    prompt: "Urgent: audit the repository with tests, but preserve quota if its live state is unavailable.",
    repo: { ...repo, trackedFileCount: 20_000, packageCount: 20 },
    catalog: speedCatalog,
    quota: unknownQuota,
  });

  assert.equal(decision.selected.admissible, true);
  assert.equal(decision.selected.speedId, "standard");
  assert.equal(decision.selected.topology, "single");
  assert.notEqual(decision.selected.effort, "max");
  for (const candidate of decision.candidates.filter((candidate) =>
    candidate.speedId === "fast" || candidate.effort === "max" || candidate.topology === "ultra"
  )) {
    assert.equal(candidate.admissible, false);
    assert.ok(candidate.rejectionReasons.some((reason) => reason.includes("quota usage is unavailable")));
  }
});

void test("a known exhausted quota window blocks even a Standard single lane", () => {
  const exhausted: QuotaState = {
    known: true,
    exhausted: true,
    rateLimitReachedType: "rate_limit_reached",
    usedPercent: 100,
    remainingPercent: 0,
    resetAt: new Date(Date.now() + 3_600_000).toISOString(),
    minutesUntilReset: 60,
    pressure: 1,
    healthy: false,
    sourceLimitId: "codex",
  };
  const decision = new AutoRouter(testConfig()).decide({
    prompt: "Fix the typo and run the existing test.",
    repo,
    catalog,
    quota: exhausted,
  });
  assert.equal(decision.selected.admissible, false);
  assert.ok(decision.candidates.every((candidate) =>
    candidate.rejectionReasons.some((reason) => reason.includes("quota window codex is exhausted"))
  ));
  assert.throws(() => requireAdmissibleRoute(decision), /quota window codex is exhausted/u);
});

void test("incomplete or internally inconsistent quota objects cannot bypass expensive-route gates", () => {
  const speedCatalog = parseModelCatalog({
    data: [
      entry("gpt-5.6-luna", false, ["low", "medium", "high", "max"]),
      entry("gpt-5.6-terra", false, ["low", "medium", "high", "xhigh", "max"], true),
      entry("gpt-5.6-sol", true, ["low", "medium", "high", "xhigh", "max", "ultra"], true),
    ],
  });
  const incomplete: QuotaState = {
    ...healthyQuota,
    known: true,
    usedPercent: null,
    remainingPercent: null,
  };
  const degraded = new AutoRouter(testConfig({
    routing: { ...testConfig().routing, enableMax: true, enableUltra: true },
  })).decide({
    prompt: "Urgent repository-wide audit with parallel verification.",
    repo: { ...repo, trackedFileCount: 20_000, packageCount: 20 },
    catalog: speedCatalog,
    quota: incomplete,
  });
  assert.equal(degraded.selected.admissible, true);
  assert.equal(degraded.selected.speedId, "standard");
  assert.equal(degraded.selected.topology, "single");
  assert.notEqual(degraded.selected.effort, "max");

  const inconsistentExhausted = { ...incomplete, known: false, exhausted: true };
  const blocked = new AutoRouter(testConfig()).decide({
    prompt: "Fix the typo and run tests.",
    repo,
    catalog,
    quota: inconsistentExhausted,
  });
  assert.equal(blocked.selected.admissible, false);
  assert.ok(blocked.candidates.every((candidate) =>
    candidate.rejectionReasons.some((reason) => reason.includes("is exhausted"))
  ));
});

void test("an explicitly pinned advertised model remains routable when its family is unknown", () => {
  const futureCatalog = parseModelCatalog({
    data: [
      entry("gpt-5.6-terra", true, ["low", "medium", "high"]),
      entry("gpt-6-nova", false, ["low", "medium", "high"]),
    ],
  });
  const decision = new AutoRouter(testConfig()).decide({
    prompt: "Apply the exact deterministic edit and run tests.",
    repo,
    catalog: futureCatalog,
    quota: healthyQuota,
    constraints: { modelId: "gpt-6-nova" },
  });
  assert.equal(decision.selected.modelId, "gpt-6-nova");
  assert.equal(decision.selected.modelFamily, "unknown");
});

void test("an explicit speed pin is a first-class route constraint", () => {
  const speedCatalog = parseModelCatalog({
    data: [
      entry("gpt-5.6-luna", false, ["low", "medium", "high", "max"]),
      entry("gpt-5.6-terra", false, ["low", "medium", "high", "xhigh", "max"], true),
      entry("gpt-5.6-sol", true, ["low", "medium", "high", "xhigh", "max", "ultra"], true),
    ],
  });
  const decision = new AutoRouter(testConfig()).decide({
    prompt: "Rename the typo in src/name.ts exactly as specified and run tests.",
    repo,
    catalog: speedCatalog,
    quota: healthyQuota,
    constraints: { speedId: "fast" },
  });
  assert.equal(decision.selected.speedId, "fast");
  assert.equal(decision.selected.serviceTier, "fast");
  assert.equal(decision.constraints.speedId, "fast");
});

void test("latency priority is a soft speed signal rather than a capability upgrade", () => {
  const speedCatalog = parseModelCatalog({
    data: [
      entry("gpt-5.6-luna", false, ["low", "medium", "high", "max"]),
      entry("gpt-5.6-terra", false, ["low", "medium", "high", "xhigh", "max"], true),
      entry("gpt-5.6-sol", true, ["low", "medium", "high", "xhigh", "max", "ultra"], true),
    ],
  });
  const economicalFastConfig = testConfig({
    routing: {
      ...testConfig().routing,
      speed: {
        ...testConfig().routing.speed,
        profiles: {
          ...testConfig().routing.speed.profiles,
          fast: {
            costMultiplier: 1.1,
            latencyMultiplier: 2 / 3,
            premium: true,
          },
        },
      },
    },
  });
  const router = new AutoRouter(economicalFastConfig);
  const normal = router.decide({
    prompt: "Rename the typo in src/name.ts exactly as specified and run tests.",
    repo,
    catalog: speedCatalog,
    quota: healthyQuota,
  });
  const urgent = router.decide({
    prompt: "Rename the typo in src/name.ts exactly as specified and run tests.",
    repo,
    catalog: speedCatalog,
    quota: healthyQuota,
    constraints: { latencyPriority: "urgent" },
  });
  const normalStandard = normal.candidates.find((candidate) =>
    candidate.modelFamily === "terra" && candidate.effort === "low" &&
    candidate.proofTier === "basic" && candidate.speedId === "standard"
  );
  const normalFast = normal.candidates.find((candidate) =>
    candidate.modelFamily === "terra" && candidate.effort === "low" &&
    candidate.proofTier === "basic" && candidate.speedId === "fast"
  );
  const urgentStandard = urgent.candidates.find((candidate) =>
    candidate.modelFamily === "terra" && candidate.effort === "low" &&
    candidate.proofTier === "basic" && candidate.speedId === "standard"
  );
  const urgentFast = urgent.candidates.find((candidate) =>
    candidate.modelFamily === "terra" && candidate.effort === "low" &&
    candidate.proofTier === "basic" && candidate.speedId === "fast"
  );
  assert.ok(normalStandard && normalFast && urgentStandard && urgentFast);
  if (normalStandard === undefined || normalFast === undefined || urgentStandard === undefined || urgentFast === undefined) {
    throw new Error("expected same-capability speed pairs");
  }
  assert.equal(urgentFast.capabilityScore, urgentStandard.capabilityScore);
  assert.equal(urgentFast.successEstimate, urgentStandard.successEstimate);
  assert.ok(urgentFast.predictedDurationMs < urgentStandard.predictedDurationMs);
  assert.ok(normalFast.objective > normalStandard.objective, "ordinary work should prefer Standard economics");
  assert.ok(urgentFast.objective < urgentStandard.objective, "urgent work should value the same route's Fast latency");
  assert.equal(normal.selected.speedId, "standard");
});

void test("unsupported explicit speed tiers fail closed", () => {
  assert.throws(
    () => new AutoRouter(testConfig()).decide({
      prompt: "Rename a typo and run tests.",
      repo,
      catalog,
      quota: healthyQuota,
      constraints: { speedId: "warp-9" },
    }),
    /No Codex route matches the requested constraints/u,
  );
});

void test("hard constraints cannot bypass the risk floor", () => {
  assert.throws(
    () => new AutoRouter(testConfig()).decide({
      prompt: "Fix a production OAuth authorization bypass and verify permissions.",
      repo: { ...repo, sensitivePathHits: ["auth/session.ts"] },
      catalog,
      quota: healthyQuota,
      constraints: { modelFamily: "luna" },
    }),
    /do not satisfy Counterlane safety and quota gates/u,
  );
});

void test("speed economics can be overridden by model", () => {
  const speedCatalog = parseModelCatalog({
    data: [entry("gpt-5.4-terra", true, ["low", "medium", "high"], true)],
  });
  const decision = new AutoRouter(testConfig()).decide({
    prompt: "Urgent interactive task blocking me right now: rename the typo and run tests.",
    repo,
    catalog: speedCatalog,
    quota: healthyQuota,
    constraints: { speedId: "fast" },
  });
  assert.equal(decision.selected.speedId, "fast");
  assert.equal(decision.selected.speedCostMultiplier, 2);
});

void test("an explicit advertised effort can be pinned outside the default candidate list", () => {
  const config = testConfig({
    routing: {
      ...testConfig().routing,
      candidateEfforts: ["medium", "high"],
    },
  });
  const decision = new AutoRouter(config).decide({
    prompt: "Apply the exact deterministic edit and verify it.",
    repo,
    catalog,
    quota: healthyQuota,
    constraints: { modelFamily: "terra", effort: "xhigh" },
  });
  assert.equal(decision.selected.effort, "xhigh");
});


void test("proof burden is independently routable and critical work cannot pin weak proof", () => {
  const router = new AutoRouter(testConfig());
  assert.throws(
    () => router.decide({
      prompt: "Fix a production OAuth privilege escalation and verify every permission boundary.",
      repo: { ...repo, sensitivePathHits: ["auth/permissions.ts"] },
      catalog,
      quota: healthyQuota,
      constraints: { proofTier: "basic" },
    }),
    /proof tier strong|safety and quota gates/u,
  );

  const decision = router.decide({
    prompt: "Rename a private helper exactly and run the existing typecheck.",
    repo,
    catalog,
    quota: healthyQuota,
    constraints: { proofTier: "basic" },
  });
  assert.equal(decision.selected.proofTier, "basic");
});

void test("repository verification capabilities fail closed instead of inventing strong proof", () => {
  const router = new AutoRouter(testConfig());
  assert.throws(
    () => router.decide({
      prompt: "Fix a production OAuth privilege escalation and verify permissions.",
      repo: { ...repo, sensitivePathHits: ["auth/permissions.ts"] },
      catalog,
      quota: healthyQuota,
      verificationCapabilities: {
        availableTiers: ["basic", "standard"],
        commandCountByTier: { basic: 1, standard: 1, strong: 1, adversarial: 1 },
        taskSpecificCommandCountByTier: { basic: 0, standard: 0, strong: 0, adversarial: 0 },
        taskSpecificRequired: false,
        requiredCountByTier: { basic: 1, standard: 1, strong: 2, adversarial: 2 },
        estimatedCostWeightByTier: { basic: 0.2, standard: 0.55, strong: 1, adversarial: 1.8 },
        fingerprint: "weak",
      },
    }),
    /proof tier strong|unavailable/u,
  );
});

void test("hard deadlines and credit ceilings constrain the complete route", () => {
  const speedCatalog = parseModelCatalog({
    data: [entry("gpt-5.6-terra", true, ["low", "medium", "high"], true)],
  });
  const router = new AutoRouter(testConfig());
  const fast = router.decide({
    prompt: "Urgent: rename the typo in src/name.ts exactly as specified and run the existing tests and typecheck.",
    repo,
    catalog: speedCatalog,
    quota: healthyQuota,
    constraints: { deadlineMs: 80_000 },
  });
  assert.equal(fast.selected.speedId, "fast");
  assert.ok(fast.selected.predictedP90DurationMs <= 80_000);

  assert.throws(
    () => router.decide({
      prompt: "Urgent: rename the typo in src/name.ts exactly as specified and run the existing tests and typecheck.",
      repo,
      catalog: speedCatalog,
      quota: healthyQuota,
      constraints: { maxNormalizedCredits: 0.01 },
    }),
    /predicted credits|safety and quota gates/u,
  );
});

void test("invalid direct-library route constraints fail instead of being silently discarded", () => {
  const router = new AutoRouter(testConfig());
  for (const constraints of [
    { deadlineMs: Number.NaN },
    { deadlineMs: 0 },
    { deadlineMs: 1.5 },
    { deadlineMs: 2_147_483_648 },
    { maxNormalizedCredits: Number.POSITIVE_INFINITY },
    { modelId: "   " },
    { topology: "parallel" },
  ] as Array<Record<string, unknown>>) {
    assert.throws(
      () => router.decide({
        prompt: "Fix the typo and run tests.",
        repo,
        catalog,
        quota: healthyQuota,
        constraints: constraints as never,
      }),
      /Route constraint/u,
    );
  }
});
