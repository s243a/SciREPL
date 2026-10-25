# Translation throughput and provider attention

The durable job's status is the authority for process ownership, remaining work,
holds, and the charged call budget. A live or queued request is not a failed
request. Diagnostics are observation only: they cannot create workers, retry,
refresh credentials, or change a claim, lock, plan, or call cap.

## Authentication and provider failures

The read-only companion `scripts/tutorial_translation_diagnostics.mjs` reports
allowlisted failure categories from saved structured transport/error metadata.
It must not inspect worker logs or match authentication words in successful
translation prose. A tutorial can legitimately discuss login and credentials.

Run it against a section job without changing that job:

```sh
node scripts/tutorial_translation_diagnostics.mjs --job /tmp/scirepl-tutorial-translation-job-sections-correction-20261016-a
```

Its offline fixtures run with `node --test tests/test_tutorial_translation_diagnostics.mjs`.

Report explicit login-required or expired-session evidence prominently, together
with its time and whether later requests succeeded. An HTTP 401 indicates an
authentication problem, but a generic 401 does not prove that interactive login
is the only remedy. HTTP 403 can indicate access or policy restrictions. Rate
limits, exhausted quota, service capacity, timeouts, connection failures, review
validation failures, and unreadable metadata are separate conditions.

A recent successful request establishes that provider access worked then; it
does not prove that current credentials are accepted. Local access-token expiry
alone does not establish that login is required, because refresh may succeed.
Do not read or report credential/account values. Do not invoke a login or refresh
flow as part of a status check. Missing or partially written metadata is unknown,
not proof of healthy authentication or permission to replay.

## Offline review batching

`scripts/tutorial_review_batching.mjs` exports the pure `packReviewSections`
planner. It merges adjacent complete source sections within one page/language,
preserving every field, object identity, and order. The caller supplies a byte
measurement of the fully serialized prompt, including translations and review
metadata. Optional response estimates have a separate cap; estimates are not a
quality or completeness guarantee. An oversized original section is rejected,
not silently split or dispatched.

Run its offline tests with:

```sh
node tests/test_tutorial_review_batching.mjs
```

The original recovery's frozen batching was not changed while it was running.
The separately authorized correction uses the packer only after all earlier
owners have stopped, in a fresh pinned plan with fresh independent reviewers and
unchanged acceptance gates. Existing valid drafts, passed independent review
sections, and accepted values are preserved. This does not authorize replay of
any old generation or automatic recursive retries.

AGY's local help documents `--input-format stream-json` on stdin, requiring
`--output-format stream-json`. A future adapter could remove the single-argument
input ceiling, but would need to validate streaming completion and final success.
Multiple input lines are multiple turns, not a promise of fewer provider calls.
The current 100,000-byte packing guard is local transport planning, not a claimed
model context limit. The targeted correction is the first authorized use of
packed review batches; completeness and quality must still pass the ordinary
gates. No separate paid benchmark or lower-effort model change is authorized.

## Measurements from the October 17 recovery audit

- The original section pass ran approximately 3 hours 6 minutes and then stayed
  stopped for approximately 21 hours 39 minutes before authorized recovery.
- Queue admission recorded zero whole seconds for all 204 earlier and 13 sampled
  recovery receipts. This does not establish a precise sub-second latency.
- Earlier request wall-time median was approximately 107 seconds; the recovery
  sample median was approximately 109 seconds. These are approximate timings
  from child/receipt file metadata, not a new benchmark or a completion ETA.
- AGY duration and usage fields are cumulative per conversation. Sum per-turn
  differences, not raw cumulative totals, when measuring request performance.
- On 18 frozen, fully drafted page/language units (3,639 fields), the tested
  packer reduces 61 source-section reviews to 38 proposed batches under the
  100,000-byte input guard; largest serialized batch is 99,592 bytes.
- Total prompt bytes change only from 2,795,443 to 2,745,696. Fewer requests alone
  are not evidence of a proportional runtime improvement. Output quality and
  truncation behavior of the larger batches have not been live-validated.
- The previous holds were preservation/keep-label gates, one incomplete inner
  JSON response, and one connection failure. No authentication, rate-limit, or
  quota evidence was found behind those holds. Larger batches must not relax the
  same numeric, placeholder, or independent-review requirements.

These measurements are a sample, not a policy for increasing concurrency or
silently changing model/effort. The shared concurrency limit remains two.
