# Hosted T3 Code

This Docker deployment is prepared for Railway. It runs the same verified T3 Code
0.0.45 and OpenCode 1.19.1. Keep this T3 version while using the V1 Android app:
the new T3 0.1 server requires the separate V2 mobile update.

One password-protected OpenCode server listens on loopback port 4096. T3's
conversations, model discovery and text generation all share it. Starting separate
OpenCode helpers and conversation servers exhausted Railway's 1,000,000,000-byte
memory limit in a reproducible file-generation test (`oom_kill=1`, displayed by
T3 as `OpenCode server exited unexpectedly (0)`). `supervise.mjs` starts OpenCode
before T3 and stops both if either exits. Only T3 port 3773 is public.
OpenCode also receives Bun's small-memory mode and a 512 MiB RAM hint for garbage
collection. Sharing the process alone still hit the limit during a long streamed
tool call. The RAM hint guides collection; it is not a hard memory cap.

Before startup, `configure.mjs` reads OpenCode's native model catalog and permits
all models whose reported input, output and cache costs are zero. It updates the
persisted configuration too, preserving a backup and the other configuration
fields. On 2026-10-16 this returned 10 models, including Big Pickle and DeepSeek
V4.1 Flash Free. If discovery fails, a verified bundled catalog is used. Model
availability and provider rate limits can change.

Metadata generation uses OpenCode's built-in `title` agent. Its free endpoint
accepts native title requests; it rejected the previous build-agent requests
with every tool denied. The normal coding model keeps the `build` agent.

New DeepSeek threads default to `high` reasoning. In a live `max` test, the model
used all 32,000 available output tokens for reasoning, returned zero answer
tokens and wrote no file (`finish=length`). T3 V1 displayed that turn as completed.
This is a separate model-output limit, so checking completion alone is insufficient:
verify the actual generated file. Existing per-thread options are preserved.

Deployment requirements:

- Connect the owner's Railway account before creating any hosted resources.
- Use the existing GitHub repository and the root `Dockerfile`.
- Attach a persistent volume at `/data` **before first startup**. Keep the tools
  in the image; the volume stores projects, history, authentication and caches.
- Create one public HTTPS service domain pointing at port 3773 (or `$PORT`).
- Stay on the account's Free/Trial plan. Do not add a paid plan or payment method.
- Verify outbound access to OpenCode; a Limited Trial can restrict networking.
- Check that T3 Code reports OpenCode as ready and exposes the free models.
- From an authenticated management shell, run `bash /app/server/pair.sh` and give
  only the HTTPS domain and the newly generated pairing code to the owner.
  Do not commit pairing codes or store them in public deployment logs.
- If shell access is unavailable, first confirm that deployment logs are private
  to the owner, set `T3_PRIVATE_ONBOARDING=1`, and read `PHONE_PAIRING_CODE` from
  those private logs. This standard phone grant works once and expires after
  one hour. The broad administrative startup grant stays in the private data
  directory. Clear the variable after the phone has paired. A redeployment can
  generate another phone grant.

The original 1 GiB smoke test only verified a short response. The later test
uses the actual Railway limit of 1,000,000,000 bytes with swap disabled and checks
generation of an HTML file through tools. A 512 MiB test ran out of memory during
OpenCode discovery. Large builds, browsers or concurrent jobs can still need
more memory than a 1 GB instance provides.

Railway's trial currently permits 1 GB and includes a limited $5 credit. Its
ongoing Free plan permits only 512 MB and is not sufficient for the tested
configuration. Continuing after the trial can require a paid plan, which needs
the owner's explicit authorization before upgrading. This is not an unlimited
free server. A volume's data is also subject to Railway's retention policy after
credits expire.

The actual Railway deployment was verified through public HTTPS authentication,
public WSS, and a completed free DeepSeek conversation. Data was verified to
survive a container restart. The owner's Android pairing is the final client
step; do not put the phone's pairing code in this repository.
