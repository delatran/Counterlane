# Dependency and license inventory

## Runtime boundary

Runtime dependencies: none

The packed Counterlane runtime does not declare npm runtime dependencies. The
release check verifies that boundary from package metadata and the lockfile.

## Direct development dependencies

| Package | Locked version | Declared role | License observed in installed package metadata |
|---|---:|---|---|
| @modelcontextprotocol/sdk | 1.29.0 | MCP protocol development and test support | MIT |
| @types/node | 22.20.1 | Node.js TypeScript declarations | MIT |
| typescript | 5.8.3 | Strict TypeScript build and type checking | Apache-2.0 |

The npm lockfile is the provenance record for transitive development
dependencies. Before publication, the owner must rerun package install,
release-integrity, and vulnerability checks against the intended lockfile and
resolve any newly reported issue according to its applicability and severity.

## License and notice boundary

Counterlane is Apache-2.0. LICENSE and NOTICE are included in the package
allowlist. Any future runtime dependency requires an explicit safety or
correctness justification, license review, attribution update, and package
surface review.
