# SkillSpector Reference

Source: `https://github.com/NVIDIA/SkillSpector`

## Use

Use SkillSpector as an installation and CI security gate for external skills, MCP servers, plugins, and agent scripts. It scans prompt injection, exfiltration, excessive agency, supply-chain risks, dangerous code, MCP permission issues, and known dependency vulnerabilities.

## Install gate

1. Prefer a static scan first: `skillspector scan <source> --no-llm`.
2. For executable skills, MCP servers, obfuscation, or unclear behavior, run a semantic scan using an approved provider.
3. Treat `DO_NOT_INSTALL`, high risk, incomplete analysis, or unresolved findings as blockers.
4. Review each finding against the source and the intended use; do not blindly accept a baseline.
5. Pin the scanned version or commit and rescan after updates.

## CI policy

Scan the skill repository's `SKILL.md`, `scripts/`, executable references, and dependency manifests on every change. Keep machine-readable JSON or SARIF output as an artifact. Use baselines only for reviewed, evidence-bound suppressions.

## Data and cost boundary

A semantic scan may send skill content to the configured model provider. Use a local provider when privacy matters. Never commit provider keys. SkillSpector is a scanner, not a complete security boundary; combine it with human review, least privilege, sandboxing, and dependency verification.
