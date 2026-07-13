import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseModelCatalog } from "../../src/codex/catalog.js";
import type {
  MetaContext,
  PairedUpliftObservation,
  QuotaState,
  RepoProfile,
} from "../../src/core/types.js";
import { MetaController } from "../../src/meta/controller.js";
import { buildMetaContext } from "../../src/meta/context.js";
import { classifyRisk } from "../../src/meta/context.js";
import { AutoRouter, estimateRouteCostWeight } from "../../src/routing/router.js";
import { testConfig } from "../helpers.js";

const catalog = parseModelCatalog({
  data: [
    model("gpt-5.6-luna", false, ["low", "medium", "high", "max"]),
    model("gpt-5.6-terra", false, ["low", "medium", "high", "xhigh", "max"]),
    model("gpt-5.6-sol", true, ["low", "medium", "high", "xhigh", "max", "ultra"]),
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
  verifierHints: ["npm test", "typecheck"],
  profileHash: "hash",
};
const quota: QuotaState = {
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

void test("meta-controller buys a counterfactual twin when uplift is unknown and information is valuable", () => {
  const setup = setupDecision();
  const decision = new MetaController(setup.config).decide({ ...setup.input, observations: [] });
  assert.equal(decision.action, "twin");
  assert.ok(decision.expectedInformationValue > decision.estimatedTwinCost);
});

void test("meta-controller fails closed to one static lane when live quota is unavailable", () => {
  const setup = setupDecision();
  const decision = new MetaController(setup.config).decide({
    ...setup.input,
    quota: {
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
    },
    observations: [],
  });
  assert.equal(decision.action, "static");
  assert.ok(decision.reasons.some((reason) => reason.includes("quota is unavailable")));
});

void test("meta-controller deploys Auto only after positive lower-bound evidence", () => {
  const setup = setupDecision();
  const observations = repeatedObservations(setup.context, 8, 24);
  const decision = new MetaController(setup.config).decide({ ...setup.input, observations });
  assert.equal(decision.action, "auto");
  assert.ok(decision.posterior.lowerBound > setup.config.meta.upliftMargin);
});

void test("meta-controller retains static when the Auto upper bound is negative", () => {
  const setup = setupDecision();
  const observations = repeatedObservations(setup.context, 8, -24);
  const decision = new MetaController(setup.config).decide({ ...setup.input, observations });
  assert.equal(decision.action, "static");
  assert.ok(decision.posterior.upperBound < -setup.config.meta.upliftMargin);
});

void test("an inadmissible static incumbent falls back to an admissible single Auto route even under quota pressure", () => {
  const setup = setupDecision();
  const decision = new MetaController(setup.config).decide({
    ...setup.input,
    staticAdmissible: false,
    quota: { ...quota, usedPercent: 95, remainingPercent: 5, pressure: 0.95, healthy: false },
    observations: [],
  });
  assert.equal(decision.action, "auto");
  assert.ok(decision.reasons.some((reason) => reason.includes("static route fails")));
});

void test("sample-cap exhaustion cannot deploy Auto without a decisive lower bound", () => {
  const setup = setupDecision();
  const observations = repeatedObservations(
    setup.context,
    setup.config.meta.maximumTwinSamplesPerContext,
    1,
  );
  const decision = new MetaController(setup.config).decide({ ...setup.input, observations });
  assert.ok(decision.posterior.mean > setup.config.meta.upliftMargin);
  assert.ok(decision.posterior.lowerBound <= setup.config.meta.upliftMargin);
  assert.equal(decision.action, "static");
  assert.ok(decision.reasons.some((reason) => reason.includes("sample cap")));
});

void test("critical tasks with weak verification force abstention", () => {
  const setup = setupDecision();
  const context: MetaContext = {
    ...setup.context,
    key: `security|risk:critical|verify:weak|scope:medium|route:${setup.context.routeSignature}`,
    fallbackKeys: [
      `security|risk:critical|verify:weak|scope:medium|route:${setup.context.routeSignature}`,
      "*|risk:*|verify:*|scope:*|route:*",
    ],
    taskKind: "security",
    riskTier: "critical",
    verifierTier: "weak",
    verifierStrength: 0.2,
  };
  const decision = new MetaController(setup.config).decide({
    ...setup.input,
    context,
    staticModelId: setup.input.route.selected.modelId,
    staticEffort: setup.input.route.selected.effort,
    staticSpeedId: setup.input.route.selected.speedId,
    staticTopology: setup.input.route.selected.topology,
    observations: [],
  });
  assert.equal(decision.action, "abstain");
});

void test("meta-controller abstains when the inner Auto route is inadmissible", () => {
  const setup = setupDecision();
  const route = {
    ...setup.input.route,
    selected: {
      ...setup.input.route.selected,
      admissible: false,
      rejectionReasons: ["proof tier standard is unavailable in this repository"],
    },
  };
  const decision = new MetaController(setup.config).decide({
    ...setup.input,
    route,
    observations: repeatedObservations(setup.context, 8, 24),
  });

  assert.equal(decision.action, "abstain");
  assert.ok(decision.reasons.some((reason) => reason.includes("no admissible execution route")));
});

void test("meta-controller treats a speed-only route change as a real intervention", () => {
  const setup = setupDecision();
  const router = new AutoRouter(setup.config);
  const staticRoute = router.staticPolicy(catalog);
  const route = {
    ...setup.input.route,
    selected: {
      ...setup.input.route.selected,
      modelId: staticRoute.model.id,
      modelFamily: staticRoute.family,
      effort: staticRoute.effort,
      serviceTier: "fast",
      speedId: "fast",
      speedName: "Fast",
      speedCostMultiplier: 2.5,
      speedLatencyMultiplier: 2 / 3,
      topology: "single" as const,
    },
  };
  const decision = new MetaController(setup.config).decide({
    context: setup.context,
    route,
    staticModelId: staticRoute.model.id,
    staticEffort: staticRoute.effort,
    staticSpeedId: "standard",
    staticTopology: "single",
    staticCostWeight: estimateRouteCostWeight(setup.config, staticRoute.family, staticRoute.effort),
    staticAdmissible: true,
    observations: [],
    quota,
  });
  assert.equal(decision.routeEquivalentToStatic, false);
});

void test("meta risk tiers use the same elevated depth boundary as routing", () => {
  const setup = setupDecision();
  assert.equal(classifyRisk({
    ...setup.input.route.features,
    risk: 0.05,
    destructivePotential: 0,
    depth: 0.72,
  }), "elevated");
});

function setupDecision(): {
  config: ReturnType<typeof testConfig>;
  context: MetaContext;
  input: Omit<Parameters<MetaController["decide"]>[0], "observations">;
} {
  const config = testConfig();
  const router = new AutoRouter(config);
  const route = router.decide({
    prompt: "Rename the exact typo in src/name.ts and run tests and typecheck.",
    repo,
    catalog,
    quota,
  });
  const staticRoute = router.staticPolicy(catalog);
  const context = buildMetaContext(route.features, repo, 0.78);
  return {
    config,
    context,
    input: {
      context,
      route,
      staticModelId: staticRoute.model.id,
      staticEffort: staticRoute.effort,
      staticSpeedId: staticRoute.speedId,
      staticTopology: "single",
      staticCostWeight: estimateRouteCostWeight(config, staticRoute.family, staticRoute.effort),
      staticAdmissible: true,
      quota,
    },
  };
}

function repeatedObservations(context: MetaContext, count: number, utilityDelta: number): PairedUpliftObservation[] {
  return Array.from({ length: count }, (_, index) => ({
    experimentId: `exp-${index}`,
    timestamp: new Date(index * 1000).toISOString(),
    contextKeys: context.fallbackKeys,
    utilityDelta,
    verifiedSuccessDelta: utilityDelta > 0 ? 1 : utilityDelta < 0 ? -1 : 0,
    controlSuccessful: utilityDelta <= 0,
    treatmentSuccessful: utilityDelta >= 0,
  }));
}

function model(id: string, isDefault: boolean, efforts: string[]): Record<string, unknown> {
  return {
    id,
    model: id,
    displayName: id,
    description: id,
    hidden: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
    isDefault,
  };
}
