# Spike 12: other ways to send less of a font

November 2026. harfbuzzjs 1.6.4, Node 26.13.1, macOS arm64. Fonts: Inter 4.1 `InterVariable.ttf` (variable, unhinted, kerned across scripts) and DejaVu Sans 2.37 (static, hinted). No browser ran in any of this.

The question: fontphobia cuts a font into a core, an extended and a rest file. Is there a more basic way to send a page only the part of a font it needs? Three things were tried. The scripts are not kept; the method is described under each.

## Answers

1. **Incremental font transfer (IFT) is the standard for this, and no browser ships it.** It is a W3C Candidate Recommendation draft (18 November 2025). Chrome's implementation was not behind a flag as of July 2026. Its files can be made and checked outside a browser today.
2. **On small, mostly Latin sites, IFT downloads more than today's files.** 41% to 73% more on three test sites (part C).
3. **More than one extended file saves little.** About 5% where some pages use symbols, 16% in one case, nothing otherwise, and each new file costs 8 to 13 KB before it holds anything (part B).
4. **Two changes came out of it and are in the planner** (part A): the core choice prices candidates by compressed size, and it runs again after the shaping repair.

## A. What changed in the planner

**Compressed sizes.** The automatic core choice compared uncompressed subsets, on the assumption that both files shrink by the same ratio. They do not: on Inter, core goes from 49% to 44% of its uncompressed size as it grows, and the extended file from 47% to 57%. Candidates are now compressed with Brotli at quality 5 (`compressedSize`).

| Size used to compare candidates | Ratio to the WOFF2 size (Inter) | Time per file |
| ------------------------------- | ------------------------------- | ------------- |
| Uncompressed subset             | 1.75× to 2.27×                  | ~3 ms         |
| Brotli quality 5, `node:zlib`   | 1.16× to 1.18×                  | ~3 ms         |
| zlib deflate level 6 (fflate)   | 1.19× to 1.26×                  | ~4 ms         |
| WOFF2                           | exact                           | ~420 ms       |

- Node's Brotli gave byte-identical sizes on Node 22.23 (Brotli 1.1.0), 24.22 and 26.13 (Brotli 1.2.1) for 24 subsets at qualities 4, 5, 6 and 9. A test holds two sizes to exact byte counts, so a Node release that changes them fails CI.
- A vendored encoder (`brotli-wasm` 3.0.1) was tried and removed. It tracked WOFF2 as well on Inter (1.3% spread) and worse on DejaVu Sans (3.4%), and added a 1 MB file to the package.

**Choosing core after the repair.** The planner chose core, then ran the shaping repair. On a 48-page site with four Greek and four Russian pages, the choice added nothing, the repair moved most Greek and Cyrillic letters into core anyway (Inter kerns them with the space and punctuation), and 11 used letters stayed in the extended file. Eight pages loaded 73.2 KB for them. The planner now chooses again from the repaired core, repairs what that adds, and repeats until the repair adds nothing: mean 70.8 KB → 60.0 KB per page, worst page 131.8 KB → 60.0 KB.

## B. Several extended files instead of one

The idea is from the W3C IFT encoder, which starts from many small segments and merges two when the expected download falls, charging a fixed cost per request.

**Method.** Five made-up sites of 48 to 68 pages, each page 4 to 6 sentences of its language (nine languages, seeded). Start from the smallest core the planner allows. Group the remaining used characters by the exact set of pages that draw them. Join the groups a word spans when it shapes differently split (`checkShaping` with all files). Then merge while the total falls: two slices that share a page, or a slice into core, at 200 bytes a request and 60 bytes per extra `@font-face` rule on every page. Sizes are real WOFF2 with the planner's options and references.

Mean font bytes per page. "Two files" is the planner after the changes in part A.

