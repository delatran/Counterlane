import type { RepoProfile, TaskFeatures } from "../core/types.js";
import { clamp, unique } from "../core/utils.js";

interface SignalGroup {
  patterns: RegExp[];
  weight: number;
  label: string;
}

const VIETNAMESE_FINANCIAL_RISK = /(?:^|[^\p{L}\p{N}_])(?:thanh toán|hoàn tiền|hóa đơn|hoá đơn|tài chính|ví điện tử|ví tiền|tiền tệ)(?![\p{L}\p{N}_])/iu;
const VIETNAMESE_MIGRATION_RISK = /(?:^|[^\p{L}\p{N}_])(?:di chuyển dữ liệu|di trú dữ liệu|thay đổi lược đồ|nâng cấp cơ sở dữ liệu|điền bù dữ liệu|xóa bảng|xoá bảng|cắt ngắn bảng|lược đồ)(?![\p{L}\p{N}_])/iu;
const VIETNAMESE_SECURITY_RISK = /(?:xác thực|phân quyền|uỷ quyền|ủy quyền|vượt quyền|đặc quyền|lỗ hổng|bảo mật|mật mã|mô hình đe dọa)/iu;
const PRODUCTION_OPERATIONAL_RISK = /\b(?:production\b(?![- ]quality\b)(?!\s+(?:\w+\s+){0,2}(?:code|implementation)\b)|incident|outage|hotfix|data loss|destructive)\b/iu;
const DESTRUCTIVE_ACTION_WITH_TARGET = /\b(?:delete|erase|purge|wipe|drop|truncate|overwrite)\w*\b(?=[^\r\n]{0,64}\b(?:data|files?|folders?|directories|tables?|records?|repository|repo|workspace|secrets?)\b)/iu;

