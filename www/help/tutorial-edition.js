/* Public Help edition presentation only. No app settings, storage or requests. */
(function () {
  'use strict';
  if (new URL(window.location.href).searchParams.get('edition') !== 'free') return;
  const helpBase = new URL('.', document.currentScript.src);
  const locales = new Set(['en', 'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh']);
  const sharedRoutes = new Set(['tutorials', 'interface/tutorial', 'interface/appearance', 'files-export/tutorial', 'workbooks/tutorial', 'workbooks/import', 'workbooks/graphics', 'workbooks/named-cells']);

  // This script runs in the head, before Pro-only content can be painted.
  document.documentElement.setAttribute('data-tutorial-edition', 'free');

  function showFreeTutorials() {
    document.querySelectorAll('[data-tutorial-editions="pro"]').forEach(element => element.remove());
    // Only known, localized shared tutorials inherit the selected edition.
    // Reference pages, Pro guides, external sites and downloads are untouched.
    document.querySelectorAll('a[href]').forEach(link => {
      if (link.hasAttribute('download')) return;
      const target = new URL(link.getAttribute('href'), window.location.href);
      if (target.origin !== helpBase.origin || !target.pathname.startsWith(helpBase.pathname)) return;
      const relativePath = target.pathname.slice(helpBase.pathname.length).replace(/\/(?:index\.html)?$/, '');
      const slash = relativePath.indexOf('/');
      if (!locales.has(relativePath.slice(0, slash)) || !sharedRoutes.has(relativePath.slice(slash + 1))) return;
      target.searchParams.set('edition', 'free');
      link.href = target.href;
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showFreeTutorials, { once: true });
  else showFreeTutorials();
}());
