// Public-help-only enhancement: choose a real catalogue folder, without a
// request, app setting, or assumption about the reader's browser language.
(() => {
  'use strict';
  const folders = new Map([
    'ar', 'bn', 'de', 'en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'pt-BR', 'ru', 'zh',
  ].map(folder => [folder.toLowerCase(), folder]));
  const folderFor = locale => {
    const normalized = String(locale || '').trim().toLowerCase().replaceAll('_', '-');
    const base = normalized.split('-')[0];
    return folders.get(normalized) || (base === 'pt' ? 'pt-BR' : folders.get(base)) || 'en';
  };

  const choice = document.getElementById('catalogue-language-choice');
  const select = document.getElementById('catalogue-workbooks-locale');
  const link = document.getElementById('catalogue-workbooks-link');
  const language = document.getElementById('catalogue-workbooks-language');
  if (!choice || !select || !link || !language) return;

  const update = locale => {
    const folder = folderFor(locale);
    select.value = folder;
    link.href = `https://github.com/s243a/SciREPL-Catalog/tree/main/workbooks/${folder}`;
    language.textContent = select.selectedOptions[0].textContent;
    language.lang = folder;
  };
  update(document.documentElement.lang);
  select.addEventListener('change', () => update(select.value));
  choice.hidden = false;
})();