const GROUPS = {
  mechanical: [
    { patterns: [/\b(rename|format|reformat|lint|typo|boilerplate|scaffold|convert|translate)\b/iu], weight: 0.32, label: "mechanical wording" },
    { patterns: [/\b(exactly|specific file|single function|one line|replace all)\b/iu], weight: 0.2, label: "explicit narrow scope" },
  ],
  risk: [
    { patterns: [/\b(auth|authentication|authorization|oauth|sso|permission|privilege|security|vulnerability|cryptograph)\w*\b/iu], weight: 0.38, label: "security-sensitive domain" },
    { patterns: [VIETNAMESE_SECURITY_RISK], weight: 0.38, label: "security-sensitive domain (Vietnamese)" },
    { patterns: [/\b(payment|billing|checkout|ledger|wallet|money|financial)\w*\b/iu], weight: 0.38, label: "financial domain" },
    { patterns: [VIETNAMESE_FINANCIAL_RISK], weight: 0.38, label: "financial domain (Vietnamese)" },
    { patterns: [PRODUCTION_OPERATIONAL_RISK], weight: 0.35, label: "production impact" },
    { patterns: [/(sản xuất|sự cố|gián đoạn|mất dữ liệu|phá huỷ|phá hủy)/iu], weight: 0.35, label: "production impact (Vietnamese)" },
    { patterns: [/\b(migration|schema change|backfill|drop table|delete data|truncate)\b/iu], weight: 0.34, label: "migration or destructive data change" },
    { patterns: [VIETNAMESE_MIGRATION_RISK], weight: 0.34, label: "migration or destructive data change (Vietnamese)" },
    {
      patterns: [
        /\brm\s+-rf(?:\s+--)?\s+(?:\/(?:\s|$)|\.(?:\s|$)|\.\.\/|\.\/\*|\*(?:\s|$)|~(?:\/|\s|$)|repo(?:sitory)?\b|workspace\b|root\b)/iu,
        /\bremove-item\b(?=[^\r\n]*-force\b)[^\r\n]*(?:\*|\.(?:\s|$)|repo(?:sitory)?\b|workspace\b|root\b)/iu,
        /\b(?:rd|rmdir|del)\s+(?=[^\r\n]*(?:\/s|\/q))[^\r\n]*(?:\*|\.(?:\s|$)|repo(?:sitory)?\b|workspace\b)/iu,
        /\bgit\s+clean\b(?![^\r\n]*(?:--dry-run\b|-[a-z]*n[a-z]*\b))(?=[^\r\n]*(?:--force\b|-[a-z]*f[a-z]*\b))/iu,
        /\b(delete|erase|purge|wipe|overwrite)\w*\s+(?:all|every|the\s+entire|the\s+whole|entire|whole)\s+(?:repository|repo|workspace|directories|folders?|files?)\b/iu,
        /\bremove\s+(?:all|every)\s+(?:directories|folders?|files?)\b/iu,
        /(xóa|xoá)\s+(?:sạch\s+)?(?:toàn bộ|tất cả|mọi)\s+(?:tệp|file|thư mục|kho mã nguồn|repository|repo)/iu,
        /(xóa sạch|xoá sạch)\s+(?:kho mã nguồn|repository|repo|thư mục)/iu,
      ],
      weight: 0.55,
      label: "repository-wide filesystem destruction",
    },
  ],
  ambiguity: [
    { patterns: [/\b(find (the )?root cause|investigate|figure out|best approach|design|architect|trade-?off|why does)\b/iu], weight: 0.28, label: "open-ended investigation" },
    {
      patterns: [/\b(?:somehow|maybe|not sure|intermittent|flaky|random|unknown (?:cause|behavior|behaviour|issue|problem|failure|technology|system))\b/iu],
      weight: 0.22,
      label: "uncertain symptom",
    },
  ],
  breadth: [
    { patterns: [/\b(entire|whole|all packages|monorepo|cross-service|multiple services|repository-wide|end-to-end)\b/iu], weight: 0.38, label: "repository-wide scope" },
    { patterns: [/(toàn bộ|tất cả)\s+(?:source code|mã nguồn|kho mã nguồn|repo|repository|gói|tệp)|xuyên dịch vụ/iu], weight: 0.38, label: "repository-wide scope (Vietnamese)" },
    { patterns: [/\b(refactor|migration|redesign|rewrite|audit)\b/iu], weight: 0.22, label: "broad change verb" },
  ],
  depth: [
    { patterns: [/\b(concurrency|race condition|deadlock|distributed|consistency|transaction|state machine|compiler|formal proof)\b/iu], weight: 0.42, label: "deep reasoning domain" },
    { patterns: [/\b(edge cases?|invariant|root cause|multi-step|complex)\b/iu], weight: 0.24, label: "multi-step reasoning" },
    {
      patterns: [/\b(?:causal|acyclic|topological|dependency graph|event stream|reconcil(?:e|er|iation)|deep clone|prototype safety|safe-integer overflow)\b/iu],
      weight: 0.32,
      label: "algorithmic correctness contract",
    },
  ],
  verifiable: [
    { patterns: [/\b(test(s|ed|ing)?|repro(duction)?|expected output|acceptance criteria|typecheck|lint|benchmark)\b/iu], weight: 0.28, label: "explicit verification" },
    { patterns: [/```|\b(error|exception|stack trace|failing test)\b/iu], weight: 0.18, label: "concrete failure evidence" },
  ],
  parallel: [
    {
      patterns: [/\b(?:in parallel|parallelize|workstreams?|separate packages|audit each|independent (?:tasks?|workstreams?|packages?|services?|modules?))\b/iu],
      weight: 0.42,
      label: "explicit parallel workstreams",
    },
    { patterns: [/\b(frontend|backend|database|ci|docs)\b.*\b(frontend|backend|database|ci|docs)\b/isu], weight: 0.2, label: "multiple separable domains" },
  ],
  latency: [
    { patterns: [/\b(quick|fast|urgent|low latency|faster response)\b/iu], weight: 0.35, label: "latency-sensitive wording" },
    { patterns: [/\b(asap|right now|blocking me|while I wait|interactive|real[- ]?time)\b/iu], weight: 0.3, label: "interactive or blocking deadline" },
    { patterns: [/\b(outage|incident|hotfix|deadline|time[- ]critical|emergency)\b/iu], weight: 0.25, label: "time-critical operational context" },
  ],
} satisfies Record<string, SignalGroup[]>;

export function extractTaskFeatures(prompt: string, repo: RepoProfile): TaskFeatures {
  const evidence: string[] = [];
  const mechanicalText = scoreGroups(prompt, GROUPS.mechanical, evidence);
  const riskText = scoreGroups(prompt, GROUPS.risk, evidence);
  const ambiguityText = scoreGroups(prompt, GROUPS.ambiguity, evidence);
  const breadthText = scoreGroups(prompt, GROUPS.breadth, evidence);
  const depthText = scoreGroups(prompt, GROUPS.depth, evidence);
  const verifiableText = scoreGroups(prompt, GROUPS.verifiable, evidence);
  const parallelText = scoreGroups(prompt, GROUPS.parallel, evidence);
  const latencyText = scoreGroups(prompt, GROUPS.latency, evidence);

  const lineCount = prompt.split(/\r?\n/u).length;
  const fileMentions = (prompt.match(/(?:^|\s)[\w./-]+\.[a-zA-Z0-9]{1,8}(?=\s|$|[,:;)])/gu) ?? []).length;
  const codeBlocks = (prompt.match(/```/gu) ?? []).length / 2;
  const questionCount = (prompt.match(/\?/gu) ?? []).length;
  const explicitCriteria = /\b(acceptance criteria|must|should|expected|done when|requirements?)\b/iu.test(prompt);
  const bulletCount = (prompt.match(/^\s*[-*]\s+/gmu) ?? []).length;
  const contractSignalCount = (prompt.match(
    /\b(?:must|never|exact(?:ly)?|reject|throw|validate|validation|deterministic|side-effect-free|invariant|error classes?|output shapes?|before applying)\b/giu,
  ) ?? []).length;
  const repoScale = clamp(Math.log10(Math.max(10, repo.trackedFileCount)) / 4);
  const packageScale = clamp(repo.packageCount / 12);
  const changedScale = clamp(repo.changedFileCount / 20);
  const testDensity = repo.trackedFileCount === 0 ? 0 : clamp((repo.testFileCount / repo.trackedFileCount) * 12);
  const sensitiveRepo = clamp(repo.sensitivePathHits.length / 30);

  const mechanicalness = clamp(mechanicalText + Math.min(fileMentions, 3) * 0.08 + (explicitCriteria ? 0.12 : 0) - ambiguityText * 0.3);
  const ambiguity = clamp(0.12 + ambiguityText + questionCount * 0.04 - Math.min(fileMentions, 3) * 0.06 - (explicitCriteria ? 0.12 : 0));
  const breadth = clamp(0.08 + breadthText + repoScale * 0.16 + packageScale * 0.25 + changedScale * 0.12);
  const structuredContractDepth = explicitCriteria
    ? clamp(
        Math.min(bulletCount, 20) / 20 * 0.22 +
        Math.min(contractSignalCount, 16) / 16 * 0.22 +
        Math.min(Math.max(0, lineCount - 30), 90) / 90 * 0.1,
      )
    : 0;
  const depth = clamp(
    0.12 + depthText + structuredContractDepth + ambiguity * 0.16 + Math.min(codeBlocks, 2) * 0.05,
  );
  const explicitHighRiskDomain = /\b(migration|security|payment|auth)\w*\b/iu.test(prompt) ||
    PRODUCTION_OPERATIONAL_RISK.test(prompt) ||
    VIETNAMESE_SECURITY_RISK.test(prompt) ||
    VIETNAMESE_FINANCIAL_RISK.test(prompt) ||
    VIETNAMESE_MIGRATION_RISK.test(prompt);
  const risk = clamp(0.05 + riskText + sensitiveRepo * 0.12 + (explicitHighRiskDomain ? 0.16 : 0));
  const verifiability = clamp(0.12 + verifiableText + testDensity * 0.35 + (explicitCriteria ? 0.14 : 0) + Math.min(codeBlocks, 2) * 0.04);
  const novelty = clamp(0.18 + ambiguity * 0.35 + depth * 0.25 + (/\b(new architecture|novel|research|unknown technology)\b/iu.test(prompt) ? 0.25 : 0));
  const parallelizability = clamp(parallelText + breadth * 0.28 - depth * 0.12);
  const broadFilesystemDestruction = GROUPS.risk.at(-1)?.patterns.some((pattern) => pattern.test(prompt)) ?? false;
  const destructivePotential = clamp(
    riskText * 0.7 +
    (DESTRUCTIVE_ACTION_WITH_TARGET.test(prompt) || /\b(?:rotate secrets?|revoke)\b/iu.test(prompt) ||
      /(xóa|xoá|thu hồi|cắt ngắn)/iu.test(prompt) ? 0.35 : 0) +
    (broadFilesystemDestruction ? 0.5 : 0),
  );
  const latencySensitivity = clamp(latencyText);

  if (repo.testFileCount > 0) {
    evidence.push(`repository contains ${repo.testFileCount} test-like files`);
  }
  if (repo.sensitivePathHits.length > 0) {
    evidence.push("repository contains security/data-sensitive paths");
  }
  if (fileMentions > 0) {
    evidence.push(`prompt names ${fileMentions} file-like path(s)`);
  }
  if (lineCount > 30) {
    evidence.push("prompt contains extensive context");
  }
  if (structuredContractDepth >= 0.24) {
    evidence.push("prompt contains a dense correctness contract");
  }

  return {
    ambiguity,
    breadth,
    depth,
    risk,
    verifiability,
    mechanicalness,
    novelty,
    parallelizability,
    latencySensitivity,
    destructivePotential,
    taskKind: classifyTaskKind(prompt, risk, mechanicalness),
    evidence: unique(evidence),
  };
}

function scoreGroups(prompt: string, groups: readonly SignalGroup[], evidence: string[]): number {
  let score = 0;
  for (const group of groups) {
    if (group.patterns.some((pattern) => pattern.test(prompt))) {
      score += group.weight;
      evidence.push(group.label);
    }
  }
  return clamp(score);
}

function classifyTaskKind(prompt: string, risk: number, mechanicalness: number): TaskFeatures["taskKind"] {
  if ((/\b(security|vulnerability|threat model|penetration|auth|authorization)\b/iu.test(prompt) ||
      VIETNAMESE_SECURITY_RISK.test(prompt)) && risk > 0.45) {
    return "security";
  }
  if (/\b(migration|backfill|schema|database upgrade)\b/iu.test(prompt) || VIETNAMESE_MIGRATION_RISK.test(prompt)) {
    return "migration";
  }
  if (/\b(review|audit|inspect|analy[sz]e diff)\b/iu.test(prompt) || /(đánh giá|kiểm duyệt|kiểm tra diff|phân tích diff|xem xét)/iu.test(prompt)) {
    return "review";
  }
  if (/\b(research|compare approaches|literature|investigate technology)\b/iu.test(prompt) || /(nghiên cứu|so sánh phương án|khảo sát công nghệ)/iu.test(prompt)) {
    return "research";
  }
  if (/\b(refactor|restructure|redesign|rewrite)\b/iu.test(prompt) || /(tái cấu trúc|tổ chức lại|thiết kế lại|viết lại)/iu.test(prompt)) {
    return "refactor";
  }
  const explicitBugfix = /\b(fix|bug|failure|crash|broken|regression|failing)\b/iu.test(prompt) ||
    /(sửa lỗi|khắc phục lỗi|lỗi hồi quy|bị hỏng)/iu.test(prompt);
  if (/^\s*(?:add|implement|build|create)\b/iu.test(prompt) && !explicitBugfix) {
    return "feature";
  }
  if (explicitBugfix) {
    return "bugfix";
  }
  if (/\b(add|implement|build|create|feature)\b/iu.test(prompt) || /(thêm|triển khai|xây dựng|tạo|tính năng)/iu.test(prompt)) {
    return "feature";
  }
  if (mechanicalness >= 0.55) {
    return "mechanical_edit";
  }
  return "unknown";
}