| Site                                 | Inter, two files | Inter, sliced | DejaVu, two files | DejaVu, sliced |
| ------------------------------------ | ---------------- | ------------- | ----------------- | -------------- |
| English, symbols on 12 of 50 pages   | 47.1 KB          | 44.6 KB       | 17.7 KB           | 16.6 KB        |
| English, foreign names on 8 of 50    | 45.6 KB          | 45.3 KB       | 17.2 KB           | 16.9 KB        |
| Docs in five Latin-script languages  | 45.6 KB          | 45.6 KB       | 17.3 KB           | 17.3 KB        |
| English, 4 Greek and 4 Russian of 48 | 60.0 KB          | 60.0 KB       | 20.6 KB           | 17.2 KB        |
| Four scripts in equal parts          | 64.7 KB          | 64.7 KB       | 23.1 KB           | 23.1 KB        |

- **A file has a floor, and most of it is the hinting references.** A file that serves ↑ and ↓ alone is 13.5 KB in Inter (3.1 KB without the hinting references) and 8.0 KB in DejaVu Sans (4.0 KB without).
- **The shaping repair decides most of the split before any cost does.** In Inter nearly every used letter of every script ends up in core, which leaves symbols and a few stray letters to slice. DejaVu Sans has no such kerning for Greek and Cyrillic, so each script became its own 11 KB file and those pages stopped loading a 31.7 KB extended file.
- **The request cost matters only at the margin.** It moved a result by at most 1.5 points.
- **Slicing can raise the worst page.** DejaVu, symbols site: mean 17.7 KB → 16.6 KB, worst page 17.7 KB → 24.2 KB.

Not built. It would be worth another look for a real site with a second script on a font that does not kern it with punctuation, or if `drop-hint-refs` became common.

## C. IFT output

**Method.** w3c/ift-encoder at c0ed516 (2026-11-06) and the fontations client `ift_extend` at f95a2db (`incremental-font-transfer` 0.6.0). The font was encoded twice per site: with the encoder's own settings, which know nothing of the site, and with the planner's core as the initial font (`--auto_config_default_codepoints`). Per page, `ift_extend` ran on the page's characters; the bytes are the initial font plus the patches it fetched, and the font it wrote was shaped against the original.

Mean font bytes per page, Inter:

| Site                                | Two files | IFT     | IFT, the planner's core as the initial font |
| ----------------------------------- | --------- | ------- | ------------------------------------------- |
| English, symbols on 12 of 50 pages  | 47.1 KB   | 72.6 KB | 66.4 KB                                     |
| English, foreign names on 8 of 50   | 45.6 KB   | 70.2 KB | 74.3 KB                                     |
| Docs in five Latin-script languages | 45.6 KB   | 78.7 KB | 72.0 KB                                     |

- **Shaping was identical.** 0 words differed on all three sites with either encoding.
- **The initial font is the cost.** 53.8 KB with the encoder's settings and 65 to 74 KB with the planner's core, where the planner's own core file is about 45 KB. What the difference is made of was not found; the patch map for some 2,900 patches and the tables that table-keyed patches extend are the candidates.
- **Fetches.** 4 to 8 a page with the encoder's settings, in one round trip.
- **Encoding is slow and large.** About 5 minutes per font, 2,900 files and 43 MB per encoding. The builds and four encodings took about 11 GB of disk, and the run stopped after three sites when the disk filled.

Building it: the encoder builds with Bazel (`bazel build -c opt //util:font2ift`, about 3 minutes). `ift_extend` does not build through the encoder's Bazel setup on macOS arm64; `cargo build --release -p incremental-font-transfer --bin ift_extend --all-features` in a fontations checkout at the pinned commit does. `ift_extend --unicodes` takes decimal code points.

## Limits

- The sites are made up: one weight, text from a small pool of sentences.
- IFT was run with default quality and no tuning, on small Latin sites. It is designed for large fonts (CJK, many scripts), where a page uses a small part of a file measured in megabytes; nothing here tests that.
- Not run: IFT on the two multi-script sites or on DejaVu Sans, and anything in a browser.

## Not tried

- **Frequency data for the safety net.** The encoder's code point frequency tables (w3c/ift-encoder-data) could rank the characters no page uses yet, so the likely ones stay in the extended file and the rest go to the rest file. Today that boundary is a CLDR list.
- **The encoder's `UNICODE_RANGE` target mode**, which makes its segmenter plan `unicode-range` files.
