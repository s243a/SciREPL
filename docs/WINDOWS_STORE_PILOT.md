# Microsoft Store pilot — Free Electron first

Planning snapshot: November 13, 2026 (America/Edmonton). Proposed sequence:
ship the next Pro release; run a Free Electron x64 pilot; then decide whether
to list Pro as a separate product. The [next Free Android/PWA release](NEXT_FREE_RELEASE_PLAN.md)
can proceed independently. No account, package
identity, signing, certification or Store listing is established by this plan.

## Why this order

Both editions already produce platform-specific Electron portable ZIPs. The
pilot would use the same packaged web application and desktop shell, not a new
Windows UI. The ZIP is not an installer, has no Store-managed update path, and
is not certification evidence. Free tests packaging and updates without
introducing commerce or a Pro credential boundary. Do not publish a hosted
Pro PWA or reuse the Free product identity for Pro.

Use **MSIX** on Windows x64 first. Microsoft hosts and signs Store MSIX and
delivers its updates. The MSI/EXE alternative requires a publisher-signed
standalone silent installer and PE files, an immutable versioned HTTPS
download, and a project-managed update path.
[Microsoft distribution paths](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path)
· [MSI/EXE requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements)

## 1. Reduce certification risk before rebuilding the packaging stack

- Inventory exactly what can be downloaded and executed today: bundled
  engines, first-use Lua/R, optional kernel-source overrides and CDN fallback,
  user-initiated Pyodide packages, and notebook-provided code. Separate these
  from fetching workbook data or documentation. Trace where bytes are
  fetched, verified, cached and executed, and which actions require consent.
- Current [Microsoft Store policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies#102-security)
  §10.2.2 restrict dynamic inclusion that changes the described functionality
  or introduces policy violations, not every user-script or dependency
  download. §10.2.3 addresses malware and secondary software; §10.2.9
  addresses the external MSI/EXE installer path. Even accurately describing
  notebook execution and language-package downloads is not certification.
- Prepare an exact Store-profile proposal for the pilot: bundling pinned
  Lua/R and restricting unpinned engine overrides are options to reduce
  ambiguity, not requirements assumed from the rule. Keep useful notebook
  functionality unless a specific unresolved policy or security issue
  requires a narrower profile. Document what is offline and what needs
  network access, draft the certification instructions, and ask Microsoft
  for clarification if a proposed download path remains ambiguous.
- Account registration announcements cover both
  [individuals](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/)
  and [companies](https://blogs.windows.com/windowsdeveloper/2026/05/07/publish-to-microsoft-store-as-a-company-now-with-free-registration-and-faster-onboarding/).
  Use the current onboarding flow for identity verification and eligibility.
  Confirm owner, desired publisher name, product-name availability and
  packaging identity in Partner Center before tying an installer to them.
  Account creation and name reservation are separate owner actions.

## 2. Make and verify one Free package

1. Stage the prepared runtime/app tree from the existing
   [portable packager](../desktop/electron/packaging/build-portable.mjs)
   without changing the installed web origin.
   Evaluate the Windows SDK [MakeAppx](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)
   or Microsoft's [Electron packaging guide](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/guides/electron-packaging)
   before replacing the current packager. [Electron Forge's MSIX maker](https://www.electronforge.io/config/makers/msix)
   is experimental, and [electron-builder's documented MSIX target](https://www.electron.build/docs/msix/)
   is beta on the v27 preview docs. Pin whichever toolchain is selected.
2. Add a reviewed manifest, product icon, confirmed identity and predictable
   Windows package version; keep the native capability list narrow. Do not
   add an Electron updater to the Store package. Keep the current Free
   sandbox, CSP, preload and external-navigation policy. Use an isolated
   matching-publisher test signature for native sideload checks; that is
   separate from the package signed by the Store.
3. Install from a clean Windows account. The current runtime cache lives
   under Electron's user-data path; verify the packaged app can write
   notebooks, settings, and runtime caches without writing to its
   installation directory. Confirm the actual virtualized data paths and
   backup/uninstall behavior. Do not silently import an old portable
   profile. At minimum, provide a tested export/import path for preview
   users. Keep Free and Pro profiles separate.
4. Run the Windows App Certification Kit and tests on the installed MSIX:
   cold online/offline launch, promised runtimes, consent and a package
   download, notebook open/save/export, keyboard/accessibility and scaling.
   Upgrade package A to B with retained notebooks and settings, then test
   uninstall/reinstall. Passing ZIP smoke tests does not cover these steps.
5. Prepare screenshots, privacy URL, localized descriptions for declared
   Store languages, support contact and reviewer notes. Describe the limits
   of starter-guide translation and the offline/download distinction.
   Review the Free donation link and any later paid functionality against
   the current [Store policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies),
   including §10.7 for localization.
6. With separate authorization, certify the first submission to a
   [Private audience](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/visibility-options)
   of named testers. Use [package flights](https://learn.microsoft.com/en-us/windows/apps/publish/package-flights)
   for subsequent test updates after the baseline is published. An unlisted
   link is not access control, and Microsoft does not allow switching a
   public audience back to private. Confirm the Store-delivered upgrade and
   data retention before making Free publicly visible.

## 3. Bring Pro after Free proves the distribution path

- Prefer **two separate listings** over including paid Pro material in the
  Free payload. Reuse the packaging and tests, not product IDs, profiles, or
  public artifact destinations. Decide the desktop access/pricing model
  before submitting; no assumption that a Google Play purchase transfers.
- The existing Pro plan is Store-controlled acquisition first, with no
  runtime licensing check unless separately requested. Paid acquisition
  is not a security boundary against copying renderer assets. If runtime
  entitlement later becomes necessary, prototype a narrow Windows-native
  adapter instead of a patchable renderer flag. Test purchase, reinstall,
  account change, revocation and offline/cached behavior separately.
  Microsoft's [StoreContext reference](https://learn.microsoft.com/en-us/uwp/api/windows.services.store.storecontext.getapplicenseasync?view=winrt-28000)
  documents cached licence results offline.
- Revalidate Pro task-specific inputs and authorization in the real
  packaged host. Protected key storage, the Windows vault/DPAPI and native
  approval, optional provider/remote-broker connections, and any new Store
  entitlement are independent release checks. No public Pro ZIP or PWA.
- For Pro's AI features, review [Store policy §11.16](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies#1116-live-generative-ai-content)
  against the actual build. Plan listing and Partner Center disclosure,
  safeguards, and a way to report inappropriate output to the developer
  without silently sending notebook contents or credentials.
