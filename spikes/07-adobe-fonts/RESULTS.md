# Spike 7: Adobe Fonts kit management

Researched 2026-11-02. Ten public kits were sampled from GitHub code search; their CSS is in `samples/`.

## Answer

**There is a documented API, the Typekit API v1, and it is narrow.** It can create, update, publish and delete kits. Per kit it can set `name`, `domains`, `families`, and for each family `subset` (`"default"` or `"all"`) and `variations` (FVD codes such as `n4`, `i7`). It can't set:

- the **OpenType features** toggle;
- **language subsetting** (custom language character sets);
- **`font-display`**.

Those three are web-UI only (Edit Project). The API hasn't changed since 2011 and still answers at `https://typekit.com/api/v1/json`. Adobe documents it, but there is no newer replacement, no deprecation notice and no stated support commitment.

**Licensing rules out anything fontphobia normally does to the files.** Adobe Fonts can't be self-hosted, modified or uploaded elsewhere; they must be served from Adobe's CDN. So the adapter can never subset, instance or split. The only possible edits are kit settings on Adobe's side.

**Conclusion:** keep `adobe-fonts` report-only by default. An opt-in, token-authenticated `--apply-kit` is feasible for two things:

1. dropping unused `variations` (weights and styles);
2. switching `subset: "all"` → `"default"` when the measured usage fits the default character set.

Everything else (turning off OpenType features, a language subset, `font-display`) becomes advice telling the user which Adobe UI setting to change.

## Evidence

### API (fonts.adobe.com/docs/api)

- **Auth:** a user token from `fonts.adobe.com/account/tokens`, sent as the `X-Typekit-Token` header or `?token=`, over HTTPS only. Tokens act as the user, and there's no delegated/OAuth flow ("planned for the future"). Source: https://fonts.adobe.com/docs/api/auth
- **`POST /kits`** (create) takes `name`, `domains`, `families`, `segmented_css_names` and `analytics` (deprecated). Source: https://fonts.adobe.com/docs/api/v1/:format/kits
- **`GET|POST|DELETE /kits/:kit`** edits the _draft_. Any POSTed param "completely replaces the existing value", so `families` must be sent in full. Source: https://fonts.adobe.com/docs/api/v1/:format/kits/:kit
- **`POST /kits/:kit/families/:family`** takes `subset` ("default" or "all"; new families get "default") and `variations` (Font Variation Description list; default is all). Source: https://fonts.adobe.com/docs/api/v1/:format/kits/:kit/families/:family
- **`POST /kits/:kit/publish`** makes the draft live, and `GET /kits/:kit/published` reads the live version. Source: https://fonts.adobe.com/docs/api
- **Changelog:** last entry is 2011-09-12 (`analytics` deprecated). Source: https://fonts.adobe.com/docs/api/changelog
- **2021:** the `limits` endpoint was removed when plan limits went away. Adobe staff pointed integrators to fontintegrations@adobe.com. Source: https://community.adobe.com/t5/adobe-fonts-discussions/what-is-replacement-for-typekit-api-endpoint-quot-limits-quot/td-p/12137134

### UI-only settings (helpx)

- **Character set:** Default (EN/FR/DE/IT/PT/ES), All Characters, or Language Subsetting. East Asian fonts must use dynamic subsetting, which is the JS embed only. Source: https://helpx.adobe.com/ie/fonts/using/language-support-subsetting.html
- **OpenType features:** a per-project checkbox. Source: https://helpx.adobe.com/ee/fonts/using/use-open-type-features.html
- **`font-display`:** per family in Edit Project, default `auto`. Source: https://helpx.adobe.com/ie/fonts/using/font-display-settings.html
- **No self-hosting:** "Adobe doesn't offer the ability to host fonts locally", and the Terms of Use forbid self-hosting or uploading the files. Source: https://helpx.adobe.com/ee/fonts/web/font-licensing/webfont-licensing.html

### Kit CSS (`use.typekit.net/<kit>.css`, 10 kits)

- **Faces:** one `@font-face` per family × variation. Each has woff2, woff and opentype sources, `font-display:auto` (the default in all 10 kits), and explicit `font-weight`/`font-style`/`font-stretch`.
- **No `unicode-range` in any kit,** so every face downloads its whole character set the first time it's used.
- **No variable fonts** among the sampled kits. All are static instances.
- **Font URLs:** `use.typekit.net/af/<hash>/<font-id>/<rev>/l?primer=<hash>&fvd=<n4>&v=3`. The CSS and font files both returned 200 without a Referer.
- **`primer` encodes the character set and the features toggle.** `inspect-kit.mjs` decodes the fonts in memory only:
  - `7cdcb44b…` (most faces): Default set, cmap ≈ 216, full GSUB/GPOS. Adobe Garamond Pro has `liga`, `smcp`, `onum`, `swsh` and others.
  - `7fa3915b…` (Adobe Clean Serif in `ezf4sbn`): Default set, cmap 217, features `kern size` only. This is the "OpenType features" checkbox turned off, and it halves the file: ~28 KB against ~63 KB for sibling faces.
- **Faces are unhinted** (no `fpgm`/`prep`) in every sampled kit.
- **Each kit CSS `@import`s `p.typekit.net/p.css?...`,** a page-view beacon.

To reproduce: `pnpm install && node inspect-kit.mjs eny7olf ezf4sbn` (`FAMILY=adobe-clean-serif` filters to one family). Fonts are never written to disk.

## Implications for the plan

- **§6.6 stays report-only by default. Add an opt-in `--apply-kit`** (needs `TYPEKIT_TOKEN`):
  - it GETs the draft, writes the full previous `families` into the manifest for `revert`, POSTs the reduced `families`, then publishes;
  - it only removes unused `variations` and switches `all`→`default` when the measured usage ⊆ the Default set;
  - it needs a confirmation prompt, because the kit can be shared by other sites and pages the crawl didn't see. That's the same "domains" caveat as a CDN.
- **The report recommends UI changes that the API can't make:**
  - turn off OpenType features when usage needs none beyond `kern` (show the measured saving: in the sample, ~55% per face);
  - use Language Subsetting when usage fits a smaller set;
  - set `font-display` (shown as information only, since fontphobia keeps `font-display` unchanged).
- **The crawler (§7) should block `p.typekit.net`** so audit and verify runs don't add page views to the user's Adobe reporting.
- **§11 licensing:** Adobe Fonts files are never written to disk, including baselines. `verify` for this adapter compares live kit vs live kit after an `--apply-kit` change and holds the fonts in memory only.
- **§16:** mark spike 7 answered.
