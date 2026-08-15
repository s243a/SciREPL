/**
 * Localized highlight keys for each shipped release.
 *
 * During development, edit `unreleased`. Release preparation bumps package.json,
 * freezes that list under the new version, clears `unreleased`, and switches
 * package.json's explicit releaseChannel to `release`. The modal obtains both
 * version and channel from generated KERNEL_CONFIG metadata; it never infers
 * development state from this table or carries a second current-version value.
 */
(function () {
    'use strict';

    window.SCIREPL_RELEASE_HIGHLIGHTS = Object.freeze({
        '1.1.0': Object.freeze([
            'whatsNew.highlightLanguages',
            'whatsNew.highlightOffline',
            'whatsNew.highlightDesktop',
        ]),
        '1.2.0': Object.freeze([
            'whatsNew.highlightLicenses',
            'whatsNew.highlightWhatsNew',
            'whatsNew.highlightShortcuts',
            'whatsNew.highlightRuntimeMetadata',
        ]),
        unreleased: Object.freeze([
            'whatsNew.highlightCatalogSources',
        ]),
    });
})();
