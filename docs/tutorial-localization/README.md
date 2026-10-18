# Localized tutorials

The public tutorial index and its eight walkthroughs have explicit language-code
routes: `/help/<locale>/<route>/`. Supported locales are `en`, `ar`, `bn`, `de`,
`es`, `fr`, `hi`, `id`, `ja`, `ko`, `pt-BR`, `ru`, and `zh`. Original English URLs
remain valid. Reference Help pages outside this inventory are still English and
are marked as English fallbacks in translated tutorials.

Generated locale pages share the original screenshots, SVG overlays, CSS, small
workbook downloads, and scripts. They never duplicate image files. Screenshots
remain English; prose explicitly tells readers to match the translated control
names with their app. Machine translations carry a native-review-pending notice.

## Controlled translation process

1. Extract source-offset fields using `tutorial_locale_extract.mjs`. Pass
   `--pro-i18n-root` to the checked Pro app's `www/i18n` directory to snapshot
   actual Pro control labels. The manifest records immutable source hashes.
   Three prose-only AI practice prompts have explicit `data-translatable-prompt`
   markers. Their sentences are translated, but exact cell names, seeds,
   generator expressions, statistical formulas and display calls are protected.
   Unmarked executable code blocks and inline examples remain byte-identical.
2. Make sanitized requests using `tutorial_locale_chunks.mjs <directory>`.
   Translators receive plain text and opaque protected tokens, never editable
   HTML. Code, TeX, URLs, filenames, numeric/technical values, and known app
   controls are protected. Entire control names and arrow-separated control
   paths use the existing app translations, rather than new model wording.
3. Request one draft and a separate fresh review for each chunk. Use at most two
   requests concurrently. Do not automatically retry or silently fall back to
   English after a failure. The operator/model transport is separate from the
   deterministic pipeline; no credentials enter these files or generated pages.
4. Apply a reviewed response with `tutorial_locale_apply.mjs <locale> <file>`.
   Required envelope: `manifestHash`, `translations` keyed by exact field ids,
   and `review` with `status: "accepted"`, `reviewer`, and `draftModel`.
   A legitimately unchanged source term must have a specific reason under
   `review.keptFields[fieldId]`; unreviewed English passthrough is rejected.
   Such keeps are limited to short labels/terms (at most three words and 35
   unprotected characters, without sentence punctuation), never paragraphs.
   The sole longer-label exception is the pinned `workbooks.tutorial.0067`
   English workbook selector title. It requires its exact strong-field identity,
   source text, recomputed source hash, empty protected-span list and a reviewed
   keep reason. Other long titles and English prose remain rejected.
   Protected tokens must occur exactly once in their original order. Unknown
   fields, HTML supplied by a worker, stale sources and unreviewed responses fail.
   Replacement characters, hidden bidirectional controls and changed or added
   unprotected numeric values are also refused.
5. Render with `tutorial_locale_render.mjs`, then verify with `--check` and run
   `tests/test_tutorial_locales.mjs --all`. Review labels/layouts and exercise the
   locale picker in a browser. Arabic prose is RTL; code and screenshots stay LTR.

The source manifest is deliberately large: its evidence protects each exact
example and UI label. Review receipts describe machine review only, not native
speaker approval. Generated pages do not claim that the app's entire Help system
or the downloadable example workbook files have been translated by this task.

## Campaign status and publication dependency

The smaller-batch campaign was authorized on October 14, 2026. Its first French
chunk passed the draft, independent fresh review, deterministic checks and a
separate fidelity read. The remaining chunks are in progress; this is not yet a
publication-ready set of translated tutorials.

Earlier campaigns remain held and are not replayed. An earlier French pilot
produced complete draft and fresh review JSON, but a product-name fidelity issue
prevented applying it. Subsequent larger requests returned empty or truncated
inner JSON at the CLI's 90-second print limit. The CLI reported `SUCCESS` despite
zero completion duration/usage metadata and a timeout warning, so status/exit
code alone are not completion evidence. No partial or truncated translation has
been applied.

