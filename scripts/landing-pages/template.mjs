// Renders one guide page from a JSON config (scripts/landing-pages/*.json).
// Text fields are HTML-escaped; `code` spans and [links](url) are the only
// inline markup, so page configs cannot inject arbitrary HTML.

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|#[\w-]+|\.{0,2}\/[^)\s]*)\)/g, '<a href="$2">$1</a>');
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// The referrer is itself a query string, so it is serialised with
// URLSearchParams first and then encoded as one value of the outer URL.
function playHref(base, ref) {
  const query = new URLSearchParams(UTM_KEYS.filter((k) => ref[k]).map((k) => [k, ref[k]])).toString();
  return query ? `${base}&referrer=${encodeURIComponent(query)}` : base;
}

function playLink(page, edition, cls, label) {
  const base = page.play[edition];
  return `<a class="${cls}" href="${esc(playHref(base, page.play.referrer))}">${esc(label)}</a>`;
}

const ctaRow = (page) => `<div class="cta-row">
          ${playLink(page, 'pro', 'btn btn-primary', page.play.proLabel)}
          ${playLink(page, 'free', 'btn btn-secondary', page.play.freeLabel)}
        </div>`;

function phone(img, assetBase, eager = false) {
  return `<figure>
          <div class="phone"><img src="${assetBase}${esc(img.src)}" width="${img.width}" height="${img.height}" alt="${esc(img.alt)}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'}></div>
          ${img.caption ? `<figcaption>${inline(img.caption)}</figcaption>` : ''}
        </figure>`;
}

function codeBlock(lang, label, code) {
  return `<div class="code">
            <div class="code-label lang-${esc(lang)}"><span>${esc(label)}</span><button type="button" class="copy-btn" hidden>Copy</button></div>
            <pre><code>${esc(code)}</code></pre>
          </div>`;
}

// An example is one code block (`code`) or several cells (`cells`), each
// with its own Copy button, so code meant for separate cells is never
// copied, pasted and run as one cell.
function exampleCells(it) {
  if (!it.cells) return [{ label: it.langLabel, code: it.code }];
  return it.cells.map((code, i) => ({ label: `${it.langLabel} · CELL ${i + 1}`, code }));
}

const renderers = {
  cards: (s) => `<div class="grid">
        ${s.items.map((it) => `<div class="card"><h3>${inline(it.title)}</h3><p>${inline(it.body)}</p></div>`).join('\n        ')}
      </div>`,

  examples: (s, page, assetBase) => s.items.map((it) => `<div class="example${it.image ? '' : ' example-text'}">
        <div>
          <h3>${inline(it.title)}</h3>
          <p>${inline(it.body)}</p>
          ${exampleCells(it).map((c) => codeBlock(it.lang, c.label, c.code)).join('\n          ')}
          ${it.note ? `<p>${inline(it.note)}</p>` : ''}
        </div>
        ${it.image ? phone(it.image, assetBase) : ''}
      </div>`).join('\n      '),

  checks: (s) => `<ul class="checks">
        ${s.items.map((it) => `<li>${inline(it)}</li>`).join('\n        ')}
      </ul>`,

  limits: (s) => `<ul class="checks limits">
        ${s.items.map((it) => `<li>${inline(it)}</li>`).join('\n        ')}
      </ul>`,

  steps: (s) => `<ol class="steps">
        ${s.items.map((it) => `<li>${inline(it)}</li>`).join('\n        ')}
      </ol>`,

  table: (s) => {
    const cell = (v) => {
      const cls = v.startsWith('Yes') ? ' class="yes"' : v === '—' ? ' class="no"' : '';
      return `<td${cls}>${inline(v)}</td>`;
    };
    return `<div class="table-scroll"><table>
        <thead><tr>${s.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>
          ${s.rows.map(([label, ...vals]) => `<tr><th scope="row">${inline(label)}</th>${vals.map(cell).join('')}</tr>`).join('\n          ')}
        </tbody>
      </table></div>`;
  },
};

