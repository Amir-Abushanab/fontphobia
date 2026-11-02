# Spike 6: Google Fonts axis-range URLs

Tested 2026-11-02 with Chrome 155 (headless, DSF 2, `pixelmatch` threshold 0). The latin slice of Inter v20 and Roboto Flex v30 was fetched with a Chrome 155 UA.

## Answer

- **Narrowing a range within an axis does nothing to the file Google normally serves.** `wght@400..700` returns the same bytes (same SHA-256) as `wght@100..900`, and `opsz,wght@16..24,400..700` the same bytes as `14..32,100..900`. Only the CSS `font-weight` descriptor changes. The file keeps the full `fvar` range, so rendering inside the range is identical, and there are no savings to measure.
- **Leaving an axis out of the URL pins it at its default.** That changes rendering. `Inter:wght@…` pins `opsz` at 14. At 16 px and 24 px with `font-optical-sizing: auto`, it differs from the full font by 7.8k–20.8k pixels. It is pixel-identical at 14 px, and with an explicit `'opsz' 14`. The same holds for Roboto Flex.
- **Pinning every axis (`wght@400`) gives a static instance.** It is pixel-identical to the variable file at 400.
- **The bytes are not deterministic.** Google sometimes (4 of ~70 requests for `Roboto+Flex:wght@400..700`) answers with a `fonts.gstatic.com/l/font?kit=…` URL instead of the usual `/s/robotoflex/v30/…` one. That file really is instanced: `fvar` is `wght 400..700`, 55.5 KB sfnt against 72.5 KB. Its advances differ slightly (16076 vs 16074.25 units for the test string at 550), and rendering differs by 8 px at 550 and 22 px at 700 (0 at 400). The same query can therefore render differently between page loads. This was never seen for Inter, which may already be cached at the edge.
- **`unicode-range` slicing doesn't change.** The subsets and `unicode-range` lists were identical across every query for each family.
- **Metrics don't change.** `hhea`, `OS/2` ascender/descender/lineGap, win metrics, `unitsPerEm`, glyph count and cmap are the same in every variant. None of the files have hinting tables (`fpgm`/`prep`/`cvt `).

## Evidence

| Query (latin slice) | sfnt bytes | `fvar` | Notes |
|---|---|---|---|
| `Inter:opsz,wght@14..32,100..900` | 168,892 | opsz 14..32, wght 100..900 | |
| `Inter:opsz,wght@16..24,400..700` | 168,892 | same | identical bytes to the row above |
| `Inter:wght@100..900` | 122,888 | wght 100..900 | opsz pinned at 14 |
| `Inter:wght@400..700` | 122,888 | wght 100..900 | identical bytes to the row above |
| `Inter:wght@400` | 66,892 | none | static |
| `Roboto+Flex:opsz,wght@8..144,100..1000` | 153,292 | opsz 8..144, wght 100..1000 | |
| `Roboto+Flex:wght@400..700` (`/s/`, ~95%) | 72,552 | wght 100..1000 | opsz pinned at 14 |
| `Roboto+Flex:wght@400..700` (`/l/font`, ~5%) | 55,512 | **wght 400..700** | instanced on the fly |

Pixel diffs are in `out/results.json`, and diff images for every non-zero case are in `out/`.

To reproduce:

```sh
pnpm install
node fetch.mjs            # downloads into fonts/, writes fonts/index.json
node fetch.mjs --refetch  # same URLs and bytes?
node analyze.mjs          # axes, avar, metrics, advances (wawoff2 → fontkit)
node render.mjs           # Chrome pixel diffs
```

`./variants.sh` (`N=40` by default) refetches each query and saves every distinct URL into `fonts/variants/`. `fonts/variants/flex-8f5f39e4.{css,url}` keeps the dynamic response from the original run. `render.mjs` expects the two Roboto Flex variant files named in it.

## Implications for the plan

- **§6.5 `google-fonts`: don't rewrite ranges within an axis.** It saves 0 bytes on the normal path and makes output depend on Google's cache state on the dynamic path. The only edits that save bytes are:
  - dropping an axis the site doesn't vary;
  - pinning axes to a single value;
  - the `text=` parameter (not tested here).
- **Dropping `opsz` is only safe if every use resolves to the axis default (14 for Inter and Roboto Flex),** or the site sets `font-optical-sizing: none`. Otherwise it is a visible regression. This ties to the §7.2 default-font-size sweep: if the sweep shows `opsz` outside {default}, the axis must stay in the URL.
- **`verify` against Google-hosted fonts can't treat the hosted file as stable.** Snapshot the exact downloaded bytes into the baseline (§10.3), or self-host. Recommend self-hosting (switching to the `css` adapter with downloaded files) when the user wants deterministic output. This supports the existing §6.5 recommendation and gives it a concrete reason.
- **§16:** mark spike 6 answered. The "inside the range is identical" premise only holds for the `/s/` files. Narrowing is a no-op there and nondeterministic on `/l/font`.

## Addendum: self-hosting savings (`selfhost.mjs` → `selfhost.txt`)

Google's own Latin files compared with fontphobia's output from the same file, for an English-only page:

| | Inter (`wght`) | Inter (`opsz`+`wght`) | Roboto Flex |
|---|---|---|---|
| Google's Latin file | 47.3 KB | 71.3 KB | 82.6 KB |
| Self-hosted, same characters | −7% | −6% | −6% |
| Self-hosted core file (ASCII + punctuation) | −44% | −41% | −43% |
| Core + `wght` limited to 400–700 | −59% | −58% | −60% |

Tightening the URL saves almost nothing. The savings come from self-hosting with the core split.
