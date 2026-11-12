// Regenerates the bundled CLDR data from cldr-misc-full and cldr-core (devDependencies, pinned):
// - src/data/cldr-delimiters.json: the four quotation marks per locale (§7.4 `<q>` rule);
// - src/data/cldr-exemplars.json: the characters each locale's text may use (§8.1 safety net):
//   main, auxiliary, punctuation and number exemplars, their uppercase and NFD parts, and the
//   symbol of the locale's current currency. A locale is stored only when it differs from its parent.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const req = createRequire(import.meta.url);
const root = join(dirname(req.resolve('cldr-misc-full/package.json')), 'main');
const core = dirname(req.resolve('cldr-core/package.json'));
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const version = json(join(root, '..', 'package.json')).version;
const locales = readdirSync(root).toSorted();

const quotes = {};
for (const loc of locales) {
  const d = json(join(root, loc, 'delimiters.json')).main[loc].delimiters;
  quotes[loc] = [d.quotationStart, d.quotationEnd, d.alternateQuotationStart, d.alternateQuotationEnd].join('');
}
writeFileSync(
  new URL('../src/data/cldr-delimiters.json', import.meta.url),
  JSON.stringify({ cldr: version, quotes }, null, 0) + '\n',
);

/** CLDR exemplar UnicodeSet syntax: [a b-d {ch} \- ‎]. */
function parseSet(s) {
  const out = new Set();
  if (!s) return out;
  const body = s.trim().replace(/^\[/, '').replace(/\]$/, '');
  const chars = [];
  for (let i = 0; i < body.length;) {
    const c = body[i];
    if (c === '\\') {
      const n = body[i + 1];
      if (n === 'u') {
        chars.push({ ch: String.fromCodePoint(parseInt(body.slice(i + 2, i + 6), 16)) });
        i += 6;
      } else if (n === 'U') {
        chars.push({ ch: String.fromCodePoint(parseInt(body.slice(i + 2, i + 10), 16)) });
        i += 10;
      } else {
        chars.push({ ch: String.fromCodePoint(body.codePointAt(i + 1)) });
        i += 1 + String.fromCodePoint(body.codePointAt(i + 1)).length;
      }
    } else if (c === '{') {
      const e = body.indexOf('}', i);
      chars.push({ ch: body.slice(i + 1, e) });
      i = e + 1;
    } else if (c === '-' && chars.length) {
      chars.push({ range: true });
      i++;
    } else if (/\s/.test(c)) i++;
    else {
      const ch = String.fromCodePoint(body.codePointAt(i));
      chars.push({ ch });
      i += ch.length;
    }
  }
  for (let k = 0; k < chars.length; k++) {
    const x = chars[k];
    if (x.range) continue;
    if (chars[k + 1]?.range && chars[k + 2]?.ch) {
      for (let cp = x.ch.codePointAt(0); cp <= chars[k + 2].ch.codePointAt(0); cp++) out.add(cp);
      k += 2;
    } else for (const ch of x.ch) out.add(ch.codePointAt(0));
  }
  return out;
}

const likely = json(join(core, 'supplemental/likelySubtags.json')).supplemental.likelySubtags;
const currencies = json(join(core, 'supplemental/currencyData.json')).supplemental.currencyData.region;
const parents = json(join(core, 'supplemental/parentLocales.json')).supplemental.parentLocales.parentLocale;
const regionOf = (loc) => {
  const m = loc.match(/-([A-Z]{2}|\d{3})(?:-|$)/);
  if (m) return m[1];
  const full = likely[loc] ?? likely[loc.split('-')[0]];
  return full?.match(/-([A-Z]{2}|\d{3})$/)?.[1];
};
const currencyOf = (region) => {
  for (const e of currencies[region] ?? []) {
    const [code, v] = Object.entries(e)[0];
    // eslint-disable-next-line no-underscore-dangle -- CLDR's own key names
    if (!v._to && v._tender !== 'false') return code;
  }
};

const sets = {};
for (const loc of locales) {
  const c = json(join(root, loc, 'characters.json')).main[loc].characters;
  const s = new Set();
  for (const k of ['exemplarCharacters', 'auxiliary', 'punctuation', 'numbers'])
    for (const cp of parseSet(c[k])) s.add(cp);
  // eslint-disable-next-line no-useless-spread -- a snapshot: the loop adds to the set
  for (const cp of [...s]) {
    const ch = String.fromCodePoint(cp);
    for (const x of [ch.toLocaleUpperCase(loc === 'root' ? undefined : loc), ch.normalize('NFD')])
      for (const y of x) s.add(y.codePointAt(0));
  }
  // CLDR uppercases ß to SS; German capital sharp s (ẞ, U+1E9E) is official since 2017.
  if (s.has(0xdf)) s.add(0x1e9e);
  const cur = currencyOf(regionOf(loc));
  if (cur && loc !== 'root') {
    for (const display of ['symbol', 'narrowSymbol']) {
      try {
        const txt = new Intl.NumberFormat(loc, { style: 'currency', currency: cur, currencyDisplay: display })
          .formatToParts(1)
          .filter((p) => p.type === 'currency')
          .map((p) => p.value)
          .join('');
        for (const ch of txt) s.add(ch.codePointAt(0));
      } catch {
        /* Node's ICU lacks this locale */
      }
    }
  }
  sets[loc] = [...s].filter((cp) => cp >= 0x20).toSorted((a, b) => a - b);
}

const ranges = (cps) => {
  const out = [];
  for (let i = 0; i < cps.length;) {
    let j = i;
    while (j + 1 < cps.length && cps[j + 1] === cps[j] + 1) j++;
    out.push(i === j ? cps[i].toString(16) : `${cps[i].toString(16)}-${cps[j].toString(16)}`);
    i = j + 1;
  }
  return out.join(',');
};
const parentOf = (loc) => parents[loc] ?? (loc.includes('-') ? loc.slice(0, loc.lastIndexOf('-')) : undefined);
// Distinct sets once; locales point at them by index.
const distinct = [];
const index = new Map();
const exemplars = {};
for (const loc of locales) {
  const r = ranges(sets[loc]);
  let p = parentOf(loc);
  while (p && !sets[p]) p = parentOf(p);
  if (p && p !== 'root' && ranges(sets[p]) === r) continue;
  if (!index.has(r)) {
    index.set(r, distinct.length);
    distinct.push(r);
  }
  exemplars[loc] = index.get(r);
}
const parentMap = Object.fromEntries(
  Object.entries(parents)
    .filter(([k]) => locales.includes(k))
    .toSorted(),
);
writeFileSync(
  new URL('../src/data/cldr-exemplars.json', import.meta.url),
  JSON.stringify({ cldr: version, parents: parentMap, sets: distinct, exemplars }, null, 0) + '\n',
);
console.log(locales.length, 'locales;', Object.keys(exemplars).length, 'stored;', distinct.length, 'distinct sets');
