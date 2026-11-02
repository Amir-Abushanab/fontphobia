// Spike 1: which rendered characters DOMSnapshot's layout text captures, per construct.
// For every element with id="t-*": DOM text vs layout text (all layout objects under it,
// including pseudo-elements and shadow trees), plus CSS.getPlatformFontsForNode.
import { launch } from '../lib/browser.mjs';

const browser = await launch();
const page = await browser.newPage();
await page.goto(new URL('./page.html', import.meta.url).href);
await page.evaluate(() => document.fonts.ready);
const cdp = await page.context().newCDPSession(page);
await cdp.send('DOM.enable');
await cdp.send('CSS.enable');

const snap = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: ['font-family', 'text-transform', 'font-variant-caps'], includeDOMRects: true });
const S = snap.strings;
const str = (i) => (i >= 0 ? S[i] : '');

const rows = new Map();
for (const doc of snap.documents) {
  const n = doc.nodes;
  const idOf = new Map();
  n.attributes.forEach((attrs, i) => {
    for (let k = 0; k < attrs.length; k += 2) if (str(attrs[k]) === 'id' && str(attrs[k + 1]).startsWith('t-')) idOf.set(i, str(attrs[k + 1]));
  });
  const owner = (i) => { while (i >= 0) { if (idOf.has(i)) return idOf.get(i); i = n.parentIndex[i]; } return null; };
  const pseudo = new Map((n.pseudoType?.index ?? []).map((idx, k) => [idx, str(n.pseudoType.value[k])]));
  const shadow = new Map((n.shadowRootType?.index ?? []).map((idx, k) => [idx, str(n.shadowRootType.value[k])]));
  const ancestorsTag = (i) => { const t = []; while (i >= 0) { if (pseudo.has(i)) t.push('::' + pseudo.get(i)); if (shadow.has(i)) t.push('#shadow-' + shadow.get(i)); i = n.parentIndex[i]; } return t; };
  // DOM text
  n.nodeType.forEach((type, i) => {
    if (type !== 3) return;
    const id = owner(i); if (!id) return;
    const r = rows.get(id) ?? { dom: '', layout: [], fonts: null }; rows.set(id, r);
    r.dom += str(n.nodeValue[i]);
  });
  // Layout text
  const L = doc.layout;
  L.nodeIndex.forEach((ni, li) => {
    const t = str(L.text[li]); if (!t) return;
    const id = owner(ni); if (!id) return;
    const r = rows.get(id) ?? { dom: '', layout: [], fonts: null }; rows.set(id, r);
    const tags = ancestorsTag(ni);
    r.layout.push(tags.length ? `${t} [${tags.join(' ')}]` : t);
  });
  // text boxes count per layout node (rendered runs)
  doc.textBoxes.layoutIndex.forEach((li) => {
    const id = owner(L.nodeIndex[li]); if (id) { const r = rows.get(id); r.boxes = (r.boxes ?? 0) + 1; }
  });
}

// Platform fonts (what Chrome actually used, with glyph counts)
const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
for (const id of rows.keys()) {
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#${id}` });
  if (!nodeId) continue;
  try {
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    rows.get(id).fonts = fonts.map((f) => `${f.familyName}${f.isCustomFont ? '*' : ''}:${f.glyphCount}`).join(', ');
  } catch (e) { rows.get(id).fonts = 'ERR ' + e.message; }
}

// Shadow root text isn't in the light-DOM owner chain for closed roots? Report what we got.
console.log('chrome', browser.version(), ' documents', snap.documents.length);
for (const [id, r] of rows) {
  console.log(`\n${id}  boxes=${r.boxes ?? 0}  fonts=${r.fonts}`);
  console.log('  dom    :', JSON.stringify(r.dom));
  console.log('  layout :', JSON.stringify(r.layout));
}
await browser.close();
