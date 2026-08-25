import type { FoundingTier } from "../db/client";

/**
 * HTML responses for the no-JS Founding form (site/pricing.html posts here as
 * application/x-www-form-urlencoded; CSP `script-src 'none'` rules out a fetch()).
 * The happy path 303-redirects to the static thank-you on the site; these render
 * only the failure surfaces. Today's callers pass a fixed literal or the validated
 * `FoundingTier` enum, but everything interpolated is HTML-escaped anyway so no
 * future caller can turn `message`/`tier` into a reflected-XSS sink.
 */

const SITE = "https://bemlembrado.com";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ESC[c] ?? c);

function page(title: string, heading: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title} · BemLembrado</title>
<style>
  /* light-mode only — single committed theme (product decision 2026-08-20) */
  :root{--bg:#f7f9fc;--card:#fff;--border:#dfe6f0;--fg:#10151f;--fg-soft:#4a5568;--accent:#0d9488}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);line-height:1.6;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
  .wrap{max-width:560px;margin:0 auto;padding:96px 20px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:32px}
  h1{font-size:1.5rem;letter-spacing:-.02em;margin:0 0 12px;text-wrap:balance}
  p{color:var(--fg-soft);margin:0 0 18px}
  a{color:var(--accent);font-weight:600}
</style>
</head>
<body>
  <div class="wrap"><div class="card">
    <h1>${heading}</h1>
    ${body}
    <p><a href="${SITE}/pricing.html">← Back to pricing</a></p>
  </div></div>
</body>
</html>`;
}

export function renderFoundingError(message: string): string {
  return page("We couldn't register that", "We couldn't register that", `<p>${esc(message)}</p>`);
}

export function renderFoundingFull(tier: FoundingTier): string {
  return page(
    "That tier is full",
    "That founding tier is full",
    `<p>The <strong>${esc(tier)}</strong> founding tier has reached its cap. Other tiers may still have seats — take a look and reserve one.</p>`,
  );
}

export const FOUNDING_THANKS_URL = `${SITE}/founding/obrigado.html`;