function section(s, page, assetBase) {
  const body = renderers[s.type];
  if (!body) throw new Error(`${page.slug}: unknown section type "${s.type}"`);
  return `<section id="${esc(s.id)}">
    <div class="wrap">
      <h2>${inline(s.heading)}</h2>
      ${s.lede ? `<p class="section-lede">${inline(s.lede)}</p>` : ''}
      ${body(s, page, assetBase)}
    </div>
  </section>`;
}

// Reveals the Copy buttons when the Clipboard API is available. The page
// never reads its own URL or changes links: every visitor, ad click or not,
// gets the same HTML and the same Play links with the page's fixed referrer.
const PAGE_SCRIPT = `(function () {
  if (navigator.clipboard) {
    document.querySelectorAll('.copy-btn').forEach(function (btn) {
      btn.hidden = false;
      btn.addEventListener('click', function () {
        var code = btn.closest('.code').querySelector('pre').textContent;
        navigator.clipboard.writeText(code).then(function () {
          btn.textContent = 'Copied';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
        });
      });
    });
  }
})();`;

export function renderPage(page) {
  const assetBase = '../assets/';
  const canonical = `${page.siteBase}${page.slug}/`;
  const ogImage = `${page.siteBase}assets/${page.ogImage}`;
  const nav = page.sections.filter((s) => s.nav);
  const analytics = page.analytics && page.analytics.cloudflareToken
    ? `\n  <script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='${esc(JSON.stringify({ token: page.analytics.cloudflareToken }))}'></script>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(page.title)}</title>
  <meta name="description" content="${esc(page.metaDescription)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta name="theme-color" content="#0d1117">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231f6feb'/%3E%3Ctext x='16' y='22' font-family='monospace' font-size='16' font-weight='700' fill='white' text-anchor='middle'%3E%E2%88%91%3C/text%3E%3C/svg%3E">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(page.title)}">
  <meta property="og:description" content="${esc(page.metaDescription)}">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:image" content="${esc(ogImage)}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="stylesheet" href="${assetBase}landing.css">${analytics}
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="wrap">
      <a class="brand" href="${esc(page.brandHref)}">SciREPL</a>
      <nav class="site-nav" aria-label="On this page">
        ${nav.map((s) => `<a href="#${esc(s.id)}">${esc(s.nav)}</a>`).join('\n        ')}
      </nav>
      ${playLink(page, 'pro', 'btn btn-primary btn-small header-cta', page.play.headerLabel)}
    </div>
  </header>

  <main id="main">
  <section class="hero" aria-labelledby="page-title">
    <div class="wrap">
      <div>
        <p class="eyebrow">${inline(page.eyebrow)}</p>
        <h1 id="page-title">${inline(page.h1)}</h1>
        <p class="lede">${inline(page.lede)}</p>
        ${ctaRow(page)}
        <p class="fineprint">${inline(page.fineprint)}</p>
        <ul class="chips" aria-label="Highlights">
          ${page.chips.map((c) => `<li>${esc(c)}</li>`).join('\n          ')}
        </ul>
      </div>
      ${phone(page.hero, assetBase, true)}
    </div>
  </section>

  ${page.sections.map((s) => section(s, page, assetBase)).join('\n\n  ')}

  <section class="closing" aria-labelledby="closing-title">
    <div class="wrap">
      <h2 id="closing-title">${inline(page.closing.heading)}</h2>
      <p class="section-lede" style="margin-inline:auto">${inline(page.closing.body)}</p>
      ${ctaRow(page)}
    </div>
  </section>
  </main>

  <footer class="site-footer">
    <div class="wrap">
      <nav aria-label="Footer">
        ${page.footer.links.map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join('\n        ')}
      </nav>
      <p>${inline(page.footer.note)}</p>
    </div>
  </footer>
  <script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}
