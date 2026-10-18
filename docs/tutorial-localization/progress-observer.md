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

Run isolated offline checks with `npm run test:tutorial-observer`.

## Stuck after completion (controller instrumentation, October 17, 2026)

A field run proved that a worker can print a complete final JSON envelope and
then never exit (it kept making background account calls for 14.5 hours). CPU,
I/O and log activity looked like progress. The section controller now arms a
grace timer (default 90 s; `SCIREPL_TRANSLATION_POST_COMPLETION_GRACE_SECONDS`
exists for offline tests) only when the accumulated stdout parses as a complete
envelope with a `status` field. Incomplete output is never stopped, however long
it takes; later output that makes it incomplete again disarms the timer.

When the grace expires the controller sends SIGTERM (SIGKILL after 5 s) and
records `stuckAfterCompleteOutput: true`, `completeOutputAt`, `stuckTerminatedAt`
and `postCompletionGraceSeconds` in the phase transport and phase status (state
`stuck-after-completion`, then `held`). If a descendant (for example an MCP
helper) still holds the pipes 10 s after the worker exits, the controller stops
reading them so the phase can settle. The acceptance gate is unchanged: such a
call is held as failed and charged; it is never accepted or retried
automatically. Accepting those envelopes would be a separate owner decision.

Workers now receive a fixed PATH (pinned Node directory, the runner's directory,
`/usr/local/bin:/usr/bin:/bin`), recorded as `workerPath` in each dispatch
record. AGY 1.4.0 has no per-run flag to disable MCP servers; `agy mcp disable`
edits the user's global configuration, so the controller does not use it.
