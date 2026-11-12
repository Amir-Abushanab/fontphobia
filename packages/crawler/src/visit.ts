// One page visit (URL × viewport × default font size): what Chrome drew, with which styles,
// which faces the CSSOM declares, and which font files downloaded (§7.3).
import type { BrowserContext, CDPSession } from 'playwright-core';
import {
  parseStylesheet,
  sha256,
  STYLE_PROPS,
  type CapturedFace,
  type CounterStyle,
  type DeclaredHit,
  type FontResponse,
  type Keyframes,
  type PlatformFontsHit,
  type Preload,
  type Run,
  type RunKind,
  type StyleRow,
  type Visit,
} from '@fontphobia/core';

export interface VisitOptions {
  viewport: number;
  height?: number;
  fontSize: number;
  textScale?: number;
  locales: string[];
  private?: boolean;
  timeoutMs?: number;
  /** Cap on CDP getPlatformFontsForNode calls per visit. */
  maxPlatformNodes?: number;
  /** Bodies already read in earlier visits, by URL and wire size: skips re-reading big font files. */
  bodyCache?: Map<string, { sha256: string; bytes: number }>;
}

export interface VisitResult {
  visit?: Visit;
  /**
   * Everything the page loaded that can change what it draws (HTML, CSS, scripts, fetch/XHR, fonts),
   * by URL and sha256, for the incremental audit's cache (M3.5). Undefined when a body couldn't be read.
   */
  resources?: { url: string; sha256: string; font?: boolean }[];
  status: number;
  finalUrl: string;
  links: string[];
  /** sha256 → bytes of every font file that downloaded. */
  bodies: Map<string, Uint8Array>;
  error?: string;
}

