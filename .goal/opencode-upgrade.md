# Hosted OpenCode provider qualification — 2026-11-05

Goal: diagnose NVIDIA latency, provide credible recurring-free API choices for
current open-weight models, integrate the suitable choices in the existing T3
phone environment and verify actual agent work without losing saved data.

Production baseline:
- T3 0.1.0, OpenCode 2.2.5, main c58f105; original service/URL/volume preserved.
- All91 original visible conversations remain, three databases pass quick_check,
  all206 original workspace files match; full access and private S3 archive enabled.
- Verified complete S3 backups exist immediately before the earlier migration.
- Free OpenCode HTTP429 also reproduces in its genuine official CLI; not fixed
  by the upgrade. No identity/account/IP changes or quota-counter resets.

Acceptance and evidence:
- [PASS] Distinguish authentication/network from particular NVIDIA models:
  same key/host, DeepSeek no headers120s; NemotronLightning first answer1.421s,
  completed1.446s. This does not identify capacity vs model-specific access.
- [PASS] Real T3 NemotronLightning shell task completed10.88s, actual proof file
  written/read/asserted, assistant marker matched, zero approval requests.
- [PASS local] NVIDIA silent-start deadline60s frees queue once; own generated
  failures carry x-should-retry:false (native2.2.5 supports it). All real upstream
  statuses/headers/bodies remain unchanged. Ten actual HTTP-boundary tests pass.
- [PASS source] Groq verified Free Plan Qwen3.8-27B + GPTOSS20B/120B:30RPM,
  1000RPD,8KTPM,200KTPD; native Groq integration is official. Owner added key in
  Railway securely. Real account/tool-loop check remains pending deployment.
- [PASS local] OpenRouter optional strict live :free+tools+allzero pricing,
  intersect native catalog; no paid twins/router fallback. No-purchase50RPD,
  20RPM;1000RPD requires prior credit purchase. Six policy tests pass.
- [PASS local] ModelScope optional exact Flash1017 and Qwen native definitions,
  live public catalog check, correct environment binding and DeepSeek reasoning
  compatibility. Six tests pass. KYC/Aliyun linkage required;250 earned daily
  Magicubes/2 per Flash1017 call. Bulgarian eligibility unverified; no key/live
  inference tested. Native codec fixture remains a CI gate.
- [PENDING] Full GitHub qualification of exact pinned native runtime, all five
  provider shell/reasoning loops, terminal NVIDIA timeout no-retry and compaction.
- [PENDING] Deployed SUCCESS + actual Groq T3 tool task and automatic-title path.
- [PENDING] Final health, original conversations, archive and owned-probe cleanup.

Local verification:47 of48 Node checks passed; unchanged real-browser child
fixture cannot make its /tmp directory because this managed workspace root is
full (ENOSPC). CI's isolated normal filesystem must run that required check;
do not describe it as locally passed or bypass filesystem permissions.

Source of truth: official Groq limits/OpenCode guide, current OpenRouter public
API+free collection, current ModelScope docs/catalog, NVIDIA model documentation
and exact OpenCode2.2.5 retry source. Missing keys/catalogs disable new providers;
no secret is written in source/public catalogs, no subscription/credit purchased.

Temporary older QA clone remains (service3a32bfee-8b98-4041-92b2-52dda9a7894b,
volume ca19f854-927d-472b-a62e-7bcc493f7575): Railway previously cancelled deletion
for missing approval. Do not retry deletion without owner approval. Preserve
original production volume and archive bucket.
