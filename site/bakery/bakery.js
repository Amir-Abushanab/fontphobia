function updateComparisonLinks() {
  for (const link of document.querySelectorAll('[data-version-link]')) {
    const target = new URL(link.href);
    target.search = location.search;
    target.hash = location.hash;
    link.href = target.href;
  }
}

const menu = document.querySelector('#menu-items');
if (menu) {
  const search = document.querySelector('#menu-search');
  const vegan = document.querySelector('#vegan-only');
  const buttons = [...document.querySelectorAll('[data-category]')];
  const items = [...menu.querySelectorAll('.menu-item')];
  const status = document.querySelector('#menu-status');
  const normalize = (value) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const params = new URLSearchParams(location.search);
  search.value = (params.get('q') ?? '').slice(0, 100);
  vegan.checked = params.get('vegan') === '1';
  let category = ['bread', 'pastry', 'coffee'].includes(params.get('category')) ? params.get('category') : 'all';
  let announcement;
  function filter() {
    const query = normalize(search.value.trim());
    let count = 0;
    for (const item of items) {
      const visible = (category === 'all' || item.dataset.kind === category)
        && (!vegan.checked || item.dataset.vegan === 'true')
        && normalize(item.textContent).includes(query);
      item.hidden = !visible;
      if (visible) count++;
    }
    document.querySelector('#menu-empty').hidden = count !== 0;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.category === category));
    const url = new URL(location.href);
    for (const [key, value] of [['q', search.value.trim()], ['category', category === 'all' ? '' : category], ['vegan', vegan.checked ? '1' : '']]) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    history.replaceState(null, '', url);
    updateComparisonLinks();
    clearTimeout(announcement);
    announcement = setTimeout(() => { status.textContent = `${count} of ${items.length} items shown`; }, 200);
  }
  for (const button of buttons) button.addEventListener('click', () => {
    category = button.dataset.category;
    for (const other of buttons) other.setAttribute('aria-pressed', String(other === button));
    filter();
  });
  search.addEventListener('input', filter);
  vegan.addEventListener('change', filter);
  document.querySelector('#menu-tools').hidden = false;
  filter();
}

// Comparison links keep the current query string and hash when switching versions.
updateComparisonLinks();