Retained transport evidence stays outside the repository. Do not replay consumed
chunks, automatically retry, repair partial JSON, or quietly publish English
fallbacks under another language code. The authorized smaller requests use at
most 5,000 prose characters and 40 fields per chunk; one fresh draft and one
independent review remain the limit. Requests can be prepared without dispatch:

```bash
TUTORIAL_CHUNK_CHARACTERS=5000 TUTORIAL_CHUNK_FIELDS=40 \
  node scripts/tutorial_locale_chunks.mjs /tmp/scirepl-tutorial-requests-new-pilot
```

Following the user's longer-wait preference, future controllers default to
`printTimeout: 0s` and `watchdogTimeout: 0s`: the CLI waits until its turn finishes
and there is no forced timeout. While each owned child is still running, a
30-second heartbeat logs only elapsed seconds and stdout/stderr byte counts,
never worker prose, prompts, credentials or raw diagnostics. Output caps, source
and file checks, and explicit operator cancellation still apply. Campaign
receipts pin the profile, polling interval and existing medium effort. A running
controller retains its already captured settings; new defaults do not change
or replay an existing worker.

Explicit finite profiles remain supported: `SCIREPL_TRANSLATION_PRINT_TIMEOUT`
accepts integer seconds from 30 to 600, and
`SCIREPL_TRANSLATION_WATCHDOG_TIMEOUT` must allow 15–60 additional seconds. The
zero-wait profile requires both settings to be zero; mixed zero/nonzero profiles
are rejected. These controls do not authorize retrying a consumed chunk. Any CLI
timeout warning still rejects the response even when its envelope says `SUCCESS`.

SIGTERM/SIGINT stops new dispatch, cancels only this controller's active workers,
waits for their closure, and releases only locks whose process id and ownership
nonce still match. It never reclaims another controller's stale or live lock.
`npm run test:tutorial-transport` tests timeout/partial-output refusal, at-most-once
behavior, numeric-only polling, output caps and two-worker cancellation through
an isolated offline fake CLI; it makes no provider requests and cannot apply
translation data. Waiting longer does not grant a repair loop: each chunk still
gets at most one draft and one independent fresh review, with no automatic
retries or recovery of partial JSON.

### Durable background owner

`scripts/tutorial_translation_background.mjs` separates `start`, read-only
`status`, and explicit `stop`. Start creates a detached supervisor with private
logs and pinned source/request/runtime files; it returns without owning the
translation's lifetime. A later status command only reads durable metadata and
verifies process identity. It never sends a request or resumes a conversation.

Owner status includes an allowlisted `workflow` summary from the pinned
`tutorial_translation_health.mjs` classifier. That summary verifies ownership,
not worker/provider progress. The unpinned diagnostics now retain it separately
as `ownerWorkflow` and publish a progress-aware `workflow`, `activity`, in-flight
coverage and an orchestrator recovery recommendation. Reports must lead with
the diagnostic inspection/stall advisory when it requires attention, rather
than treating an alive process or fresh heartbeat as proof of useful work.
See [progress verification](progress-observer.md) for the bounded read-only
sampler, distinctions and recovery gates.

| Status | Meaning and next action |
| --- | --- |
| `running` / `starting` | A verified controller/supervisor exists; advancement is not established by liveness. Consult activity diagnostics. Zero provider workers between phases is not a shortage. |
| `waiting_for_capacity` | A live controller is queued for a shared slot; respect the concurrency cap and keep waiting. |
| `running_with_holds` | Other work can still finish; preserve it and plan recovery for the held subset. |
| `needs_workers` | Unfinished work has no live owner and no recorded phase activity. Audit dispatch history before assigning any authorized replacement; missing evidence is not proof of zero calls. |
| `needs_recovery` | The finite pass ended held/failed, or held work has no owner. Adding workers alone cannot clear validation/transport holds; prepare explicit bounded recovery. |
| `needs_inspection` | Ownership, worker identity, counts, dispatch history or the terminal result is ambiguous/inconsistent. Inspect before any replay. |
| `cancelling` / `cancelled` | Honor the cancellation; never automatically resume. |
| `completed` | This finite job completed; overall translation coverage, browser/link validation and publication are separate gates. |

