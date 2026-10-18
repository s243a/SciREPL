# Progress verification and orchestrator recovery decisions

Process ownership is not progress. `tutorial_translation_background.mjs status`
remains the pinned owner's liveness view; its `running` label is not evidence of
provider activity or accepted translations.

The unpinned `tutorial_translation_diagnostics.mjs --job JOB` now separates that
`ownerWorkflow` from an activity-aware `workflow`. A fresh heartbeat does not hide
an old request: after 30 minutes it raises a progress-unknown inspection advisory,
not a timeout, failure declaration, sign-in demand, cancellation or retry.
Legacy last-output timestamps remain unknown; they cannot be reconstructed from
request age. The threshold is an inspection policy, not a provider deadline.

For a bounded read-only sample:

```bash
/home/s243a/.nvm/versions/node/v22.22.2/bin/node scripts/tutorial_translation_observe.mjs --job JOB
```

The default 35-second sample crosses the owner's 30-second publishing interval.
The observer compares verified PID/boot/start identity, output byte counts, CPU
ticks and I/O-operation counts. It does not inspect command lines, environments,
prompts, inner response bodies, worker logs or credential values. Existing
diagnostics inspect only permitted outer transport/error evidence. It writes no observation cache,
signals no worker, acquires no lease and makes no provider/authentication request.
Its optional `--sample-seconds` accepts 10–60 seconds; rereading the same saved
heartbeat never establishes an output-silence interval.

`suspected_stall` means a long-lived verified request had no output growth
between independently published observations. Output or CPU/I/O activity is only
local activity; it does not establish provider progress or accepted translation
progress. Legitimate capacity waits remain waits without an implicit deadline.
Stale heartbeats, dead active workers and uncertain ownership require inspection.

In-flight coverage reconciles queued/dispatched/child/final-transport file
presence, without reading their contents. It exposes outstanding requests and
unknown scan evidence. Complete *record presence* is not successful transport,
review acceptance or current authentication. Authentication evidence remains
limited to completed receipts; missing final receipts cannot imply healthy auth.

The orchestrator's `orchestration` result is an advisory decision, never an
executor. It considers explicit tail and joint budgets, shared provider/auth
blockers, live ownership, dispatch audit, preserved pins/accepted baseline,
validated finite recovery plan, addressed blocker and explicit authority. A
warning never enables duplicate workers, automatic retry, lock reclamation or
weaker acceptance gates. Failed/cancelled attempts consume their allowance.

The current five-call tail has used all five reviews; together with eight source
calls the original thirteen-call limit is exhausted. It contains no untouched
review group. Replacement requires a new explicit bounded allocation and a
distinct evidence-backed recovery, not recursive continuation of the old pass.

Only unpinned diagnostic/observer files were changed. The live owner's controller,
health classifier, transport, queue, plan and accepted fields remain untouched.
Future owner instrumentation (last-output/provider-event timestamps, separate
exit/stream-closure and apply phases) must be deployed after safely settling the
pinned owner, with isolated lifecycle tests. It cannot be hot-added retroactively.

Run isolated offline checks with `npm run test:tutorial-observer` (this includes
the worker-inspector tests, which use fake workers and a fixture crashes
directory via `SCIREPL_AGY_CRASHES_DIR`).

## Stuck after completion (controller instrumentation, October 17, 2026)

A field run proved that a worker can print a complete final JSON envelope and
then never exit (it kept making background account calls for 14.5 hours). CPU,
I/O and log activity looked like progress. The section controller now arms a
grace timer (default 90 s; `SCIREPL_TRANSLATION_POST_COMPLETION_GRACE_SECONDS`
exists for offline tests) only when the accumulated stdout parses as a complete
envelope with a `status` field. Incomplete output is never stopped, however long
it takes; later output that makes it incomplete again disarms the timer.

When the grace expires the controller sends SIGQUIT (SIGKILL after 5 s). AGY is
a Go program: SIGQUIT makes it write a goroutine dump to
`~/.gemini/antigravity-cli/crashes/crash_<pid>_<uuid>.log` and exit. The
controller parses that dump into `<phase>.stack-summary.json` (function names,
goroutine states and wait minutes only; no arguments, addresses or raw text,
and the raw crash log is never copied). It records `stuckAfterCompleteOutput:
true`, `completeOutputAt`, `stuckTerminatedAt`, `postCompletionGraceSeconds`,
`stuckTerminationSignal`, `stackSummaryPath` and `knownSignature` in the phase
transport and status. If a descendant (for example an MCP helper) still holds
the pipes 10 s after the worker exits, the controller stops reading them.

**Acceptance rule (owner decision, October 18, 2026).** Output from a worker
stopped this way is accepted only when all of these hold: the complete envelope
was observed before termination, it reports SUCCESS with valid inner JSON (the
unchanged `parseTransport` checks, including the CLI timeout-warning check), the
stack summary's `knownSignature` is `title-generation-hang`, and every existing
identity, field, token, numeric and keep gate passes. The single code path is
`acceptStuckAfterCompletion`. Such pages record `outcome:
accepted-after-stuck-worker`, `manualReviewSuggested: true` and
`manualReviewFields` in the receipt, so a native speaker may choose to spot-check
them. Any other signature, or no stack summary, keeps the existing behaviour: the
call is held as failed, charged, and never retried automatically.

