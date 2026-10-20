# Hosted T3 Code

This Docker deployment is prepared for Railway. It runs the same verified T3 Code
0.1.0 and OpenCode 2.0.32, compatible with the Android 2.0 app and orchestration
protocol 2. The older 0.0.45 server rejects that app with “Client not supported”.
Versions are pinned together; a working HTML page alone does not verify mobile
compatibility. Check `/.well-known/t3/environment` and authenticated WebSocket
RPC using `?orchestrationProtocol=2` plus HTTP header
`x-t3-orchestration-protocol: 2`.

One password-protected OpenCode server listens on loopback port 4096. T3's
conversations, model discovery and text generation all share it. Starting separate
OpenCode helpers and conversation servers exhausted Railway's 1,000,000,000-byte
memory limit in a reproducible file-generation test (`oom_kill=1`, displayed by
T3 as `OpenCode server exited unexpectedly (0)`). `supervise.mjs` starts OpenCode
before T3 and stops both if either exits. Only T3 port 3773 is public.
OpenCode receives Bun's small-memory mode, a 256 MiB GC sizing hint and a separate
320 MiB JSC heap ceiling. The native T3 Node server has a 224 MiB old-generation
limit and 4 MiB semi-spaces; the supervisor uses 64 MiB and 2 MiB. These bound
JavaScript heaps, not total RSS or the memory used by external tools and file cache.
Core dumps are disabled to prevent a memory failure filling the project volume.

`runtime-memory.cjs` is loaded only into the native server's Node runtime. An IPC
heartbeat reports numeric heap statistics every five seconds; garbage collection
can run under pressure. `runtime-health.mjs` independently checks both loopback
HTTP APIs with real wall-clock deadlines, including trickling/hung responses.
Three consecutive failures or a stalled heartbeat cause a clean failure exit,
allowing Railway's restart policy to recover the service. Startup readiness has
an actual 60-second deadline per service. Memory diagnostics are rate-limited.

Browser verification tools can consume the remaining RAM even with serialized
inference. `browser-resources.mjs` lowers Chrome/headless-shell CPU priority and
raises their OOM score so a sudden spike preferentially loses the browser tool.
Under working-set pressure or repeated health failures, it terminates the largest
browser group older than ten seconds and larger than 64 MiB before restarting the
core services. Remaining browser descendants are killed after five seconds only
if their process start identities still match. File cache alone does not trigger
cleanup. The calling agent receives the browser-tool failure and can retry;
conversation data, source files and ordinary project servers are not pruned.

Validation includes eight focused health/resource tests, four real concurrent
tool-using chats and three real subagents in one chat. A frozen native server
automatically restarted in 27 seconds and accepted the same authenticated WSS
client afterward. Long or memory-heavy tasks still have to fit the hosting quota.

## Multiple conversations and storage protection

`storage-maintenance.mjs` runs one bounded Python cleanup worker every 15 seconds,
and inference admission awaits the same worker when less than 128 MiB remains.
Concurrent calls share the worker. Provider/OpenCode diagnostic logs are capped
in place, without unlinking open files or pruning project folders.

T3 0.1 records growing reasoning text as repeated full `turn-item.updated`
snapshots. `compact_reasoning.py` replaces only superseded, already-projected
reasoning text copies with a short notice. It preserves the first and two newest
complete snapshots, every event row/ID/sequence, stream versions, message text,
tool results, plans and all materialized views. Retaining rows preserves ingestion
deduplication and first-write item positions. The V2 schema/version and projection
watermark restrict the operation. The full latest reasoning remains readable.

Both databases use incremental auto-vacuum so reclamation returns physical pages
to the volume. The first conversion prepares a checked copy off-volume, retains
a verified compressed backup there, and replaces the persistent database only
after a complete, fsynced staging file is ready. If staging needs more room, the
unused V1 import database can be retained as the verified compressed
`/data/backups/legacy-v1-state.sqlite.gz`; the active V2 database is untouched.
Subsequent cleanups operate in small SQLite transactions without restarting T3.
No per-cleanup backup accumulation occurs on the 500 MB volume.