The summary contains verified live/queued/unverifiable worker counts, remaining
page/chunk units (including held units), `canAdvance`, `reasonCode`, a fixed
`recommendedAction`, and saved status/finish timestamps. Unknown counts/liveness
remain unknown; elapsed time alone never authorizes a retry. Historical phase
rows marked `running` are not counted as live workers without matching PID,
boot/start identity. The summary excludes raw prompts/responses, logs and
conversation IDs. Every status read remains non-mutating, and
`automaticRecovery` is always false. A status recommendation is not permission
to add workers, alter locks, retry phases or weaken validation.

The real controller now uses `tutorial_translation_queue.mjs`: a busy shared
slot remains queued without a two-minute cutoff, publishing metadata every
30 seconds. It distinguishes queued, admitted and spawned phases. The actual
dispatch marker is written only after admission. FIFO applies to cooperating
tutorial workers; the older Catalog client bypasses this queue, so this is not
a promise of global fairness. Neither live nor stale sibling locks are stolen.

The detached owner records its child in memory before fallible metadata writes;
a write failure cancels and waits for that child. Cancellation uses verified
PID/start/nonce ownership, not arbitrary PIDs. Source, request and runtime pins
are checked again after waiting and before applying. Offline tests cover waits
past the former 120-second limit, FIFO, parent exit, cancellation and an injected
controller-record write failure. No provider is called by these tests.

AGY updates itself automatically. Its configured executable path, model and
effort stay fixed for a job, but its executable bytes are **not** an immutable
campaign input. Each actual dispatch records the observed version and executable
hash as informational provenance. A normal AGY update therefore does not halt
the batch. Node, controller/helper code, English source and sanitized request
hashes remain strict dispatch/apply gates. Offline tests cover a runner update
between draft and review while still rejecting source/request/helper drift.

Example commands, with fresh verified task paths substituted:

```bash
node scripts/tutorial_translation_background.mjs start \
  --job /tmp/scirepl-tutorial-translation-job-UNIQUE \
  --requests /tmp/scirepl-tutorial-translation-requests-VERIFIED \
  --campaign /tmp/scirepl-tutorial-translation-campaign-UNIQUE
node scripts/tutorial_translation_background.mjs status \
  --job /tmp/scirepl-tutorial-translation-job-UNIQUE
```

The first detached continuation selected 154 independently audited, never-started
chunks. `prepare_tutorial_untouched_resume.mjs` verifies the original 552-request
fingerprint and checks every selected chunk against all three previous campaigns.
Old zero-call slot holds, the Korean review-only hold, and failed provider
transports are deliberately not replayed by this continuation. They remain
separate recovery work; accepted evidence is unchanged.

The subsequent finite-completion recovery uses an independently audited plan
against the same original request inventory. It selects only unfinished chunks,
reuses successful complete draft transports for review-only work, and records
one explicit bounded recovery of failed provider phases; it is not an automatic
retry loop. `tutorial_translation_recovery.mjs` verifies original phase evidence,
source/request hashes and the absence of already accepted fields. Prepare-only
and status checks create no claims. Actual execution makes one exclusive,
permanent plan/chunk claim before dispatch, preventing accidental replay by a
second controller; waiting and applying use separate read-only rechecks.
Pass the audited file with `--recovery-plan` to the background start command.
The plan caps calls, and reused drafts accurately record zero new draft calls.

All twelve translated editions, reviewed receipts, deterministic checks and the
13-language portrait/landscape browser matrix must finish before publication is
called complete. Every translated page retains the honest machine-translated /
native-review-pending notice; machine review is not native-speaker approval.

