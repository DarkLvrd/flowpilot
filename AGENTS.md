# Flow Pilot agent notes

Chromium extension + local helper that drives Google Flow for one account, for people and agents.

- **Read `docs/SPEC.md` (decisions + hard rules) and `docs/LESSONS.md` (why they exist) before changing anything.**
- The hard rules in `docs/SPEC.md` are non-negotiable: no reCAPTCHA handling, no fake telemetry, no credential access, one work tab, halt on `UNUSUAL_ACTIVITY`.
- Never spend credits in tests. Live checks are read-only unless the owner asks for a real job.
- Layout: `extension/` (MV3, loads unpacked, no build step), `helper/` (Node: HTTP API, CLI, MCP), `recon/` (captured Flow findings; `recon/raw/` is gitignored), `docs/`.
