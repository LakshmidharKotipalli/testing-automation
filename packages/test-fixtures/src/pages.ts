/**
 * Fixture site pages. Plain HTML with inline scripts; no external resources. Every page has semantic
 * roles/labels plus data-testid attributes so each locator strategy can be exercised.
 */

const nav = `<nav aria-label="Main"><a href="/">Home</a> | <a href="/login">Sign in</a> | <a href="/signup">Create account page</a> | <a href="/pricing">Pricing</a> | <a href="/a11y">Accessibility</a> | <a href="/flow/1">Long flow</a></nav>`;

export function layout(title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; }
  nav { margin-bottom: 16px; }
  form { display: grid; gap: 8px; max-width: 320px; }
  [role=alert] { color: #a00; }
  .error { color: #a00; font-size: 0.9em; }
</style>
${head}
</head>
<body>
<header>${nav}</header>
<main>
${body}
</main>
</body>
</html>`;
}

export const pages: Record<string, () => string> = {
  "/": () =>
    layout(
      "Fixture Home",
      `<h1>Fixture Shop</h1>
<p data-testid="welcome">Welcome to the BrowserSwarm fixture application.</p>
<ul>
  <li><a href="/login">Sign in</a></li>
  <li><a href="/pricing">See pricing</a></li>
  <li><a href="/external">External links</a></li>
  <li><a href="/catalog">Product catalog</a></li>
</ul>`,
    ),

  "/login": () =>
    layout(
      "Sign in",
      `<h1>Sign in</h1>
<form id="login" novalidate data-testid="login-form">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="off" data-testid="email">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="off" data-testid="password">
  <button type="submit">Sign in</button>
  <div id="login-error" data-testid="login-error"></div>
</form>
<script>
  // Safe, non-authenticating behavior: every attempt fails and the user stays on /login.
  document.getElementById('login').addEventListener('submit', function (e) {
    e.preventDefault();
    var box = document.getElementById('login-error');
    box.setAttribute('role', 'alert');
    box.textContent = 'Invalid email or password';
    history.replaceState(null, '', '/login?attempt=1');
  });
</script>`,
    ),

  "/signup": () =>
    layout(
      "Create account",
      `<h1>Create account</h1>
<form id="signup" novalidate data-testid="signup-form">
  <label for="su-name">Full name</label>
  <input id="su-name" name="name" required aria-describedby="su-name-err">
  <span id="su-name-err" class="error" data-testid="name-error"></span>
  <label for="su-email">Work email</label>
  <input id="su-email" name="email" type="email" required aria-describedby="su-email-err">
  <span id="su-email-err" class="error" data-testid="email-error"></span>
  <label><input type="checkbox" id="terms" name="terms"> I accept the terms</label>
  <button type="submit">Validate form</button>
</form>
<script>
  // Validation only: this fixture never creates accounts.
  document.getElementById('signup').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('su-name').value.trim();
    var email = document.getElementById('su-email').value.trim();
    document.getElementById('su-name-err').textContent = name ? '' : 'Name is required';
    document.getElementById('su-email-err').textContent = /.+@.+\\..+/.test(email) ? '' : 'Enter a valid email';
  });
</script>`,
    ),

  "/pricing": () =>
    layout(
      "Pricing",
      `<h1>Pricing</h1>
<section aria-label="Plans">
  <article data-testid="plan-free"><h2>Free</h2><p>$0 per month</p></article>
  <article data-testid="plan-pro"><h2>Pro</h2><p>$20 per month</p></article>
  <article data-testid="plan-team"><h2>Team</h2><p>$50 per month</p></article>
</section>
<label for="billing">Billing period</label>
<select id="billing"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>`,
    ),

  "/a11y": () =>
    layout(
      "Accessibility fixture",
      `<h1>Accessibility fixture</h1>
<button type="button" data-testid="accessible-control" aria-label="Open help">?</button>
<!-- Deliberately inaccessible: clickable div without role, name or keyboard support; input without label. -->
<div class="fake-button" data-testid="inaccessible-control" onclick="this.textContent='clicked'" style="cursor:pointer;background:#ddd;width:40px;height:20px"></div>
<input type="text" data-testid="unlabeled-input">`,
    ),

  "/overflow": () =>
    layout(
      "Overflow fixture",
      `<h1>Responsive overflow</h1>
<div data-testid="wide-banner" style="width:1200px;background:#eef">This banner is 1200px wide and overflows small viewports.</div>`,
    ),

  "/console-error": () =>
    layout(
      "Console error fixture",
      `<h1>Console error</h1><p>This page logs an error on load.</p>
<script>console.error('Fixture deliberate console error');</script>`,
    ),

  "/failed-resource": () =>
    layout(
      "Failed resource fixture",
      `<h1>Failed resource</h1><img src="/missing-image.png" alt="Missing image">`,
    ),

  "/risky": () =>
    layout(
      "Risky action fixture",
      `<h1>Account settings</h1>
<p>Test-only marker: the button below represents an irreversible action and must be blocked by policy.</p>
<button type="button" data-testid="delete-account" data-risky="true" onclick="document.getElementById('status').textContent='ACCOUNT DELETED'">Delete account</button>
<p id="status" role="status"></p>`,
    ),

  "/external": () =>
    layout(
      "External links",
      `<h1>External links</h1>
<a href="https://external.invalid/landing" data-testid="external-link">Partner site</a>`,
    ),

  "/whoami": () =>
    layout(
      "Who am I",
      `<h1>Session</h1>