List the optional spot-check fields with:

```bash
node scripts/tutorial_locale_status.mjs --manual-review          # all locales
node scripts/tutorial_locale_status.mjs --locale ru --manual-review
```

## Inspecting an idle worker

When the controller (main thread) has been quiet for a while, inspect what the
workers are doing before deciding to wait, review held output, or prepare a
follow-up prompt:

```bash
node scripts/tutorial_translation_inspect.mjs --job JOB                         # every running phase
node scripts/tutorial_translation_inspect.mjs --job JOB --phase ru/01/review-01 # one phase
```

`tutorial_translation_diagnostics.mjs --job JOB` raises `workerInspection.attentionRequired`
and recommends this command when a running phase has made no model request
(AGY log markers) for more than the advisory threshold (1800 s). Background
`status` and diagnostics show the latest inspection report path,
classification, `knownSignature` and recommendation per phase.

Default mode is observational: no signals. It checks the worker PID against the
recorded start identity (and refuses on mismatch), then reports process state,
wchan, threads, a 5-second CPU-tick sample, child process names, established TCP
socket counts and age; output booleans and outer metadata (`completeOutput`,
`completeOutputAt`, envelope status, `duration_seconds`, usage numbers); and,
from the worker's own `--log-file` (`<phase>.agy.log`), only fixed markers with
counts and timestamps (auth, token refresh, print mode, sending message,
`streamGenerateContent`, stream exited, language-server shutdown, signals, MCP
start/close, error-line count). It never reads or prints prompts, responses,
conversation IDs or free log text. Each run writes
`<campaign>/<locale>/<chunk>/<phase>.inspect-<timestamp>.json`.

| Classification | Meaning | Recommendation |
| --- | --- | --- |
| `streaming` | No complete output; a model request is recent (default 600 s window). | `wait` — incomplete calls are never timed out. |
| `complete-not-exited` | Complete output is in hand, the model stream exited, no shutdown logged. | `wait` while the controller grace is pending (it dumps and decides itself); otherwise `inspect-stack`, then `review-held-output`. |
| `idle-no-output` | No complete output and no model request for longer than the window. | `inspect-stack` only with user approval (see below), or keep waiting; then `follow-up-prompt` if a dump shows `model-stream-wait`. |
| `exited` | The worker is gone or its transport is recorded. | The controller settles the phase; read diagnostics. |
| `unknown` | Evidence is missing or contradictory. | `wait` and re-inspect; never act on unknown evidence. |

The report also states policy facts: remaining review calls in the current
allowance, `retryAllowed: false`, the grace expiry, and whether `--stack` is
allowed without confirmation. The report never accepts anything itself.

`--stack` requests a goroutine dump (SIGQUIT, which terminates AGY) and saves
only the parsed summary with `knownSignature`, `meaning` and a suggested action:

| Signature | Meaning | Suggested action |
| --- | --- | --- |
| `title-generation-hang` | Main is in `CascadeManager.Shutdown → Pool.close`, blocked on `maybeGenerateConversationTitle → GenerateNonStreaming`. The call had finished. | `review-held-output` (the controller accepts it under the rule above). |
| `mcp-close-wait` | Shutdown is waiting for an MCP helper to close. | `review-held-output` (held; owner decides). |
| `model-stream-wait` | Still waiting on a model response stream; no complete output. | `follow-up-prompt` (needs allowance). |

`--stack` is allowed without confirmation only for `complete-not-exited` after
the controller's grace has expired (the result is already in hand, so
terminating loses nothing). While the grace is pending it is refused, so the
inspector never races the controller. In every other case it is refused unless
`--stack --confirm-terminate` is passed. **An agent may pass
`--confirm-terminate` on an incomplete call only with the user's explicit
approval**: the dump terminates the worker and the charged call is lost. Before
signalling, the inspector writes `<phase>.stack-request.json`; the controller
then records the exit as the same stuck-after-completion path when complete
output had been seen.

Decision table for agents:

| Report says | Do |
| --- | --- |
| `wait` | Wait; re-run the inspector later. Never cancel, retry or add workers. |
| `inspect-stack` on `complete-not-exited` | Run `--stack` (no approval needed); then follow the signature. |
| `review-held-output` | `title-generation-hang`: the controller accepts it; tell the user it is flagged for optional manual review. Other signature: report the held output to the user; acceptance is an owner decision. |
| `inspect-stack` on `idle-no-output` | Ask the user. With approval, run `--stack --confirm-terminate`; without it, keep waiting. |
| `follow-up-prompt` | If `remainingReviewCalls > 0`, prepare a bounded follow-up for the user/agent to approve. If `0` or `null`, ask the user for a new explicit allowance. |

Workers now receive a fixed PATH (pinned Node directory, the runner's directory,
`/usr/local/bin:/usr/bin:/bin`), recorded as `workerPath` in each dispatch
record. AGY 1.4.0 has no per-run flag to disable MCP servers; `agy mcp disable`
edits the user's global configuration, so the controller does not use it.
