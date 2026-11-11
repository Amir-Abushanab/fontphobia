const root = document.querySelector('#font-demo');
const message = document.querySelector('#demo-message');
const assetBase = new URL('.', document.currentScript.src);

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const contains = (ranges, cp) => ranges.some(([start, end]) => cp >= start && cp <= end);
const code = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
const name = (ch) => ch === ' ' ? 'space' : ch === '\n' ? 'line break' : ch;
const presets = {
  plain: 'Fresh bread, slowly.',
  accents: 'Crème brûlée tart €4.80',
  greek: 'Καλημέρα',
  fallback: 'Bread 🍞',
};

async function init() {
  const { faces } = JSON.parse(document.querySelector('#font-data').textContent);
  const text = root.querySelector('#demo-text');
  const familyInputs = [...root.querySelectorAll('[name="demo-family"]')];
  const route = root.querySelector('#demo-route');
  const summary = root.querySelector('#demo-summary');
  const fallback = root.querySelector('#demo-fallback');
  const comparison = root.querySelector('#demo-comparison');
  const compareStatus = root.querySelector('#compare-status');
  const previews = root.querySelector('#compare-previews');
  const original = root.querySelector('#preview-original');
  const split = root.querySelector('#preview-split');
  const weight = root.querySelector('#demo-weight');
  const size = root.querySelector('#demo-size');
  const loaded = new Map();
  let announcement;
  let comparisonVersion = 0;
  const selectedFace = () => faces.find((f) => f.family === familyInputs.find((input) => input.checked).value);

  // A source glyph can be present in several files as a hint reference. Route using the
  // manifest's CSS ranges, never the outputs' cmaps, and check source coverage first.
  function roleOf(face, ch) {
    const cp = ch.codePointAt(0);
    if (ch === '\n' || ch === '\r' || ch === '\t') return 'whitespace';
    if (!contains(face.source.ranges, cp)) return 'fallback';
    return face.outputs.find((output) => contains(output.ranges, cp))?.role ?? 'fallback';
  }

  function updatePreviews() {
    for (const preview of [original, split]) {
      preview.textContent = text.value;
      preview.style.fontWeight = weight.value;
      preview.style.fontSize = `${size.value}px`;
    }
    root.querySelector('#weight-value').textContent = weight.value;
    root.querySelector('#size-value').textContent = `${size.value} px`;
    size.setAttribute('aria-valuetext', `${size.value} pixels`);
  }

  async function compare() {
    const version = ++comparisonVersion;
    previews.hidden = true;
    if (!comparison.open) return;
    const face = selectedFace();
    compareStatus.textContent = `Loading the original ${face.family} (${kb(face.source.bytes)})…`;
    try {
      if (!loaded.has(face.family)) {
        const font = new FontFace(`${face.family} Original`, `url("${new URL(face.source.url, assetBase)}")`, { weight: '100 900', style: 'normal', display: 'swap' });
        const promise = font.load().then((font) => { document.fonts.add(font); return font; });
        loaded.set(face.family, promise);
        promise.catch(() => loaded.delete(face.family));
      }
      await loaded.get(face.family);
      await document.fonts.load(`${weight.value} ${size.value}px "${face.family}"`, text.value);
      if (version !== comparisonVersion || !comparison.open) return;
      original.style.fontFamily = `"${face.family} Original", system-ui`;
      split.style.fontFamily = `"${face.family}", system-ui`;
      updatePreviews();
      previews.hidden = false;
      compareStatus.textContent = `Both rows use ${face.family}. Change the weight or size to compare spacing and line breaks.`;
    } catch {
      if (version !== comparisonVersion) return;
      compareStatus.textContent = 'The font could not be loaded. Close and reopen the comparison to try again.';
    }
  }

  function update() {
    const face = selectedFace();
    const chars = [...text.value];
    const hasText = chars.some((ch) => ch !== '\n' && ch !== '\r' && ch !== '\t');
    const groups = new Map(['core', 'ext', 'rest', 'fallback', 'whitespace'].map((role) => [role, new Set()]));
    route.replaceChildren();
    route.style.fontFamily = `"${face.family}", system-ui`;
    for (const ch of chars) {
      const role = roleOf(face, ch);
      groups.get(role).add(ch);
      const chip = document.createElement('span');
      chip.className = { core: 'k', ext: 'x', rest: 'r', fallback: 'f', whitespace: 'sp' }[role];
      chip.textContent = /\s/.test(ch) ? '·' : ch;
      chip.title = `${name(ch)} · ${code(ch)} · ${role === 'ext' ? 'extended' : role}`;
      route.append(chip);
    }
    let bytes = 0;
    let files = 0;
    for (const output of face.outputs) {
      // Core has no unicode-range: the browser checks its cmap before trying the
      // ranged files or a system fallback, even when none of these glyphs is in core.
      const needed = (output.role === 'core' && hasText) || groups.get(output.role).size > 0;
      const card = root.querySelector(`[data-file="${output.role}"]`);
      card.dataset.needed = String(needed);
      card.querySelector('.file-size').textContent = kb(output.bytes);
      card.querySelector('.file-state').textContent = needed ? 'Needed' : 'Not needed';
      card.querySelector('.file-chars').textContent = groups.get(output.role).size ? [...groups.get(output.role)].map(name).join(' ') : needed ? 'The browser checks core first.' : 'No characters from this file.';
      if (needed) { bytes += output.bytes; files++; }
    }
    const before = hasText ? face.source.bytes : 0;
    const scale = Math.max(before, bytes, 1);
    root.querySelector('#demo-before').textContent = kb(before);
    root.querySelector('#demo-after').textContent = kb(bytes);
    root.querySelector('#demo-before-bar').style.width = `${before / scale * 100}%`;
    root.querySelector('#demo-after-bar').style.width = `${bytes / scale * 100}%`;
    const difference = before ? `${Math.abs(Math.round((1 - bytes / before) * 100))}% ${bytes <= before ? 'less' : 'more'}` : 'No font files needed';
    const result = `${files} ${files === 1 ? 'file' : 'files'} · ${kb(bytes)}${before ? ` · ${difference}` : ''}`;
    root.querySelector('#demo-total').textContent = result;
    fallback.hidden = groups.get('fallback').size === 0;
    fallback.textContent = fallback.hidden ? '' : `${[...groups.get('fallback')].map((ch) => `${ch} (${code(ch)})`).join(', ')}: not in the original ${face.family} font. Both versions use a fallback for these characters.`;
    clearTimeout(announcement);
    announcement = setTimeout(() => {
      summary.textContent = `${face.family}: ${result}. ${fallback.textContent}`;
    }, 400);
    updatePreviews();
    if (comparison.open) compare();
  }

  text.addEventListener('input', () => {
    root.querySelectorAll('[data-sample]').forEach((button) => button.setAttribute('aria-pressed', 'false'));
    update();
  });
  familyInputs.forEach((input) => input.addEventListener('change', update));
  root.querySelectorAll('[data-sample]').forEach((button) => button.addEventListener('click', () => {
    text.value = presets[button.dataset.sample];
    root.querySelectorAll('[data-sample]').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
    update();
  }));
  comparison.addEventListener('toggle', compare);
  for (const slider of [weight, size]) slider.addEventListener('input', updatePreviews);
  update();
  root.hidden = false;
  message.hidden = true;
}

init().catch(() => {
  message.textContent = 'The font playground could not start. Reload to try again.';
  message.hidden = false;
});
