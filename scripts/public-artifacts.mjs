const ROOT_FILES = [
  ".mcp.json",
  "BUILD_WEEK.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "counterlane.config.example.json",
  "DEMO.md",
  "DEPENDENCY_INVENTORY.md",
  "JUDGE_FIXTURE_MANIFEST.json",
  "LICENSE",
  "NOTICE",
  "package.json",
  "README.md",
  "RELEASE_STATUS.json",
  "SECURITY.md",
  "SOURCE_MANIFEST.sha256",
  "SUBMISSION.md",
];

const PREFIXES = [
  ".agents/",
  ".codex-plugin/",
  "deploy/",
  "dist/",
  "docs/",
  "skills/counterlane/",
];

const EXACT_FILES = [
  "scripts/counterlane-doctor.mjs",
  "scripts/demo-judge.mjs",
  "scripts/install-local-plugin.mjs",
  "scripts/public-artifacts.mjs",
  "scripts/release-status.mjs",
  "scripts/source-manifest.mjs",
  "test/fixtures/mock-app-server.mjs",
];

export const PACKAGE_FILES = Object.freeze([
  "dist",
  "docs",
  ".agents",
  ".codex-plugin",
  ".mcp.json",
  "deploy",
  "skills/counterlane",
  "scripts/counterlane-doctor.mjs",
  "scripts/demo-judge.mjs",
  "scripts/install-local-plugin.mjs",
  "scripts/public-artifacts.mjs",
  "scripts/release-status.mjs",
  "scripts/source-manifest.mjs",
  "test/fixtures/mock-app-server.mjs",
  "JUDGE_FIXTURE_MANIFEST.json",
  "SOURCE_MANIFEST.sha256",
  "BUILD_WEEK.md",
  "CHANGELOG.md",
  "DEMO.md",
  "DEPENDENCY_INVENTORY.md",
  "SUBMISSION.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "RELEASE_STATUS.json",
  "counterlane.config.example.json",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
]);

export const REQUIRED_RELEASE_DOCUMENTS = Object.freeze([
  "BUILD_WEEK.md",
  "CHANGELOG.md",
  "DEMO.md",
  "DEPENDENCY_INVENTORY.md",
  "SUBMISSION.md",
  "docs/build-week-demo-script.md",
  "docs/build-week-launch-checklist.md",
  "docs/evaluation-contract.md",
  "docs/open-source-release-checklist.md",
  "RELEASE_STATUS.json",
]);

const ROOT_FILE_SET = new Set(ROOT_FILES);
const EXACT_FILE_SET = new Set(EXACT_FILES);

export function normalizePortablePath(value) {
  if (typeof value !== "string") throw new Error("Public artifact path must be a string.");
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.length === 0 || normalized.startsWith("/") || normalized.includes("../") || normalized.includes("\u0000")) {
    throw new Error(`Invalid public artifact path: ${value}`);
  }
  return normalized;
}

export function isPublicPackagePath(value) {
  const path = normalizePortablePath(value);
  return ROOT_FILE_SET.has(path) || EXACT_FILE_SET.has(path) || PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function isPublicPackagePathOrAncestor(value) {
  const path = normalizePortablePath(value);
  return isPublicPackagePath(path) ||
    PREFIXES.some((prefix) => prefix.startsWith(`${path}/`)) ||
    EXACT_FILES.some((file) => file.startsWith(`${path}/`));
}
