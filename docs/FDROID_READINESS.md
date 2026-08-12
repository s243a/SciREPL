# Future F-Droid Readiness

SciREPL is not currently prepared for submission to the official F-Droid repository. This is a deferred roadmap, not a commitment to support an F-Droid release now.

F-Droid builds applications from public source and requires the application, its dependencies, and its build path to be free software. It also scans bundled binaries and places special requirements on executable code downloaded after installation.

## Provenance work now in place

The normal Free build now has a useful, tested foundation for this future work:

- `third-party-components.json` is the source of truth for direct runtime and library versions, pinned source/mirror URLs, delivery mode, licence identifiers, and known modified/forked builds;
- build configuration, runtime loading defaults, and bundle downloads consume that manifest instead of duplicating Pyodide, webR, SWI, Scittle, Fengari, and DOCX versions;
- the default SWI package is pinned to `npm-swipl-wasm` 3.8.2 (`3/8/2`, SWI-Prolog 9.3.8) and its current bundle has a recorded SHA-256;
- Brush and TypR record the exact fork revisions and hashes of their checked-in WASM/JavaScript artifacts;
- `THIRD_PARTY_NOTICES.md` and the offline in-app `open-source-licenses.html` are generated from the same manifest, with the recorded local licence texts and notices currently represented there;
- CI rejects stale generated notices, unmapped top-level `www/vendor` directories, selected manifest/package-lock version drift, and a release tag that differs from `package.json`.

This is intentionally a direct/grouped component inventory, not a claim of F-Droid readiness or a complete SBOM. It identifies the named Pyodide wheels and major command suites embedded in Brush, but it does not yet enumerate every Rust crate, Android/Gradle dependency, Chromium component, or compiled runtime subcomponent. User-installed language packages are outside the shipped-component inventory and retain their own licences.

## Required work remaining

### Create an isolated F-Droid build profile

Add a `fdroid` profile that produces a useful free application without resolving or packaging distribution-specific services.

The profile should:

- remove `com.google.gms:google-services` from the Gradle build classpath;
- omit `google-services.json` and all Play/Firebase integration;
- exclude `www/pro/**` and Google Play promotional pages from the APK;
- keep the locally rendered Ko-fi link free of remote widget scripts;
- keep development and test artifacts out of the release source and APK;
- have its own CI build so regressions are detected before submission.

### Make build inputs immutable and verifiable

The normal build still downloads optional executable components and permits explicit user source/version overrides. Before an F-Droid submission:

- ensure the F-Droid profile cannot silently select a rolling URL or an unverified user override;
- extend SHA-256 recording and verification from the currently covered Brush, TypR, and SWI artifacts to every downloaded or generated executable artifact;
- verify downloaded and cached files against those hashes and fail closed on disagreement;
- use only publicly available FLOSS sources and acceptable artifact repositories;
- make repeated clean builds consume the same declared inputs.

### Account for executable downloads at runtime

Audit all JavaScript, WASM, language runtimes, and installable packages fetched after installation. This includes optional language kernels, the DOCX export library, package-catalog content, and user-configurable kernel URLs.

For the F-Droid build, either bundle these components from verified FLOSS inputs or require explicit informed consent before download. The notice must explain that the executable code was not checked as part of the installed F-Droid package. A plain external donation link is preferable to executable widget code.

### Supply corresponding source and provenance for bundled artifacts

For every committed or generated WASM, archive, vendored library, font, and runtime, record:

- component name and exact version or commit;
- upstream source URL;
- license and required notice text;
- artifact SHA-256;
- corresponding source location;
- reproducible build or packaging command.

In particular, document the Brush and TypR WASM files and the generated UnifyWeaver package. Remove release-irrelevant test ZIPs and test WASM from the release path.

Extend the existing human-readable notices and machine-readable direct-component manifest into a complete artifact lock or software bill of materials. Automate corresponding-source publication for each release, especially GPL/MPL/EPL-covered binaries and modified fork builds.

### Bring privacy and network disclosures in sync with the code

Maintain one authoritative inventory of network access and use it to generate or check the in-app and website privacy text. It should cover Python/Pyodide, Prolog, R/webR, Lua/Fengari, ClojureScript/Scittle, DOCX export, package downloads, GitHub releases, donation links, configurable sources, caching, and deletion controls.

Determine and declare any applicable F-Droid anti-features honestly. Depending on the final build, these might include non-free application promotion or dependence on network services. Avoiding the behavior is preferable where practical.

### Clean up the dependency boundary

- Align the Capacitor CLI and runtime packages on the same supported major version.
- Move Playwright to development-only dependencies and exclude it from release installation.
- Keep exact intended package versions locked.
- Resolve and audit the complete Android and JavaScript dependency graphs.

## Submission verification

Before opening an F-Droid request:

1. Build from a public, signed release tag using the proposed F-Droid recipe.
2. Run `fdroid scanner` and resolve every unexplained result.
3. Build twice in clean environments and compare outputs.
4. Confirm that no proprietary Google service is resolved.
5. Inspect the APK to confirm that Pro/Play pages, test artifacts, and remote widget code are absent.
6. Confirm that every bundled executable has public corresponding source and license provenance.
7. Add and validate the F-Droid metadata, screenshots, descriptions, donation information, and any anti-feature declarations.

## Current decision

Defer F-Droid packaging until its distribution value justifies this work. Normal SciREPL releases do not need to wait for this roadmap, provided their existing distribution requirements and release checks pass.

## References

- [F-Droid Inclusion Policy](https://f-droid.org/en/docs/Inclusion_Policy/)
- [F-Droid FAQ for app developers](https://f-droid.org/en/docs/FAQ_-_App_Developers/)
- [F-Droid Anti-Features](https://f-droid.org/en/docs/Anti-Features/)
- [F-Droid Build Metadata Reference](https://f-droid.org/docs/Build_Metadata_Reference/)
