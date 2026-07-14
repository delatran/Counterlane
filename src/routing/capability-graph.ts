import type {
  CapabilityGraph,
  CapabilityGraphEdge,
  ModelFamily,
  RouteCandidate,
  TaskFeatures,
} from "../core/types.js";

const EFFORT_ORDER = ["none", "minimal", "low", "light", "medium", "high", "xhigh", "max", "ultra"] as const;
const FAMILY_SUCCESSOR: Partial<Record<ModelFamily, ModelFamily>> = {
  luna: "terra",
  terra: "sol",
};

interface CapabilityNode {
  key: string;
  modelId: string;
  modelFamily: ModelFamily;
  effort: string;
  topology: RouteCandidate["topology"];
}

/** Model, effort, and topology are the only capability dimensions. */
export function capabilityNodeKey(
  candidate: Pick<RouteCandidate, "modelId" | "effort" | "topology">,
): string {
  return [candidate.modelId, candidate.effort, candidate.topology].join("\0");
}

/**
 * Build explicit, deterministic successor edges for admissible routes. Scores,
 * speed tiers, proof tiers, prices, and latency never create capability edges.
 */
export function buildCapabilityGraph(
  candidates: readonly RouteCandidate[],
  features: TaskFeatures,
): CapabilityGraph {
  const byKey = new Map<string, CapabilityNode>();
  for (const candidate of candidates) {
    if (!candidate.admissible) continue;
    const key = capabilityNodeKey(candidate);
    byKey.set(key, {
      key,
      modelId: candidate.modelId,
      modelFamily: candidate.modelFamily,
      effort: candidate.effort,
      topology: candidate.topology,
    });
  }
  const nodes = [...byKey.values()].sort(compareNode);
  const edges = new Map<string, CapabilityGraphEdge>();

  addHigherEffortEdges(nodes, edges);
  addTaskApplicableFamilyEdges(nodes, features, edges);
  addTaskApplicableTopologyEdges(nodes, features, edges);

  return {
    schemaVersion: 1,
    nodes: nodes.map((node) => node.key),
    edges: [...edges.values()].sort(compareEdge),
  };
}

function addHigherEffortEdges(
  nodes: readonly CapabilityNode[],
  edges: Map<string, CapabilityGraphEdge>,
): void {
  const groups = new Map<string, CapabilityNode[]>();
  for (const node of nodes) {
    const key = `${node.modelId}\0${node.topology}`;
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const ordered = group
      .filter((node) => effortRank(node.effort) !== undefined)
      .slice()
      .sort((left, right) => effortRank(left.effort)! - effortRank(right.effort)! || compareNode(left, right));
    for (let index = 0; index + 1 < ordered.length; index += 1) {
      const from = ordered[index]!;
      const to = ordered[index + 1]!;
      if (effortRank(to.effort)! > effortRank(from.effort)!) addEdge(edges, from, to, "higher-effort");
    }
  }
}

function addTaskApplicableFamilyEdges(
  nodes: readonly CapabilityNode[],
  features: TaskFeatures,
  edges: Map<string, CapabilityGraphEdge>,
): void {
  for (const from of nodes) {
    const successorFamily = FAMILY_SUCCESSOR[from.modelFamily];
    const fromRank = effortRank(from.effort);
    if (successorFamily === undefined || fromRank === undefined || !familyEscalationApplicable(from.modelFamily, features)) continue;
    const targets = nodes.filter((candidate) =>
      candidate.modelFamily === successorFamily &&
      candidate.topology === from.topology &&
      effortRank(candidate.effort) !== undefined &&
      effortRank(candidate.effort)! >= fromRank
    );
    if (targets.length === 0) continue;
    const minimumRank = Math.min(...targets.map((target) => effortRank(target.effort)!));
    for (const target of targets.filter((candidate) => effortRank(candidate.effort) === minimumRank)) {
      addEdge(edges, from, target, "task-applicable-family");
    }
  }
}

function addTaskApplicableTopologyEdges(
  nodes: readonly CapabilityNode[],
  features: TaskFeatures,
  edges: Map<string, CapabilityGraphEdge>,
): void {
  if (features.parallelizability < 0.62 || features.breadth < 0.48) return;
  for (const from of nodes.filter((node) => node.topology === "single")) {
    const fromRank = effortRank(from.effort);
    if (fromRank === undefined) continue;
    const targets = nodes.filter((candidate) =>
      candidate.modelId === from.modelId &&
      candidate.topology === "ultra" &&
      effortRank(candidate.effort) !== undefined &&
      effortRank(candidate.effort)! >= fromRank
    );
    if (targets.length === 0) continue;
    const minimumRank = Math.min(...targets.map((target) => effortRank(target.effort)!));
    for (const target of targets.filter((candidate) => effortRank(candidate.effort) === minimumRank)) {
      addEdge(edges, from, target, "task-applicable-topology");
    }
  }
}

function familyEscalationApplicable(family: ModelFamily, features: TaskFeatures): boolean {
  if (family === "luna") {
    return features.depth >= 0.32 || features.risk >= 0.3 || features.novelty >= 0.38 || features.breadth >= 0.42;
  }
  if (family === "terra") {
    return features.depth >= 0.55 || features.risk >= 0.5 || features.novelty >= 0.58 ||
      (features.depth >= 0.38 && features.breadth >= 0.5);
  }
  return false;
}

function addEdge(
  edges: Map<string, CapabilityGraphEdge>,
  from: CapabilityNode,
  to: CapabilityNode,
  reason: CapabilityGraphEdge["reason"],
): void {
  if (from.key === to.key) return;
  const edge = { from: from.key, to: to.key, reason };
  edges.set(`${edge.from}\0${edge.to}\0${edge.reason}`, edge);
}

function effortRank(effort: string): number | undefined {
  const rank = EFFORT_ORDER.indexOf(effort as (typeof EFFORT_ORDER)[number]);
  return rank === -1 ? undefined : rank;
}

function compareNode(left: CapabilityNode, right: CapabilityNode): number {
  return compareStable(left.key, right.key);
}

function compareEdge(left: CapabilityGraphEdge, right: CapabilityGraphEdge): number {
  return compareStable(`${left.from}\0${left.to}\0${left.reason}`, `${right.from}\0${right.to}\0${right.reason}`);
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