Validation included actual T3 0.1 projection replay before and after compaction:
all 17 durable projection tables matched exactly. A real database fell from
245,669,888 to 80,990,208 bytes. Tests also checked idempotence, physical page
reclamation, log budgets and three simultaneous inference requests recovering
from low space through a single cleanup worker.
The production Debian image uses SQLite 3.40, whose incremental-vacuum behavior
differs from the test host's SQLite 3.53. Reclamation explicitly steps one page
at a time in short batches instead of relying on `incremental_vacuum(N)` to
return N pages. An automatic timer test on the actual image returned 33,595,392
physical bytes while preserving every message and event row. A live test also
completed three real child agents inside one T3 conversation without approvals
or OOM kills; all three output files were checked.

`inference-queue.mjs` runs inside the existing supervisor on loopback port 4098.
Native model endpoint overrides send inference through a FIFO queue shared by
OpenCode's free models and NVIDIA. One upstream stream runs at a time. Request
bodies wait with backpressure; responses stream without collecting them in memory.
Credentials, native headers, model parameters and tool policies pass through
unchanged. Routes are limited to the native catalog's known HTTPS inference hosts.
The queue respects environment proxies and CA trust.

The slot is released before tool execution. This allows a parent agent to wait
for a delegated agent without holding the child's inference slot. Cancelling a
waiting request removes it; cancelling an active request aborts its upstream.
This limits inference overlap; external builds, browsers and shell commands
still share the server's 1 GB. The queue does not make the hosting quota unlimited.

Cache files use `/tmp/t3-cache`. Each child process log rotates at 2 MiB with two
older copies, and native traces use `Warn` with three 2 MiB files. New inference
requires 64 MiB free on `/data`; an active stream is aborted below 48 MiB. This
leaves room to persist the failure and keep existing conversations readable.
No history or project files are automatically pruned. Railway's restart policy
is `ON_FAILURE` with ten retries; idle sleep remains disabled.

`storage.py` performs the first cold recovery before either runtime starts. It
removes regenerable caches, verifies compressed diagnostic archives and SQLite
backups before checkpointing, preserves credentials, and avoids replaying all
interrupted work together. A marker prevents repeated database backups. Check
the archive and available space before attempting recovery on a full volume.

If even a backup cannot fit, an operator can temporarily enable
`T3_RECOVERY_ONLY=1` with a fresh secret `T3_RECOVERY_TOKEN` of at least 48
characters. Only the maintenance process runs. Authenticated archive export allows
off-volume verification before pruning diagnostic files by matching SHA-256.
The backup acknowledgement is only for an independently verified full archive
and three verified SQLite databases. Clear both variables before redeploying
normally. Archives include private credentials and must never enter Git or logs.

On 2026-10-19, the restored environment's 51 conversations and 189 messages
matched the verified cold archive. Four native tool tasks submitted together
completed on a 1,000,000,000-byte test container without approvals or OOM kills.
The test verified actual files and their computed results. The largest observed
test memory peak was 727,822,336 bytes; production also uses reclaimable file
cache, so raw `memory.current` is not its unreclaimable working set.
Four further tasks on the restored Railway service used DeepSeek Free, Big Pickle
and NVIDIA GPT-OSS 20B together. All completed with verified file results within
67 seconds, no approval requests, and `oom=0; oom_kill=0` throughout.

Before startup, `configure.mjs` calls OpenCode 2's native `model.list` API through
a temporary standalone process and permits
all models whose reported input, output and cache costs are zero. It updates the
persisted configuration too, preserving a backup and the other configuration
fields. V1 whitelist settings are no longer supported in OpenCode 2, so native
model `disabled` switches enforce the catalog. Only public model metadata is
cached; raw model responses contain credentials and must never be saved or logged.
The catalog includes Big Pickle and DeepSeek
V4.1 Flash Free. If discovery fails, a verified bundled catalog is used. Model
availability and provider rate limits can change.