const FONT_EXT = /\.(woff2?|ttf|otf|eot)(?:[?#]|$)/i;
const PSEUDO_KIND: Record<string, RunKind> = {
  before: 'before',
  after: 'after',
  marker: 'marker',
  'first-letter': 'first-letter',
};

function dataUrlBytes(u: string): { mime: string; bytes: Uint8Array } | undefined {
  const m = u.match(/^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/is);
  if (!m) return undefined;
  const body = m[4]!;
  const bytes = m[3]
    ? Buffer.from(decodeURIComponent(body), 'base64')
    : Buffer.from(decodeURIComponent(body), 'latin1');
  return { mime: m[1] || 'application/octet-stream', bytes: new Uint8Array(bytes) };
}

export async function visitPage(context: BrowserContext, url: string, o: VisitOptions): Promise<VisitResult> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const bodies = new Map<string, Uint8Array>();
  try {
    return await run(page, cdp, url, o, bodies);
  } catch (e) {
    return { status: 0, finalUrl: url, links: [], bodies, error: (e as Error).message.split('\n')[0] };
  } finally {
    await cdp.detach().catch(() => {});
    await page.close().catch(() => {});
  }
}

type Page = Awaited<ReturnType<BrowserContext['newPage']>>;

async function run(
  page: Page,
  cdp: CDPSession,
  url: string,
  o: VisitOptions,
  bodies: Map<string, Uint8Array>,
): Promise<VisitResult> {
  const timeout = o.timeoutMs ?? 30_000;
  await page.setViewportSize({ width: o.viewport, height: o.height ?? 900 });

  // Network: every font request with bytes and initiator.
  type Req = {
    url: string;
    initiator?: string;
    status: number;
    mime?: string;
    transfer: number;
    done: boolean;
    font: boolean;
    type?: string;
  };
  const reqs = new Map<string, Req>();
  let inflightFonts = 0;
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', (e) => {
    const font = e.type === 'Font' || FONT_EXT.test(e.request.url);
    if (font) inflightFonts++;
    const init = e.initiator.url ?? e.initiator.stack?.callFrames?.[0]?.url;
    reqs.set(e.requestId, {
      url: e.request.url,
      initiator: init,
      status: 0,
      transfer: 0,
      done: false,
      font,
      type: e.type,
    });
  });
  cdp.on('Network.responseReceived', (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    r.status = e.response.status;
    r.mime = e.response.mimeType;
    if (e.type === 'Font' && !r.font) {
      r.font = true;
      inflightFonts++;
    }
    r.type ??= e.type;
  });
  const finish = (id: string, transfer: number) => {
    const r = reqs.get(id);
    if (r && !r.done) {
      r.done = true;
      r.transfer = transfer;
      if (r.font) inflightFonts--;
    }
  };
  cdp.on('Network.loadingFinished', (e) => finish(e.requestId, e.encodedDataLength));
  cdp.on('Network.loadingFailed', (e) => finish(e.requestId, 0));

  if (o.fontSize !== 16) await cdp.send('Page.setFontSizes', { fontSizes: { standard: o.fontSize } });
  if (o.textScale)
    await cdp
      .send('Emulation.setEmulatedOSTextScale' as 'Emulation.setPageScaleFactor', { scale: o.textScale } as never)
      .catch(() => {});

  // Adobe's font server counts page views; never add to them (§6.6).
  await page.route(/^https?:\/\/p\.typekit\.net\//, (r) => r.abort());

  const resp = await page.goto(url, { waitUntil: 'load', timeout });
  const status = resp?.status() ?? 0;
  const finalUrl = page.url();
  if (status >= 400 || !resp) return { status, finalUrl, links: [], bodies };
  const ct = resp.headers()['content-type'] ?? '';
  if (ct && !/html/i.test(ct)) return { status, finalUrl, links: [], bodies };

  // Font-size sweep visits only need sizes; lazy content was already scrolled into view at each viewport.
  await settle(page, () => inflightFonts, o.fontSize === 16 && !o.textScale);

  const origin = new URL(finalUrl).origin;
  await cdp.send('DOM.enable');
  const headers: {
    styleSheetId: string;
    sourceURL: string;
    isInline: boolean;
    isConstructed?: boolean;
    origin: string;
    frameId: string;
    ownerNode?: number;
  }[] = [];
  cdp.on('CSS.styleSheetAdded', (e) => headers.push(e.header));
  await cdp.send('CSS.enable');
  const tree = await cdp.send('Page.getFrameTree');
  const mainFrame = tree.frameTree.frame.id;

  // Stylesheets: @font-face, @font-feature-values, @counter-style, declared values.
  const faces: CapturedFace[] = [];
  const featureValues: Visit['featureValues'] = [];
  const counterStyles: CounterStyle[] = [];
  const keyframes: Keyframes[] = [];
  const declaredRules: { base: string; pseudo?: string; origin: string; decls: Record<string, string> }[] = [];
  const textTransforms: { selector: string; value: string }[] = [];
  const firstLine = new Set<string>();
  let emMediaQueries = false;
  const notes: string[] = [];
  const dataFonts: FontResponse[] = [];
  for (const h of headers) {
    if (h.origin !== 'regular' || h.frameId !== mainFrame) continue;
    let text: string;
    try {
      text = (await cdp.send('CSS.getStyleSheetText', { styleSheetId: h.styleSheetId })).text;
    } catch {
      continue;
    }
    const sheet = parseStylesheet(text);
    if (sheet.errors.length) notes.push(`CSS parse error in ${h.sourceURL || 'inline <style>'}: ${sheet.errors[0]}`);
    const inline = h.isInline || h.isConstructed || !h.sourceURL || h.sourceURL === finalUrl;
    const base = h.sourceURL && /^https?:/.test(h.sourceURL) ? h.sourceURL : finalUrl;
    for (const f of sheet.fontFaces) {
      const urls: string[] = [];
      for (const s of f.src) {
        if (s.url === undefined) continue;
        if (s.url.startsWith('data:')) {
          const d = dataUrlBytes(s.url);
          if (!d) continue;
          const sha = sha256(d.bytes);
          const pseudo = `data:${d.mime};sha256,${sha}`;
          bodies.set(sha, d.bytes);
          dataFonts.push({
            url: pseudo,
            status: 200,
            bytes: d.bytes.byteLength,
            transfer: 0,
            sha256: sha,
            mime: d.mime,
            initiator: inline ? 'inline' : h.sourceURL,
          });
          urls.push(pseudo);
        } else {
          try {
            urls.push(new URL(s.url, base).href);
          } catch {
            /* unresolvable */
          }
        }
      }
      // Don't keep data URIs in the descriptors (they can be megabytes).
      const descriptors = { ...f.descriptors };
      if (descriptors.src?.includes('data:'))
        descriptors.src = descriptors.src.replace(/url\(\s*["']?data:[^)]*\)/gi, 'url(data:…)');
      faces.push({ ...f, descriptors, sheet: inline ? 'inline' : h.sourceURL, urls });
    }
    for (const [fam, byType] of sheet.featureValues)
      for (const [t, m] of byType) for (const [n, v] of m) featureValues.push([fam, t, n, v]);
    counterStyles.push(...sheet.counterStyles);
    keyframes.push(...sheet.keyframes);
    for (const t of sheet.textTransforms) textTransforms.push(t);
    for (const s of sheet.firstLine) firstLine.add(s);
    if (sheet.emMediaQueries) emMediaQueries = true;
    for (const r of sheet.declared) {
      const animated = 'animation' in r.decls || 'animation-name' in r.decls;
      for (const s of r.selectors) {
        if (
          s.pseudo === '::selection' ||
          s.pseudo === '::backdrop' ||
          s.pseudo === '::first-line' ||
          s.pseudo === '::placeholder'
        )
          continue;
        // Rules that apply now are already in the computed styles and the layout text.
        const originLabel = [...s.states, ...r.wrappers.filter((w) => /^@(media|container)\b/i.test(w))].join(' ');
        if (!originLabel && !animated) continue;
        // A rule that applies now only contributes its animation; its font values are already computed.
        declaredRules.push({
          base: s.base,
          pseudo: s.pseudo,
          origin: originLabel,
          decls: originLabel ? r.decls : { animation: r.decls.animation ?? r.decls['animation-name']! },
        });
      }
    }
  }

  // DOMSnapshot: the layout text and its computed styles.
  const snap = await cdp.send('DOMSnapshot.captureSnapshot', {
    computedStyles: [...STYLE_PROPS],
    includeDOMRects: false,
  });
  const S = snap.strings;
  const str = (i: number | undefined) => (i !== undefined && i >= 0 ? S[i]! : '');
  if (snap.documents.length > 1) notes.push(`${snap.documents.length - 1} iframe document(s) not audited`);
  const doc = snap.documents[0]!;
  const n = doc.nodes;
  const L = doc.layout;
  const parent = n.parentIndex!;
  const nodeName = (i: number) => str(n.nodeName![i]);
  const backend = n.backendNodeId!;
  const pseudoOf = new Map<number, string>(
    (n.pseudoType?.index ?? []).map((idx, k) => [idx, str(n.pseudoType!.value[k])]),
  );
  const attrs = (i: number) => {
    const a = n.attributes?.[i] ?? [];
    const m = new Map<string, string>();
    for (let k = 0; k < a.length; k += 2) m.set(str(a[k]).toLowerCase(), str(a[k + 1]));
    return m;
  };
  const styles: StyleRow[] = [];
  const styleIndex = new Map<string, number>();
  const intern = (row: StyleRow) => {
    const k = row.join('\u0001');
    let i = styleIndex.get(k);
    if (i === undefined) {
      i = styles.length;
      styles.push(row);
      styleIndex.set(k, i);
    }
    return i;
  };
  const layoutOf = new Map<number, number>();
  L.nodeIndex.forEach((ni, li) => {
    if (!layoutOf.has(ni)) layoutOf.set(ni, li);
  });
  const rowAt = (li: number): StyleRow => (L.styles[li] ?? []).map((si) => str(si));
  const TO = STYLE_PROPS.indexOf('text-overflow'),
    LC = STYLE_PROPS.indexOf('-webkit-line-clamp');
  const hasEllipsis = (row: StyleRow) =>
    /ellipsis|["']/.test(row[TO] ?? '') || ((row[LC] ?? 'none') !== 'none' && row[LC] !== '');

  const runs: Run[] = [];
  /** Backend ids of the element chain of each run (owner first). */
  const chains: number[][] = [];
  const pseudoOwner: (number | undefined)[] = [];
  const editableCache = new Map<number, boolean>();
  const isEditable = (i: number): boolean => {
    if (i < 0) return false;
    let v = editableCache.get(i);
    if (v !== undefined) return v;
    const ce = attrs(i).get('contenteditable');
    v = ce !== undefined && ce !== 'false' ? true : ce === 'false' ? false : isEditable(parent[i]!);
    editableCache.set(i, v);
    return v;
  };
  L.nodeIndex.forEach((ni, li) => {
    const text = str(L.text[li]);
    if (!text || (/^[\s]*$/.test(text) && !/[  -​  　]/.test(text))) return;
    let kind: RunKind = 'text';
    let q = false;
    let ellipsis: number | undefined;
    const chain: number[] = [];
    let owner: number | undefined;
    for (let i = ni; i >= 0; i = parent[i]!) {
      const p = pseudoOf.get(i);
      if (p && kind === 'text' && PSEUDO_KIND[p]) {
        kind = PSEUDO_KIND[p]!;
        owner = backend[parent[i]!];
      }
      if (n.nodeType![i] === 1 && !pseudoOf.has(i)) {
        chain.push(backend[i]!);
        if (nodeName(i) === 'Q') q = true;
        if (ellipsis === undefined && i !== ni) {
          const lj = layoutOf.get(i);
          if (lj !== undefined) {
            const row = rowAt(lj);
            if (hasEllipsis(row)) ellipsis = intern(row);
          }
        }
      }
    }
    const r: Run = { text, style: intern(rowAt(li)), kind };
    if (q) r.q = true;
    if (ellipsis !== undefined) r.ellipsis = ellipsis;
    if (isEditable(ni)) r.editable = true;
    runs.push(r);
    chains.push(chain);
    pseudoOwner.push(owner);
  });

  // DOM node ids for CDP calls that need them.
  const docNode = (await cdp.send('DOM.getDocument', { depth: -1, pierce: false })).root.nodeId;
  const owners = [...new Set(chains.map((c) => c[0]).filter((x): x is number => x !== undefined))];
  const maxNodes = o.maxPlatformNodes ?? 3000;
  if (owners.length > maxNodes)
    notes.push(`platform font cross-check limited to ${maxNodes} of ${owners.length} elements`);
  const sample = owners.slice(0, maxNodes);
  const { nodeIds } = sample.length
    ? await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: sample })
    : { nodeIds: [] as number[] };
  const nodeOfBackend = new Map(sample.map((b, i) => [b, nodeIds[i]!]));
  const backendOfNode = new Map(sample.map((b, i) => [nodeIds[i]!, b]));

  // Platform fonts per owning element (§7.3 step 2).
  const runsByOwner = new Map<number, number[]>();
  chains.forEach((c, ri) => {
    const b = c[0];
    if (b !== undefined) runsByOwner.set(b, [...(runsByOwner.get(b) ?? []), ri]);
  });
  const platform: PlatformFontsHit[] = [];
  for (let i = 0; i < sample.length; i += 50) {
    await Promise.all(
      sample.slice(i, i + 50).map(async (b) => {
        const nodeId = nodeOfBackend.get(b);
        if (!nodeId) return;
        try {
          const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
          platform.push({
            runs: runsByOwner.get(b) ?? [],
            fonts: fonts.map((f) => ({
              family: f.familyName,
              postscript: f.postScriptName,
              custom: f.isCustomFont,
              glyphs: f.glyphCount,
            })),
          });
        } catch {
          /* node went away */
        }
      }),
    );
  }
  platform.sort((a, b) => (a.runs[0] ?? 0) - (b.runs[0] ?? 0));

  // Declared values: which runs each rule's (state-stripped) selector reaches (§7.5).
  const declared: DeclaredHit[] = [];
  const selectorCache = new Map<string, Set<number> | null>();
  const matchBackend = async (sel: string): Promise<Set<number> | null> => {
    if (selectorCache.has(sel)) return selectorCache.get(sel)!;
    let out: Set<number> | null = null;
    try {
      const { nodeIds: ids } = await cdp.send('DOM.querySelectorAll', { nodeId: docNode, selector: sel });
      if (ids.length) {
        const missing = ids.filter((id) => !backendOfNode.has(id));
        for (const id of missing.slice(0, 2000)) {
          try {
            const d = await cdp.send('DOM.describeNode', { nodeId: id });
            backendOfNode.set(id, d.node.backendNodeId);
          } catch {
            /* gone */
          }
        }
        out = new Set(ids.map((id) => backendOfNode.get(id)).filter((x): x is number => x !== undefined));
      }
    } catch {
      /* invalid in this engine */
    }
    selectorCache.set(sel, out);
    return out;
  };
  let checked = 0;
  for (const r of declaredRules) {
    if (++checked > 2000) {
      notes.push('declared-value scan stopped after 2000 selectors');
      break;
    }
    const hit = await matchBackend(r.base);
    if (!hit?.size) continue;
    const ris: number[] = [];
    runs.forEach((piece, ri) => {
      if (r.pseudo) {
        const want = r.pseudo.replace(/^::/, '');
        if (piece.kind === want && pseudoOwner[ri] !== undefined && hit.has(pseudoOwner[ri]!)) ris.push(ri);
      } else if (chains[ri]!.some((b) => hit.has(b))) ris.push(ri);
    });
    if (ris.length) declared.push({ runs: ris, decls: r.decls, origin: r.origin });
  }

  // In-page: form controls, ::first-line, full-width transforms, preloads, links, locales.
  const inPage = await page.evaluate(collectInPage, {
    props: [...STYLE_PROPS],
    firstLine: [...firstLine],
    textTransforms,
    locales: o.locales,
  });
  for (const c of inPage.controls) {
    const r: Run = { text: c.text, style: intern(c.style), kind: c.kind as RunKind };
    if (c.inputType) r.inputType = c.inputType;
    if (c.editable) r.editable = true;
    runs.push(r);
  }

  // Font bodies, before the page closes.
  // eslint-disable-next-line no-unmodified-loop-condition -- the response handlers change inflightFonts while this waits
  for (let i = 0; i < 200 && inflightFonts > 0; i++) await page.waitForTimeout(25);
  const fonts: FontResponse[] = [...dataFonts];
  for (const [id, r] of reqs) {
    if (!r.font || r.url.startsWith('data:')) continue;
    const f: FontResponse = {
      url: r.url,
      status: r.status,
      bytes: 0,
      transfer: r.transfer,
      mime: r.mime,
      initiator: r.initiator,
    };
    const cached = o.bodyCache?.get(`${r.url} ${r.transfer}`);
    if (r.done && r.status >= 200 && r.status < 400 && cached) {
      f.sha256 = cached.sha256;
      f.bytes = cached.bytes;
    } else if (r.done && r.status >= 200 && r.status < 400) {
      try {
        const b = await cdp.send('Network.getResponseBody', { requestId: id });
        const bytes = new Uint8Array(Buffer.from(b.body, b.base64Encoded ? 'base64' : 'utf8'));
        f.bytes = bytes.byteLength;
        f.sha256 = sha256(bytes);
        bodies.set(f.sha256, bytes);
        o.bodyCache?.set(`${r.url} ${r.transfer}`, { sha256: f.sha256, bytes: f.bytes });
      } catch {
        /* evicted */
      }
    }
    fonts.push(f);
  }
  fonts.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  // What the page loaded, hashed, for the visit cache (M3.5). One unreadable body: not cacheable.
  let resources: VisitResult['resources'] = [];
  const CONTENT = new Set(['Document', 'Stylesheet', 'Script', 'XHR', 'Fetch']);
  for (const [id, r] of reqs) {
    if (!resources || r.url.startsWith('data:') || r.url.startsWith('blob:')) continue;
    if (r.font) {
      const f = fonts.find((x) => x.url === r.url);
      if (f?.sha256) resources.push({ url: r.url, sha256: f.sha256, font: true });
      else if (r.done && r.status >= 400) resources.push({ url: r.url, sha256: `http-${r.status}`, font: true });
      else resources = undefined;
      continue;
    }
    if (!CONTENT.has(r.type ?? '')) continue;
    if (!r.done) {
      resources = undefined;
      continue;
    }
    if (r.status >= 400) {
      resources.push({ url: r.url, sha256: `http-${r.status}` });
      continue;
    }
    try {
      const b = await cdp.send('Network.getResponseBody', { requestId: id });
      resources.push({
        url: r.url,
        sha256: sha256(new Uint8Array(Buffer.from(b.body, b.base64Encoded ? 'base64' : 'utf8'))),
      });
    } catch {
      resources = undefined;
    }
  }
  resources?.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  const visit: Visit = {
    page: pageKey(finalUrl),
    url: finalUrl,
    viewport: o.viewport,
    fontSize: o.fontSize,
    textScale: o.textScale,
    private: o.private,
    styles,
    runs,
    declared,
    faces,
    featureValues,
    counterStyles,
    keyframes,
    fonts,
    preloads: inPage.preloads as Preload[],
    platform,
    locales: inPage.locales,
    lang: inPage.lang || undefined,
    emMediaQueries,
    textScaleMeta: inPage.textScaleMeta,
    notes,
  };
  const links = inPage.links.filter((l) => {
    try {
      return new URL(l).origin === origin;
    } catch {
      return false;
    }
  });
  return { visit, status, finalUrl, links, bodies, resources: o.private ? undefined : resources };
}

export const pageKey = (u: string): string => {
  const x = new URL(u);
  return x.pathname + x.search;
};

/** The base URL's path with a trailing slash: "/" for a site served at the origin's root. */
const basePathOf = (base: string) => new URL(base).pathname.replace(/\/?$/, '/');
const pathOnly = (p: string) => p.replace(/[?#].*$/s, '');
/** A pathname at the base path or under it (else it belongs to another site on the origin). */
export const underBase = (pathname: string, base: string): boolean =>
  (pathOnly(pathname) + '/').startsWith(basePathOf(base));

/**
 * A page key or seed (`pathname + search`) as a URL on the site at `base`. A path that already starts
 * with the base path is taken as it is; any other is relative to the site's root, so it goes under
 * the base path ("/" → the base itself). Set as a path, never parsed as a reference: `/Special:x`
 * and `//host/x` stay on the base's origin.
 */
export function pageUrl(p: string, base: string): string {
  const prefix = basePathOf(base);
  const [, path = '', search = ''] = /^([^?#]*)(\?[^#]*)?/.exec(p)!;
  const abs = '/' + path.replace(/^[/\\]+/, '');
  const u = new URL(new URL(base).origin);
  u.pathname = underBase(abs, base) ? abs : prefix + abs.slice(1);
  u.search = search;
  return u.href;
}

/** A page key relative to the site's root: the base path stripped when the key has it ("/sub/a/" → "/a/" at /sub/). */
export function sitePath(p: string, base: string): string {
  const prefix = basePathOf(base);
  if (prefix === '/' || !underBase(p, base)) return p;
  const rest = p.slice(prefix.length - 1);
  return rest.startsWith('/') ? rest : '/' + rest;
}

/** Page globs (`pages`, `ignore`, `auth.pages`) match a key by its full pathname or its path under the base. */
export const matchesPage = (globs: RegExp[], p: string, base: string): boolean =>
  globs.some((r) => r.test(p) || r.test(sitePath(p, base)));

/** Wait for fonts and lazy content: fonts.ready, a scroll through the page, then no font requests in flight. */
async function settle(page: Page, inflight: () => number, scroll: boolean) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => {});
  if (scroll)
    await page
      .evaluate(async () => {
        const h = () => document.documentElement.scrollHeight;
        for (let y = 0, i = 0; y < h() && i < 12; y += innerHeight, i++) {
          scrollTo(0, y);
          await new Promise((r) => requestAnimationFrame(() => r(null)));
        }
        scrollTo(0, 0);
      })
      .catch(() => {});
  await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => {});
  // Animations would make computed weights depend on timing; keyframes are covered as declared values.
  await page
    .evaluate(() => {
      for (const a of document.getAnimations()) {
        try {
          a.pause();
          a.currentTime = 0;
        } catch {
          /* finished */
        }
      }
    })
    .catch(() => {});
  // No font request in flight for two consecutive checks (5 s at most).
  let quiet = inflight() > 0 ? 0 : 1;
  for (let i = 0; i < 200 && quiet < 2; i++) {
    await new Promise((r) => setTimeout(r, 25));
    quiet = inflight() > 0 ? 0 : quiet + 1;
  }
}

/** Runs in the page. Keep it self-contained: Playwright serializes the function source. */
function collectInPage(a: {
  props: string[];
  firstLine: string[];
  textTransforms: { selector: string; value: string }[];
  locales: string[];
}) {
  const row = (el: Element, pseudo?: string) => {
    const cs = getComputedStyle(el, pseudo);
    return a.props.map((p) => cs.getPropertyValue(p));
  };
  const controls: { text: string; style: string[]; kind: string; inputType?: string; editable?: boolean }[] = [];
  const TEXTUAL = new Set([
    'text',
    'search',
    'email',
    'url',
    'tel',
    'number',
    'date',
    'time',
    'datetime-local',
    'month',
    'week',
    '',
  ]);
  for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
    const st = getComputedStyle(el);
    if (st.display === 'none') continue;
    if (el instanceof HTMLInputElement) {
      const t = el.type.toLowerCase();
      if (t === 'password') controls.push({ text: '', style: row(el), kind: 'password', inputType: t, editable: true });
      else if (t === 'submit' || t === 'button' || t === 'reset')
        controls.push({
          text: el.value || (t === 'reset' ? 'Reset' : t === 'submit' ? 'Submit' : ''),
          style: row(el),
          kind: 'value',
          inputType: t,
        });
      else if (TEXTUAL.has(t))
        controls.push({
          text: el.value,
          style: row(el),
          kind: 'value',
          inputType: t,
          editable: !el.readOnly && !el.disabled,
        });
      else continue;
      if (el.placeholder)
        controls.push({ text: el.placeholder, style: row(el, '::placeholder'), kind: 'placeholder', inputType: t });
    } else if (el instanceof HTMLTextAreaElement) {
      controls.push({ text: el.value, style: row(el), kind: 'textarea', editable: !el.readOnly && !el.disabled });
      if (el.placeholder) controls.push({ text: el.placeholder, style: row(el, '::placeholder'), kind: 'placeholder' });
    } else if (el instanceof HTMLSelectElement) {
      for (const opt of Array.from(el.options)) controls.push({ text: opt.text, style: row(opt), kind: 'option' });
    }
  }
  for (const sel of a.firstLine) {
    let els: Element[] = [];
    try {
      els = Array.from(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of els) {
      const t = (el as HTMLElement).innerText ?? el.textContent ?? '';
      if (t.trim()) controls.push({ text: t, style: row(el, '::first-line'), kind: 'first-line' });
    }
  }
  for (const tt of a.textTransforms) {
    let els: Element[] = [];
    try {
      els = Array.from(document.querySelectorAll(tt.selector));
    } catch {
      continue;
    }
    for (const el of els) controls.push({ text: (el as HTMLElement).innerText ?? '', style: row(el), kind: tt.value });
  }
  for (const el of Array.from(document.querySelectorAll('[style*="full-width"], [style*="full-size-kana"]'))) {
    const v = el.getAttribute('style') ?? '';
    controls.push({
      text: (el as HTMLElement).innerText ?? '',
      style: row(el),
      kind: v.includes('full-width') ? 'full-width' : 'full-size-kana',
    });
  }
  const preloads = Array.from(document.querySelectorAll('link[rel~="preload" i]'))
    .filter((l) => {
      const as = (l.getAttribute('as') ?? '').toLowerCase();
      return as === 'font' || /\.(woff2?|ttf|otf)(\?|#|$)/i.test((l as HTMLLinkElement).href);
    })
    .map((l) => ({
      href: (l as HTMLLinkElement).href,
      crossorigin: l.getAttribute('crossorigin'),
      type: l.getAttribute('type') ?? undefined,
      media: l.getAttribute('media') ?? undefined,
    }));
  const links = Array.from(document.querySelectorAll('a[href]'))
    .map((x) => {
      try {
        const u = new URL((x as HTMLAnchorElement).href);
        u.hash = '';
        return u.href;
      } catch {
        return '';
      }
    })
    .filter((u) => /^https?:/.test(u));
  const lang = document.documentElement.lang;
  const langs = new Set(
    [...a.locales, ...Array.from(document.querySelectorAll('[lang]')).map((e) => e.getAttribute('lang') ?? '')].filter(
      Boolean,
    ),
  );
  const locales: Record<string, string> = {};
  const when = new Date(Date.UTC(2026, 10, 2, 13, 45, 30));
  for (const l of langs) {
    try {
      const s = [
        new Intl.NumberFormat(l, { useGrouping: false }).format(1234567890),
        new Intl.NumberFormat(l).format(-1234567.891),
        new Intl.NumberFormat(l, { style: 'percent' }).format(0.5),
        new Intl.DateTimeFormat(l, { dateStyle: 'short', timeStyle: 'short' }).format(when),
        new Intl.DateTimeFormat(l, { dateStyle: 'medium' }).format(when),
        new Intl.DateTimeFormat(l, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(when),
      ].join('');
      locales[l] = Array.from(new Set(Array.from(s)))
        .toSorted()
        .join('');
    } catch {
      /* unsupported locale tag */
    }
  }
  return {
    controls,
    preloads,
    links: Array.from(new Set(links)),
    lang,
    locales,
    textScaleMeta: !!document.querySelector('meta[name="text-scale" i]'),
  };
}
