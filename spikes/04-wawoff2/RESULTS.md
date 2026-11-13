# Spike 4: is the output byte-identical across OS, architecture and Node?

## Answer

**Yes, on everything tested.** Each environment produced 14 outputs: the decoded source, the HarfBuzz subset sfnt, the WOFF2 file and the WOFF2 round trip, for 3 fonts × 3–5 configs. They were byte-identical in all five environments:

| Platform                                     | Node    |
| -------------------------------------------- | ------- |
| darwin-arm64 (macOS 27)                      | 24.21.0 |
| linux-arm64 (Docker `node:24-bookworm-slim`) | 24.22.2 |
| linux-x64 (same image, emulated)             | 24.22.2 |
| linux-arm64 (`node:22-bookworm-slim`)        | 22.23.4 |
| linux-x64 (same, emulated)                   | 22.23.4 |

That's expected, since harfbuzzjs and wawoff2 are both pure WASM with no native code and no threads. Windows is untested here. The M1 "3 OSes" criterion needs a `windows-latest` CI run of `hash.mjs`.

## Two more findings

1. **Concurrent calls corrupt output** (wawoff2 2.0.1). `compress()`/`decompress()` resolve with a view into the WASM heap, so overlapping calls overwrite each other. `concurrency.mjs` reproduces it: `Promise.all` over three inputs returns two files with garbage signatures, and Chrome rejects them ("OTS parsing error: invalid sfntVersion"). Sequential calls are correct. `core` must put every wawoff2 call through one queue and copy each result (`slice()`) before starting the next.
2. **The WOFF2 round trip isn't byte-identical to the sfnt that went in.** `decompress(compress(x))` differs from `x`, because WOFF2 transforms `glyf`/`loca` and the rebuilt tables differ in padding and checksums. It's deterministic, though: the round-trip hash is the same on every platform. So font-level checks and HarfBuzz shaping checks must run on the **decoded WOFF2**, which is what browsers receive, not on the sfnt before compression.

## Files

- `hash.mjs`: prints hashes. Run it as `node 04-wawoff2/hash.mjs` from `spikes/`, or in Docker: `docker run --rm --platform linux/amd64 -v "$PWD":/w:ro -w /w node:22-bookworm-slim node 04-wawoff2/hash.mjs`.
- `hash-*.json`: the five results.
- `concurrency.mjs`: the corruption repro.

## Implications for the plan

- §4 determinism: confirmed for the font pipeline. Add a CI matrix (macOS, Linux and Windows; Node 22 and 24) that compares `hash.mjs` output, and add it to the M1 "done when".
- §9 build / §10.1–10.2: verify the decoded WOFF2, not the pre-compression sfnt.
- §14 stack, wawoff2 row: "Not safe to call concurrently. Serialize."