Publish and verify the public `/help/<locale>/…` routes before merging app links
that select them. The documentation is hosted by the Free repository, but this
does not require releasing a new Free app binary or delaying Pro for unrelated
Free feature work. Preserve the original English URLs throughout the transition.

## Coherent sections with retained conversation context

### Explicit bounded recovery of a held section pass

`tutorial_section_recovery_plan.mjs --source-job <stopped-job>` is read-only
unless `--output` is supplied. It requires a terminal held section campaign,
audits original plan/job/phase pins and dead process identities, and selects
exactly its still-missing held page-language units. Complete successful draft
turns and original draft seeds are preserved with their transport, proposal,
session and dispatch evidence; incomplete/error output is never salvaged.
Previous reviewer output is not accepted as new review evidence.

The resulting plan pins the current accepted snapshot, every reused draft and
all prior evidence, records all known old conversation identities privately,
and sets exact page/global draft and coherent-review call caps. Recovery uses
fresh conversations with a separate fresh reviewer, continuously checks every
baseline accepted value, and keeps the same strict source, number, placeholder,
keep-declaration and application gates. Label eligibility does not invent a
linguistic justification: the reviewer must explicitly provide each required
keep reason. Failed attempts consume their budget; there is no automatic retry.

One permanent execution claim covers the source campaign's recovery generation,
in addition to the new plan's claim. Changing the derived plan cannot replay it,
and a recovery plan cannot recursively recover another recovery. A later failure
requires another evidence audit and a fresh finite plan, not deletion of claims
or a blind restart. Ordinary correction work can be covered by the user's
standing translation-task authorization; a loop guard alone is not a reason to
ask the user again. Ask for judgment when changing acceptance rules, accepting
uncertain content, materially expanding scope/cost, accessing an account, or
publishing/releasing. New live work starts only after offline tests and a bounded
recovery decision; shared worker concurrency remains two.

### Targeted correction with preserved independent reviews

`tutorial_section_correction_plan.mjs --source-job <terminal-first-recovery>`
audits the stopped first recovery and prepares a separate finite correction plan.
It cannot take another correction generation as its input or free an old claim.
Complete successful drafts are reused, so no drafting is authorized. Independent
review sections that already passed every gate can also be preserved: each is
bound to its exact reconstructed source/draft prompt, successful transport,
proposal, session, dispatch, and dead worker identity. The failed phase is never
salvaged, even if some of its fields look plausible.

The pending source sections are packed adjacently within a page/language under a
fully serialized 100,000-byte prompt guard. The new reviewer gets exact required
IDs, protected-token order and numeric sequences, plus explicit unchanged-label
reason requirements. Gates are unchanged. The controller independently rebuilds
the plan before claiming work; it rechecks all evidence/helper pins and every
baseline accepted value before each dispatch and application. Preserved reviews
and fresh reviews must jointly cover the entire still-missing page exactly once.

The current approved correction preserves 700 independently reviewed fields and
925 saved draft fields across seven held page/language units. Its ceilings are
zero draft calls and thirteen fresh review calls. A minimum fifteen-second gap
between new requests prevents bursts; at most two shared workers remain active.
The ceilings guard runaway loops; they are not a dollar estimate or a claim
about subscription capacity. Routine requests/batches do not require separate
approval. Native review, browser/link checks, publication and release remain
distinct from machine-review acceptance.

### Explicit manual section corrections

`tutorial_section_manual_apply.mjs --spec <private-editorial-spec> --check`
audits a stopped correction job without writing or calling a model. It accepts
only complete exact-field independent reviews with successful transport and
verified request, session, dispatch, source and dead-owner provenance. A failed
provider envelope or incomplete field set is never eligible.

An explicit editorial spec may rephrase one uniquely matched clause while
preserving every protected token and its meaning, or translate an unchanged
eligible short heading. The full before/after hashes and reason are recorded;
there is no automatic token sorting, field reassignment or invented keep reason.
All original acceptance gates still apply. Complete prior gate-passed review
sections can be preserved, but never-dispatched sections remain missing.

