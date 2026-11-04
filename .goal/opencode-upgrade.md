# OpenCode 2.2.5 qualification — 2026-11-04

Requested outcome: diagnose persistent free-model quota and update the hosted
OpenCode without losing conversations, pairing, permissions or configured providers.

Baseline: main fc6753d pins T3 0.1.0 / OpenCode 2.0.32. Latest official V2
changelog and tag are 2.2.5; GitHub releases/latest still describes V1 1.19.5.

Acceptance:
- Native discovery, actual local model tool loops, provider identities and reasoning
  survive the update; use no real inference credentials or paid endpoints in CI.
- Fresh shared-server T3 boot works within 1,000,000,000 bytes RAM, swap disabled.
- Existing compacted-transcript reads remain compatible with T3's pinned native
  client 2.0.28. Source review identified a required recent field removed in 2.2.5;
  this is an OPEN release gate, not a passed runtime check.
- Native database migrations require verified backups before a production rollout.
- Verify actual deployed version and one real request after rollout. Do not claim
  free quota restored from installation or local fixture tests alone.

Verified facts:
- Official Console FAQ documents daily request limits for free models. Go has
  separate five-hour, weekly and monthly allowances.
- Upstream #59387 consolidates persistent free-tier/reset problems; reports also
  exist on 2.2.5. Server-side quota cannot be reset by this repository.
- Source audit: our loopback inference queue forwards genuine OpenCode attribution
  headers, streams the upstream status/body, and has no free-tier usage counter.

Current external blockers:
- Managed shell executor is unavailable; testing is prepared in an isolated branch.
- Railway connector still returns UNAUTHORIZED/requires reauthentication after
  the user's reconnect. Current logs/deployed version are therefore unverified.
- This branch is not ready for production while release gates remain open.
  Preserve production and keep main unchanged until all release gates pass.

Sources:
https://opencode.ai/changelog
https://opencode.ai/console/go
https://github.com/anomalyco/opencode/issues/59387
https://github.com/pingdotgg/t3code/blob/v0.1.0/packages/provider-opencode/package.json
https://github.com/anomalyco/opencode/blob/v2.0.28/packages/schema/src/session-message.ts
https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/session-message.ts

Runtime evidence: qualification run41856065976 succeeded. 17 JS +57 Python checks,
actual native discovery and both Moonshot/Code shell-tool loops passed with dummy
keys and retained reasoning. Fresh T3 protocol2 and native2.2.5 boot passed at
exact1e9-byte RAM/no swap. Compacted-transcript old-SDK gate is now prepared as
an actual native-wire import/read test; it has not yet run. Main unchanged.
