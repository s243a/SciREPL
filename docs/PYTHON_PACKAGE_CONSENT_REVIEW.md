# Python package consent: independent-review follow-up

This follow-up addresses the agreed findings from Claude's S10+ review of
Free #131 (cde517c) and Pro #149 (b6056e1). The earlier phone results apply to
those heads, not automatically to a changed candidate.

## Fixed behavior

- Obtain the current network disclosure at the actual outbound package fetch,
  not merely when an installer is invoked.
- Cover public micropip PackageManager, install.__wrapped__, and the compiled
  pyodide_js.loadPackage path, as well as ordinary micropip, pip_install and
  %pip. Install the Python HTTP hook before micropip captures pyfetch.
- Preserve arbitrary custom package indexes, explicit wheel URLs, native
  arguments, return values and exceptions. Do not infer package absence from
  failed metadata/download requests.
- Bundled pandas, already-installed packages and skipped environment markers
  complete without network consent or external package traffic.
- Preserve partial-dependency repair, truthful failures, restored stdout and
  successful subsequent cells. Remove the cosmetic colon/semicolon join in
  compiled-package error messages.
- Pro retains execution-owner checks across consent suspension, and its
  separate host-permission prompts remain in the request chain. It must also
  work with the optional experimental notebook-network guard disabled.

These same-realm hooks enforce the app's normal package workflows. They are
not a claim to sandbox hostile notebook code with arbitrary JavaScript access.

## Deliberately unchanged

The official privacy body and its acceptance button remain English while the
privacy-domain translation is draft. The translated unofficial-translation
notice and link follow the existing policy. Do not mark a privacy translation
reviewed or replace the official policy without accountable human review.
An optional informational translation must never silently replace that policy.

The English disclosure is therefore not treated as a lazy-loading regression.

Pro's single active Python execution rule prevents one run from borrowing
another run's suspended package authorization or shared stdout state.
The review's concurrent-run observation is recorded as intentional, not
silently relaxed to permit overlapping interpreter ownership.

## Upstream limitations

Pinned Pyodide 0.27.4 / micropip 0.8 also exhibits the reviewed deps=False list
failure, unsupported reinstall keyword and incomplete requested extras.
These are not new wrapper regressions. Preserve the native behavior rather
than invent a successful install or silently change the caller's options.
The complete public signature/forwarding remains regression-tested.

## Independent re-test

Recheck the exact new source commit and packaged asset hashes, then repeat:

1. Fresh bundled Python startup without disclosure or package traffic.
2. Public PackageManager, unwrapped install and direct loadPackage: no
   outbound request before acceptance; dismissal stops the cell tail.
3. Raw/helper/%pip bundled pandas: no prompt and no external package requests.
4. Failed dependency download, truthful error, retry in the same interpreter,
   first inline Matplotlib plot and output restoration.
5. Pro authorization revoked while disclosure is open: Accept sends nothing;
   later authorized manual execution still works.
6. English authoritative disclosure, translated informational notice, narrow
   portrait/landscape, enlarged fonts and dismissal with hardware Back.

Browser/Debug evidence does not establish signed CLOSED-testing, S24+ coverage,
a true device-offline pass or native local-model/inference clearance.
Neither this follow-up nor a green test authorizes a tag, merge or publication.