After a successful check, `--apply --output <fresh-private-output-directory>`
uses per-locale locks, rechecks immutable evidence and accepted snapshots, and
atomically adds only missing fields. Separate receipts identify controller
editorial changes; they do not claim Gemini approved those edits or that a
native speaker reviewed them. Original held evidence and accepted values remain
unchanged. This manual path makes no provider requests and does not restart the
stopped campaign.

`tutorial_section_review_continuation_plan.mjs` is a distinct forward-only path
for original review groups that demonstrably never entered the queue or
dispatched. It does not recover a failed call. All consumed review fields must
already be accepted through complete reviews or explicit editorial receipts.
The original correction ceiling is shared: eight charged calls leave at most
five of its thirteen calls, not a new allocation of thirteen. Every new attempt
is charged, and the continuation cannot itself be continued recursively.
Source phase-prefix and queue-history absence is rechecked after waits and
before dispatch. Existing accepted values remain read-only, and the same
fifteen-second cadence, two-worker cap and acceptance gates still apply.
Full terminology context is preserved. If that context makes a source section
exceed the serialized transport cap, the continuation uses the original
controller's fallback of splitting only between complete fields, then packs
adjacent pieces. It still must fit the original unused-call ceiling.

### Explicit user-approved review allowance

`tutorial_section_review_allowance_plan.mjs --source-job <stopped-job>
--allowance <approval.json> [--output <fresh plan>]` prepares a NEW finite review
allowance for page/language units held by a stopped continuation. It never
extends an exhausted lineage: the predecessor's joint usage is recorded as
history and the new ceiling comes only from a pinned approval record
(`user-approved-review-allowance`: id, approver, time, scope, origin job,
`maxDraftCalls: 0`, `maxReviewCalls` 1–5, `automaticRetries: false`). Saved
successful drafts are reused, all prior reviewer identities (including the held
call's) are excluded, and failed or cancelled output is never salvaged. Each
attempt is charged. A later generation may follow a held allowance run only with
the same approval, and only within its remaining calls. The controller rebuilds
the plan from the stopped evidence before claiming work; gates are unchanged.

For static tutorial pages, prefer `tutorial_locale_section_plan.mjs` and
`run_tutorial_section_translations.mjs` over the historical tiny-fragment
controller. The published result is still static HTML under language-code URLs,
not a runtime app-string catalogue. Adjacent short headings are grouped into
coherent turns; unusually long sections split at subheadings or complete fields.

The planner inventories accepted records and old attempt evidence. Accepted text
is read-only context, complete successful drafts are reused, and failed or
cancelled review envelopes are not accepted. Every missing field must occur
exactly once, as either a new section request or a preserved draft. No prior
controller or owned worker may remain live during regrouping.

Each page/language has a stable empty workspace and its own drafting
conversation. The first successful AGY JSON envelope supplies `conversation_id`;
later sections use `--conversation <that-id>` with the same model and safety
flags. Never use `--continue`, which could select another parallel job's chat.
An independent reviewer starts a different conversation. Short pages fit one
review turn; larger pages retain reviewer context across bounded section turns.
Code, mathematical expressions, URLs and actual app labels remain protected.

The controller uses the same two-slot queue, zero print/watchdog deadlines,
30-second metadata polling, strict successful-envelope checks and deterministic
apply gate. Prepare-only creates no dispatch or execution claim. An actual run
makes an exclusive claim for its exact plan; a new campaign cannot replay that
plan automatically. A failed page is held without preventing unrelated pages
from progressing. Model output and conversation IDs remain private evidence.

Run it with the existing durable owner:

```bash
node scripts/tutorial_translation_background.mjs start \
  --job /tmp/scirepl-tutorial-translation-job-UNIQUE \
  --sections-plan /tmp/scirepl-tutorial-section-plan-UNIQUE/plan.json \
  --campaign /tmp/scirepl-tutorial-translation-sections-UNIQUE
```

The bounded live canary passed two shared-context draft turns plus a separate
review: exact conversation continuity, prior-turn recall, protected tokens and
no workspace files changed. That proves this tested continuation pattern, not
tool isolation, translation completion, native-language review or publication.
No MCP/ACP bridge or workbook editing tools are required for this mode. A prompt
asking for no tools is not an OS sandbox or proof that the CLI has no tools.

## Operational names and incremental verification

Some walkthroughs explicitly download an English companion workbook or select
its English catalogue edition. Its actual search text, workbook selector title,
and the app's `English` language option must remain recognizable in translated
instructions. `operational-names.json` pins eighteen specific occurrences to
their source-field hashes and original `<strong>` placeholder boundaries. Local
companion names are verified against the pinned public workbook assets. This is
an inventory of operational identifiers, not permission to retain whole English
sentences or paragraphs.

The renderer alone imports `tutorial_locale_editorial.mjs`. It validates the
reviewed model text first, restores only the inventoried label spans, preserves
all nested protected tokens, and records its changes separately under
`editorial/<locale>.json`. The one standalone Markov workbook title is a scoped
identifier exception, not a general translation-validation exemption. The
inventory also records eleven exact control-name fragments against the frozen app
glossary: nine locale-specific Open preset names (`fr`, `bn`, `hi`, `ja`, `ko`,
`de`, `es`, `id`, and `pt-BR`), the French Own row default, and the German CSV
Import File menu path. The six later Open fragments are pinned specifically to
`pro.ai.tutorial.0082`'s `{{P000}}` control; the CSV path uses
`workbooks.import.0037`'s `{{P000}}` full app label and changes only the reviewed
`→ Import File` text, not filenames or surrounding prose. Exact locale, field,
source hash, fragment, glossary field/token and localized label must match;
unexpected variants fail rather than receiving generic word replacement.
These changes are controller-authored: their receipts
explicitly do not claim model approval or native-language approval. Translation
records, source manifests, and model-request evidence remain unchanged.

In Arabic, only these inventoried English label interiors receive trusted
`<bdi lang="en" dir="ltr">` markup, so their words and punctuation remain in
reading order inside RTL prose. Worker HTML remains forbidden.

Independent fidelity checks also found phone model names spelled out in French,
Arabic, and Brazilian Portuguese eighth chunks. The operator restored the exact source
`Samsung Galaxy S24` identifier through the separate manual-correction gate and
receipts, without an extra provider request. Bengali and Hindi second-chunk
clauses, and the matching Japanese and Korean clauses, were reordered to follow
the strict source numeric order: their original
translations were already accurate, and the rewording preserves every value and
protected token. These are controller-authored corrections, not new model reviews or
native-speaker approval.

The polled campaign's Arabic and Bengali identifier holds use the same explicit
manual gate. A German graphics field spelled out the number in `Base64`; its
standard identifier was restored. A Japanese AI Prompt caption omitted the
`S24+` designation; only that designation was restored. Each complete chunk was
independently compared with its frozen source, with exact original-review hashes
and correction receipts retained. Failed or incomplete transports are not
eligible for this gate, even when an error envelope contains parseable text.

A completed locale may be rendered and checked while other locales are still
in progress. Rendering preflights every requested page and review receipt before
writing any output. The status command is read-only:

```bash
node scripts/tutorial_locale_status.mjs --locale fr
node scripts/tutorial_locale_render.mjs fr
node scripts/tutorial_locale_render.mjs fr --check
node tests/test_tutorial_locale_editorial.mjs
node tests/test_tutorial_locales.mjs --locale fr
node tests/test_tutorial_locales_browser.mjs --locale fr
```

Selected-locale checks do not approve publication of the whole set. The final
`--all` checks must still pass with all thirteen routes present per tutorial;
missing editions are never waived. `--check` verifies both generated HTML and
the separate operational-name receipts.