<p>Cookie: <output data-testid="cookie-value" id="c"></output></p>
<button type="button" data-testid="set-marker" onclick="document.cookie='bs_' + (new URLSearchParams(location.search).get('m') || 'x') + '=1; path=/'; document.getElementById('c').textContent=document.cookie">Set marker</button>
<script>document.getElementById('c').textContent = document.cookie || '(none)';</script>`,
    ),
};

/**
 * Discovery fixture: a small catalog with safe structures (table, GET search, GET filter, tabs, details,
 * pagination, repeated values) and deliberately restricted controls (add to cart, delete, subscribe, a POST
 * newsletter form, an upload, a download, an external link) that discovery must record but never use.
 * Every restricted control targets /api/* or /files/*, which the server counts.
 */
export const catalogItems = [
  { id: 1, name: "Cordless Drill", price: "$89", stock: "In stock" },
  { id: 2, name: "Garden Hose", price: "$25", stock: "Low stock" },
  { id: 3, name: "Workbench", price: "$240", stock: "In stock" },
];

const catalogScripts = `<script>
  function post(path) { fetch(path, { method: 'POST', body: '{}' }).catch(function () {}); }
</script>`;

export function catalogPage(page: number): string {
  const rows = catalogItems
    .map(
      (i) =>
        `<tr><td><a href="/catalog/item/${i.id}">${i.name}</a></td><td>${i.price}</td><td>${i.stock}</td></tr>`,
    )
    .join("");
  return layout(
    "Product catalog",
    `<div id="cookie-banner" role="dialog" aria-label="Cookie consent"><p>We use cookies to improve the shop.</p>
  <button type="button" onclick="post('/api/consent-accept');this.parentNode.remove()">Accept all</button>
  <button type="button" onclick="this.parentNode.remove()">Reject all</button></div>
<h1>Product catalog</h1>
<p>Page ${page}. Browse our store of tools and garden products.</p>
<search><form role="search" method="get" action="/catalog/search" aria-label="Product search">
  <label for="q">Search products</label><input id="q" type="search" name="q">
  <button type="submit">Search</button>
</form></search>
<form method="get" action="/catalog" aria-label="Filter products">
  <label for="category">Category</label>
  <select id="category" name="category"><option value="tools">Tools</option><option value="garden">Garden</option></select>
  <button type="submit">Apply filter</button>
</form>
<table><caption>Products</caption><thead><tr><th>Name</th><th>Price</th><th>Stock</th></tr></thead><tbody>${rows}</tbody></table>
<dl><dt>Total products</dt><dd>3</dd></dl>
<div role="tablist" aria-label="Catalog details">
  <button role="tab" id="tab-overview" aria-selected="true" aria-controls="panel-overview">Overview</button>
  <button role="tab" id="tab-specs" aria-selected="false" aria-controls="panel-specs" onclick="document.getElementById('panel-specs').hidden=false;document.getElementById('panel-overview').hidden=true">Specifications</button>
</div>
<div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">Quality tools for every job.</div>
<div role="tabpanel" id="panel-specs" aria-labelledby="tab-specs" hidden>All products ship with a warranty.</div>
<details><summary>Shipping information</summary><p>Ships in two days.</p></details>
<nav aria-label="Pagination"><a href="/catalog?page=${page === 1 ? 2 : 1}">${page === 1 ? "Next" : "Previous"}</a></nav>
<section aria-label="Actions">
  <button type="button" data-testid="add-to-cart" onclick="post('/api/cart')">Add to cart</button>
  <button type="button" data-testid="delete-product" onclick="post('/api/delete')">Delete product</button>
  <button type="button" onclick="post('/api/subscribe')">Subscribe</button>
  <label for="photo">Upload photo</label><input id="photo" type="file">
  <a href="/files/catalog.pdf" download>Download catalog</a>
  <a href="https://external.invalid/partner">Partner store</a>
  <a href="/account/logout">Log out</a>
</section>
<form method="post" action="/api/newsletter" aria-label="Newsletter">
  <label for="nl-email">Email</label><input id="nl-email" type="email" name="email">
  <button type="submit">Sign me up</button>
</form>
<img src="/img/missing.png" alt="Promo banner">
${catalogScripts}
<script>console.error('Catalog widget failed to load');</script>`,
  );
}

export function catalogItemPage(id: number): string | undefined {
  const item = catalogItems.find((i) => i.id === id);
  if (!item) return undefined;
  return layout(
    item.name,
    `<h1>${item.name}</h1>
<dl><dt>Price</dt><dd>${item.price}</dd><dt>Total products</dt><dd>3</dd></dl>
<button type="button" onclick="post('/api/cart')">Add to cart</button>
<p><a href="/catalog">Back to catalog</a></p>
${catalogScripts}`,
  );
}

export function catalogSearchPage(q: string): string {
  const hits = catalogItems.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
  const list = (hits.length ? hits : catalogItems)
    .map((i) => `<li><a href="/catalog/item/${i.id}">${i.name}</a></li>`)
    .join("");
  return layout("Search results", `<h1>Search results</h1><p>${hits.length} result(s)</p><ul>${list}</ul>`);
}

/** Multi-step flow used to force context rotation with a low per-instance action limit. */
export function flowPage(step: number, total: number): string {
  const next =
    step < total
      ? `<a href="/flow/${step + 1}" data-testid="next">Next step</a>`
      : `<p data-testid="done">Flow complete</p>`;
  return layout(
    `Flow step ${step}`,
    `<h1>Flow step ${step} of ${total}</h1>
<label for="note-${step}">Note ${step}</label>
<input id="note-${step}" data-testid="note">
${next}`,
  );
}