T3 0.1 uses OpenCode 2 temporary sessions for metadata generation; the free
endpoint rejects stateless generate calls. The old title-agent setting is retained
for migrated settings, while T3 selects the appropriate native session behavior.

New DeepSeek threads default to `high` reasoning. In a live `max` test, the model
used all 32,000 available output tokens for reasoning, returned zero answer
tokens and wrote no file (`finish=length`). T3 V1 displayed that turn as completed.
This is a separate model-output limit, so checking completion alone is insufficient:
verify the actual generated file. Existing per-thread options are preserved.

The owner requested persistent Full access on 2026-10-17. New installations and
the one-time migration use `defaultRuntimeMode: full-access`; OpenCode's global
permission is `allow`. Existing T3 threads are updated through the runtime-mode
command, so their native session rules refresh when they resume. A user can still
choose a restricted mode explicitly in T3.

Keep Railway's `sleepApplication` disabled. The idle-sleep setting repeatedly
stopped the environment on 2026-10-17; Android's discovery request took 8.7 seconds
while the container was waking. An always-running service consumes the existing
trial credit while idle too; no paid plan is enabled by this setting.

## NVIDIA NIM from the phone

API credentials are configured on the server, and the mobile app selects
the resulting OpenCode models. The owner enters their key in Railway, service `t3-code`, Variables,
`NVIDIA_API_KEY`, then deploys the variable change. Keep the value out of chat,
Git and command output. The prepared variable starts empty.

At startup, the key enables the `nvidia` provider alongside the free `opencode`
provider. Its official endpoint is `https://integrate.api.nvidia.com/v1`. The
configuration references `{env:NVIDIA_API_KEY}` and stores no key in the repo.
The catalog intersects NVIDIA's public model list with OpenCode's models that
support tools, excluding embeddings, image generators and other non-agent APIs.
The bundled snapshot is a fallback; startup refreshes the list from NVIDIA and
OpenCode 2's native model metadata and disables non-coding models explicitly.
Catalog discovery without an available NVIDIA catalog leaves the provider disabled
for that startup while retaining its key. NVIDIA account
quotas apply independently of OpenCode's free offers. DeepSeek through OpenCode
remains the default; adding the key does not switch existing conversations.

When the key is absent, NVIDIA stays disabled and the existing free models work
normally. After adding the key and deployment completes, reopen T3 and refresh
the model list; the additional group is named `NVIDIA NIM`.


## V1 to V2 migration

Before the first V2 deployment, take verified SQLite backups of
`/data/t3/userdata/state.sqlite` and `/data/data/opencode/opencode.db`, preserve
the entire `userdata` directory except logs/WAL snapshots, and archive all
workspaces. Include `userdata/secrets` and `environment-id` so existing device
credentials and the environment identity remain valid. Keep backups private.

T3 snapshots V1 into `statev2.sqlite`; V1 remains intact. The V2 importer preserves
thread IDs, model selections, permission modes, workspaces, archives and user/assistant
messages. Old native tool activity and provider bindings are not imported. The
first continuation starts a fresh provider session with a bounded transcript
handoff. OpenCode 2 also converts its database; never run OpenCode 1 and 2 together
on that data, or roll back only the executable without restoring the matching
backup. Read-only recovery from the V1 backup remains possible.

Trace rotation is capped at three 2 MiB files rather than ten 10 MiB files on the
500 MB data volume. Old rotated traces were archived before reclaiming their space.

Deployment requirements:

- Connect the owner's Railway account before creating any hosted resources.
- Use the existing GitHub repository and the root `Dockerfile`.
- Attach a persistent volume at `/data` **before first startup**. Keep the tools
  in the image; the volume stores projects, history and authentication. Download
  caches stay on temporary storage.
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
