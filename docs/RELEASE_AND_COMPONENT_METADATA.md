# Release and component metadata

SciREPL deliberately separates two kinds of version:

- `package.json` owns the SciREPL release version, explicit
  `releaseChannel` (`development` or `release`), and `android.versionCode`.
  The public version is used by the PWA, Android,
  Electron, Help and What's New. The Android code is separate because Google
  Play requires a monotonically increasing integer.
- `third-party-components.json` owns the tested versions, sources, licences
  and provenance of shipped or on-demand components.

`build-profiles.json` selects which language runtimes are enabled or bundled;
it does not duplicate their versions or network URLs.

## Generated and runtime consumers

`npm run configure` validates these sources and generates
`www/js/kernel_config.js`. The browser kernels, bundle downloader, Languages
screen, Help version, licence generator and Electron/Capacitor packaging all
consume the resulting metadata or its source files.

The Languages screen distinguishes:

- the exact **tested default** from the component manifest;
- the **latest available** compatible upstream version obtained from metadata
  only after consent to the current policy revision (without loading the
  runtime);
- an explicit user-selected version or source; and
- the version and source successfully loaded during the current session, when
available.

The legacy `scirepl_privacy_accepted` boolean remains valid for the runtime
downloads it originally disclosed, but it does not authorize automatic version
metadata checks. Those checks require
`scirepl_privacy_accepted_revision=2026-08-runtime-metadata-v1`; **Check latest**
opens the current policy before making any metadata request when that marker is
missing.

For R, choosing the rolling value `latest` is an explicit override and is not
described as tested. Prolog rejects its global `latest` because that now points
to an incompatible 8.x package line; **Check latest** instead resolves the
highest stable compatible 3.x selector and **Use latest available** stores that
exact selector. Latest-available releases are warned as untested whenever they
differ from the tested default. **Use tested version** clears both version and
source overrides; a reload then returns the runtime to the pinned default.

Custom URLs remain available under **Advanced source override** with an explicit
warning that runtime code can access notebook data. The special `local` value is
accepted only when the generated build configuration actually declares a local
runtime source. Supporting downloaded offline bundles for arbitrary
user-selected versions is future work.

CDN-hosted defaults should have independent mirrors when the upstream package
is available from more than one stable host. Release checks fail rather than
silently replacing a missing pinned artifact with different code. Bundled
runtime fetches also record provenance, and immutable artifacts can carry
expected byte counts and SHA-256 hashes.

The bundled webR recipe is intentionally described as modified packaging, not
an unmodified upstream distribution. To work around Android WebView serving
gzip assets with an unusable status, `scripts/fetch-bundles.mjs` decompresses
each `.data.gz`, removes the gzip wrapper, and clears the corresponding
`.js.metadata` `gzip` flag. `scripts/bundle-recipes.mjs` fingerprints that
transform, the completed bundle receipt inventories the result, and the
component manifest links the exact upstream release and R source. Re-running
the pinned fetch script is the preferred way to reproduce the distributed tree.

## Release preparation

1. Update `package.json.version` and increment
   `package.json.android.versionCode`.
2. Freeze the translated `unreleased` highlights in
   `www/js/release_highlights.js` under the new version, clear `unreleased`, and
   set `package.json.releaseChannel` to `release`.
3. If component metadata changed, run `npm run licenses:generate` and commit
   both generated notice files. Then run `npm run licenses:check` **before**
   `npm run configure`, followed by localization checks and the service-worker
   shell lock update. CI uses this order so stale committed notices fail rather
   than being silently regenerated.
4. Run `node scripts/check-release-version.mjs --tag=vX.Y.Z` before creating
   the tag. Tag builds run the same comparison and refuse a mismatched tag.

After tagging, switch the channel back to `development` before adding the next
set of unreleased highlights.

The component inventory is intentionally honest about scope. It covers the
direct and grouped components identified by the project, but is not yet a
complete crate-by-crate or Android transitive SBOM. Packages installed later by
the user retain their own licences and are not claimed as shipped components.
