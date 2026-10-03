/* ============================================================
   Global Estates — frontend (no secrets here; all data via /api)
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ksh = (n) => 'KSh ' + Number(n || 0).toLocaleString('en-KE');
const todayISO = () => new Date().toISOString().slice(0, 10);
const deviceId = () => {
  let d = localStorage.getItem('ge_device');
  if (!d) { d = (crypto.randomUUID ? crypto.randomUUID() : 'd' + Date.now() + Math.random().toString(16).slice(2)); localStorage.setItem('ge_device', d); }
  return d;
};
const CATEGORIES = ['Rent', 'Vacation', 'Outings', 'Land'];
const CAT_META = {
  Rent:     { unit: '/month',     icon: '🏠', blurb: 'Houses & apartments for long-term living' },
  Vacation: { unit: '/night',     icon: '🌴', blurb: 'Short stays, villas & getaway homes' },
  Outings:  { unit: '/experience',icon: '🧭', blurb: 'Experiences, tours & venues' },
  Land:     { unit: ' total',     icon: '🗺️', blurb: 'Plots & land for sale, inquiry-based' },
};
const COUNTRIES = ['Kenya','Uganda','Tanzania','Rwanda','Nigeria','Ghana','South Africa','United States','United Kingdom','Canada','Australia','United Arab Emirates','Germany','France','Italy','Spain','India','Indonesia','Brazil','Mexico','Japan','China','Egypt','Morocco','Netherlands','Portugal','Greece','Switzerland','Sweden','New Zealand','Singapore','Thailand','Vietnam','Philippines','Colombia','Argentina','Chile','Peru','Ireland','Poland','Turkey','Saudi Arabia','Qatar','Ethiopia','Zimbabwe','Zambia','Botswana','Senegal'];

/* ---------------- API client ---------------- */
async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) { const t = localStorage.getItem('ge_token'); if (t) headers['Authorization'] = 'Bearer ' + t; }
  let res;
  try { res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('Network error. Please check your connection and try again.'); }
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401 && auth) clearSession();
    const err = new Error((data && data.error) || `Request failed (${res.status}). Please try again.`);
    err.status = res.status; err.data = data; throw err;
  }
  return data;
}

/* ---------------- Session ---------------- */
const getUser = () => { try { return JSON.parse(localStorage.getItem('ge_user')); } catch { return null; } };
const getToken = () => localStorage.getItem('ge_token');
function setSession(token, user) { localStorage.setItem('ge_token', token); localStorage.setItem('ge_user', JSON.stringify(user)); renderAuthArea(); }
function clearSession() { localStorage.removeItem('ge_token'); localStorage.removeItem('ge_user'); renderAuthArea(); }

/* ---------------- Toasts ---------------- */
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'error' ? 'error' : type === 'info' ? 'info' : '');
  el.textContent = msg;
  $('#toastRoot').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 4200);
}

/* ---------------- Modal system ---------------- */
let modalCleanup = null;
function openModal(html, onMount) {
  closeModal();
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-backdrop" id="modalBackdrop"><div class="modal ${html.wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html.body || html}</div></div>`;
  const close = () => closeModal();
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') close(); });
  document.addEventListener('keydown', escClose);
  function escClose(e) { if (e.key === 'Escape') close(); document.removeEventListener('keydown', escClose); }
  modalCleanup = () => document.removeEventListener('keydown', escClose);
  if (onMount) onMount($('.modal', root));
}
function closeModal() { $('#modalRoot').innerHTML = ''; if (modalCleanup) { modalCleanup(); modalCleanup = null; } }

/* ---------------- Favorites ---------------- */
let favSet = new Set();
async function loadFavorites() {
  try { const r = await api(`/api/favorites?device=${encodeURIComponent(deviceId())}`); favSet = new Set(r.properties.map(p => p.id)); } catch {}
}
async function toggleFav(id, btn) {
  const active = favSet.has(id);
  try {
    if (active) { await api(`/api/favorites?device=${encodeURIComponent(deviceId())}&propertyId=${id}`, { method: 'DELETE' }); favSet.delete(id); }
    else { await api('/api/favorites', { method: 'POST', body: { device: deviceId(), propertyId: id } }); favSet.add(id); }
    if (btn) btn.classList.toggle('active', !active);
    toast(active ? 'Removed from saved properties.' : 'Saved to your favorites.', 'info');
    if (location.hash.startsWith('#/saved')) route();
  } catch (e) { toast(e.message, 'error'); }
}

/* ---------------- Shared renderers ---------------- */
function propertyCard(p) {
  const img = (p.images && p.images[0]) || 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?auto=format&fit=crop&w=900&q=60';
  const meta = CAT_META[p.category] || { unit: '' };
  const bits = [];
  if (p.bedrooms > 0) bits.push(`${p.bedrooms} bd`);
  if (p.guests > 0) bits.push(`${p.guests} guests`);
  if (p.land_size) bits.push(p.land_size);
  return `
  <article class="card" data-id="${p.id}" role="button" tabindex="0" aria-label="View ${esc(p.title)}">
    <div class="card-img">
      <img src="${esc(img)}" alt="${esc(p.title)}" loading="lazy" onerror="this.style.display='none'">
      <span class="badge badge-cat">${esc(p.category)}</span>
      ${p.listing_plan !== 'free' ? `<span class="badge badge-plan ${p.listing_plan}">${p.listing_plan === 'premium' ? '★ Premium' : 'Featured'}</span>` : ''}
      <button class="fav-btn ${favSet.has(p.id) ? 'active' : ''}" data-fav="${p.id}" aria-label="Save property">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
      </button>
    </div>
    <div class="card-body">
      <div class="card-title">${esc(p.title)}</div>
      <div class="card-loc">📍 ${esc(p.location)}, ${esc(p.country)}</div>
      ${bits.length ? `<div class="card-meta">${bits.map(b => `<span>${esc(b)}</span>`).join('')}</div>` : ''}
      <div class="card-price"><b>${ksh(p.price)}</b><span>${p.category === 'Land' ? '' : meta.unit}</span></div>
    </div>
  </article>`;
}
function skeletons(n = 6) {
  return `<div class="grid grid-cards">${Array.from({ length: n }, () =>
    `<div class="skeleton"><div class="sk-img"></div><div class="sk-line" style="width:75%"></div><div class="sk-line" style="width:50%"></div></div>`).join('')}</div>`;
}
function emptyState(title, sub, actionLabel, actionHash) {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(sub)}</p>
    ${actionLabel ? `<br><a class="btn btn-outline" href="${actionHash}" style="margin-top:.6rem">${esc(actionLabel)}</a>` : ''}</div>`;
}
function bindGrid(container) {
  container.addEventListener('click', (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) { e.stopPropagation(); toggleFav(Number(fav.dataset.fav), fav); return; }
    const card = e.target.closest('.card[data-id]');
    if (card) location.hash = `#/property/${card.dataset.id}`;
  });
  container.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const card = e.target.closest('.card[data-id]'); if (card) location.hash = `#/property/${card.dataset.id}`; }
  });
}

/* ============================================================
   ROUTER
   ============================================================ */
function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const seg = pathPart.split('/').filter(Boolean);
  const q = new URLSearchParams(queryPart || '');
  window.scrollTo(0, 0);
  $('#mainNav').classList.remove('open');
  $('#burgerBtn').setAttribute('aria-expanded', 'false');
  $$('.main-nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#/' + raw.split('?')[0]));
  const view = seg[0] || 'home';
  if (view === 'home') renderHome();
  else if (view === 'browse') renderBrowse(q);
  else if (view === 'property' && seg[1]) renderProperty(Number(seg[1]));
  else if (view === 'dashboard') renderDashboard(q);
  else if (view === 'saved') renderSaved();
  else if (view === 'checkout') renderCheckout(q);
  else renderHome();
}

/* ---------------- Header / nav ---------------- */
function renderAuthArea() {
  const user = getUser();
  $('#authArea').innerHTML = user
    ? `<a class="user-chip" href="#/dashboard" title="Owner dashboard"><span class="avatar">${esc(user.name[0] || 'U').toUpperCase()}</span>${esc(user.name.split(' ')[0])}</a>
       <button class="btn btn-ghost btn-sm" id="signOutBtn" style="min-height:38px">Sign out</button>`
    : `<button class="btn btn-outline btn-sm" id="signInBtn">Sign In</button>`;
  const so = $('#signOutBtn'); if (so) so.addEventListener('click', () => { clearSession(); toast('Signed out. See you soon!', 'info'); location.hash = '#/'; route(); });
  const si = $('#signInBtn'); if (si) si.addEventListener('click', () => openAuthModal());
}

/* ============================================================
   HOME
   ============================================================ */
function renderHome() {
  $('#app').innerHTML = `
  <section class="hero">
    <div class="container">
      <h1>Find Your Place <em>in the World</em></h1>
      <p class="sub">Discover homes, vacation stays, unique outings and land opportunities around the world.</p>
      <form class="search-card" id="heroSearch" autocomplete="off">
        <div class="field">
          <label for="heroLoc">Location</label>
          <input id="heroLoc" name="location" type="text" placeholder="City, town or country — e.g. Kutus">
        </div>
        <div class="field">
          <label for="heroCat">Category</label>
          <select id="heroCat" name="category">
            <option value="">All</option>
            ${CATEGORIES.map(c => `<option>${c}</option>`).join('')}
          </select>
        </div>
        <button type="submit" class="btn btn-primary" id="heroSearchBtn">Search</button>
      </form>
      <div class="hero-actions">
        <a href="#/browse" class="btn btn-outline">View All Properties</a>
        <a href="#/browse?category=Vacation" class="btn btn-gold">Explore Stays</a>
        <button class="btn btn-ghost" data-action="list-property">List Your Property →</button>
      </div>
      <div class="hero-stats">
        <div><b id="statCount">—</b><span>live listings</span></div>
        <div><b>${COUNTRIES.length}+</b><span>countries</span></div>
        <div><b>4</b><span>categories</span></div>
      </div>
    </div>
  </section>

  <section class="section"><div class="container">
    <div class="section-head"><div><h2>Browse by category</h2><p>Every category is backed by live listings.</p></div></div>
    <div class="grid cat-tiles" id="catTiles"></div>
  </div></section>

  <section class="section" style="padding-top:0"><div class="container">
    <div class="section-head">
      <div><h2>Featured & latest</h2><p>Premium and featured listings first, then the newest.</p></div>
      <a href="#/browse" class="btn btn-outline btn-sm">View All</a>
    </div>
    <div id="homeGrid">${skeletons(8)}</div>
  </div></section>

  <section class="section" style="padding-top:0"><div class="container">
    <div class="section-head"><div><h2>Explore by country</h2><p>One marketplace, listings worldwide.</p></div></div>
    <div class="country-row">${COUNTRIES.slice(0, 18).map(c =>
      `<button class="country-pill" data-country="${esc(c)}">${esc(c)}</button>`).join('')}</div>
  </div></section>

  <section class="section" style="padding-top:0"><div class="container">
    <div class="cta-banner">
      <h2>Own a property? <span class="gold">Earn with it.</span></h2>
      <p>List your home, stay, experience or land for free. Upgrade to Featured or Premium for maximum visibility.</p>
      <button class="btn btn-gold" data-action="list-property">List Your Property</button>
    </div>
  </div></section>`;

  // Hero search — real query to the API via /browse
  $('#heroSearch').addEventListener('submit', (e) => {
    e.preventDefault();
    const loc = $('#heroLoc').value.trim(), cat = $('#heroCat').value;
    const p = new URLSearchParams();
    if (loc) p.set('location', loc);
    if (cat) p.set('category', cat);
    location.hash = '#/browse' + (p.toString() ? '?' + p.toString() : '');
  });

  // Category tiles
  const tileImgs = {
    Rent: 'photo-1570129477492-45c003edd2be', Vacation: 'photo-1499793983690-e29da59ef1c2',
    Outings: 'photo-1547471080-7cc2caa01a7e', Land: 'photo-1500382017468-9049fed747ef',
  };
  $('#catTiles').innerHTML = CATEGORIES.map(c => `
    <a class="cat-tile" href="#/browse?category=${c}" aria-label="Browse ${c}">
      <img src="https://images.unsplash.com/${tileImgs[c]}?auto=format&fit=crop&w=800&q=60" alt="" loading="lazy">
      <div class="cat-label"><h3>${CAT_META[c].icon} ${c}</h3><p>${CAT_META[c].blurb}</p></div>
    </a>`).join('');

  // Country pills
  $$('.country-pill').forEach(b => b.addEventListener('click', () => location.hash = '#/browse?country=' + encodeURIComponent(b.dataset.country)));

  // Featured grid + live count
  api('/api/properties?sort=newest&limit=8').then(r => {
    $('#homeGrid').innerHTML = r.properties.length
      ? `<div class="grid grid-cards">${r.properties.map(propertyCard).join('')}</div>`
      : emptyState('No listings yet', 'Be the first to list a property on Global Estates.', 'List Your Property', '#/');
    bindGrid($('#homeGrid'));
    $('#statCount').textContent = r.total;
  }).catch(() => {
    $('#homeGrid').innerHTML = emptyState('Unable to load properties', 'Please try again in a moment.', 'Retry', '#/');
  });
}

/* ============================================================
   BROWSE (search + filters + sort)
   ============================================================ */
function renderBrowse(q) {
  const f = {
    location: q.get('location') || '', country: q.get('country') || '', category: q.get('category') || '',
    minPrice: q.get('minPrice') || '', maxPrice: q.get('maxPrice') || '', bedrooms: q.get('bedrooms') || '',
    guests: q.get('guests') || '', sort: q.get('sort') || 'newest',
  };
  $('#app').innerHTML = `
  <div class="container browse-layout">
    <aside class="filter-panel" id="filterPanel">
      <h3>Filters</h3>
      <div class="filter-group"><label for="fLoc">Location</label>
        <input id="fLoc" value="${esc(f.location)}" placeholder="e.g. Kutus"></div>
      <div class="filter-group"><label for="fCountry">Country</label>
        <select id="fCountry"><option value="">All countries</option>
          ${COUNTRIES.map(c => `<option ${f.country === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="filter-group"><label for="fCat">Category</label>
        <select id="fCat"><option value="">All categories</option>
          ${CATEGORIES.map(c => `<option ${f.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="filter-group"><label>Price (KSh)</label>
        <div class="filter-row">
          <input id="fMin" type="number" min="0" placeholder="Min" value="${esc(f.minPrice)}">
          <input id="fMax" type="number" min="0" placeholder="Max" value="${esc(f.maxPrice)}">
        </div></div>
      <div class="filter-group"><label for="fBeds">Min bedrooms</label>
        <select id="fBeds"><option value="">Any</option>${[1,2,3,4,5].map(n => `<option value="${n}" ${f.bedrooms == n ? 'selected' : ''}>${n}+</option>`).join('')}</select></div>
      <div class="filter-group"><label for="fGuests">Min guests</label>
        <select id="fGuests"><option value="">Any</option>${[1,2,4,6,8,10].map(n => `<option value="${n}" ${f.guests == n ? 'selected' : ''}>${n}+</option>`).join('')}</select></div>
      <button class="btn btn-primary btn-block" id="applyFilters">Apply Filters</button>
      <button class="btn btn-ghost btn-block" id="clearFilters" style="margin-top:.5rem">Clear all</button>
    </aside>
    <section>
      <div class="browse-top">
        <div><h1>${f.category ? esc(f.category) : 'All Properties'}${f.location ? ` · “${esc(f.location)}”` : ''}${f.country ? ` · ${esc(f.country)}` : ''}</h1>
          <span class="result-count" id="resultCount"></span></div>
        <div style="display:flex;gap:.6rem;flex-wrap:wrap">
          <button class="btn btn-outline btn-sm filter-toggle" id="filterToggle">Filters</button>
          <select id="sortSel" style="width:auto">
            <option value="newest" ${f.sort === 'newest' ? 'selected' : ''}>Newest</option>
            <option value="price_asc" ${f.sort === 'price_asc' ? 'selected' : ''}>Price: low to high</option>
            <option value="price_desc" ${f.sort === 'price_desc' ? 'selected' : ''}>Price: high to low</option>
          </select>
        </div>
      </div>
      <div id="browseGrid">${skeletons(8)}</div>
    </section>
  </div>`;

  const apply = (useHash = true) => {
    const p = new URLSearchParams();
    const vals = {
      location: $('#fLoc').value.trim(), country: $('#fCountry').value, category: $('#fCat').value,
      minPrice: $('#fMin').value, maxPrice: $('#fMax').value, bedrooms: $('#fBeds').value,
      guests: $('#fGuests').value, sort: $('#sortSel').value,
    };
    Object.entries(vals).forEach(([k, v]) => { if (v) p.set(k, v); });
    if (useHash) { location.hash = '#/browse' + (p.toString() ? '?' + p.toString() : ''); return; }
    loadResults(p);
  };
  const loadResults = async (p) => {
    $('#browseGrid').innerHTML = skeletons(8);
    try {
      const r = await api('/api/properties?' + p.toString());
      $('#resultCount').textContent = `${r.total} ${r.total === 1 ? 'property' : 'properties'} found`;
      $('#browseGrid').innerHTML = r.properties.length
        ? `<div class="grid grid-cards">${r.properties.map(propertyCard).join('')}</div>`
        : emptyState('No properties match your search', 'Try a different location, or clear some filters.', 'Clear filters', '#/browse');
      bindGrid($('#browseGrid'));
    } catch (e) {
      $('#browseGrid').innerHTML = emptyState('Unable to load properties', e.message, 'Retry', location.hash || '#/browse');
    }
  };
  apply(false); // initial load with current hash params

  $('#applyFilters').addEventListener('click', () => apply(true));
  $('#clearFilters').addEventListener('click', () => location.hash = '#/browse');
  $('#sortSel').addEventListener('change', () => apply(true));
  $('#filterToggle').addEventListener('click', () => $('#filterPanel').classList.toggle('open'));
  $('#fLoc').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(true); });
}

/* ============================================================
   PROPERTY DETAILS
   ============================================================ */
async function renderProperty(id) {
  $('#app').innerHTML = `<div class="container detail-wrap" id="detailWrap">${skeletons(2)}</div>`;
  let prop;
  try { prop = (await api(`/api/properties/${id}`, { auth: true })).property; }
  catch (e) { $('#detailWrap').innerHTML = `<a class="back-link" href="#/browse">← Back</a>` + emptyState('Property unavailable', e.message, 'Browse properties', '#/browse'); return; }

  const meta = CAT_META[prop.category];
  const imgs = (prop.images && prop.images.length) ? prop.images : ['https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?auto=format&fit=crop&w=1200&q=70'];
  const isLand = prop.category === 'Land';
  const today = todayISO();

  $('#detailWrap').innerHTML = `
    <a class="back-link" href="#/browse?category=${encodeURIComponent(prop.category)}">← Back to ${esc(prop.category)}</a>
    <div class="gallery">
      <img class="g-main" src="${esc(imgs[0])}" alt="${esc(prop.title)}" id="gMain">
      <div class="g-side">
        ${imgs.slice(1, 3).map(u => `<img src="${esc(u)}" alt="${esc(prop.title)}" data-thumb="${esc(u)}" style="cursor:pointer">`).join('') ||
          `<img src="${esc(imgs[0])}" alt=""><img src="${esc(imgs[0])}" alt="">`}
      </div>
    </div>
    <div class="detail-grid">
      <div>
        <div class="chip-row">
          <span class="chip emerald">${esc(prop.category)}</span>
          ${prop.listing_plan !== 'free' ? `<span class="chip gold">${prop.listing_plan === 'premium' ? '★ Premium' : 'Featured'}</span>` : ''}
          <span class="chip">📍 ${esc(prop.location)}, ${esc(prop.country)}</span>
        </div>
        <div class="detail-title"><h1>${esc(prop.title)}</h1></div>
        <p class="muted" style="margin-top:.4rem">
          ${prop.bedrooms ? `${prop.bedrooms} bedrooms · ` : ''}${prop.guests ? `sleeps ${prop.guests} · ` : ''}${isLand && prop.land_size ? `${esc(prop.land_size)} · ` : ''}Listed ${new Date(prop.created_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}
        </p>
        <h3 style="margin:1.5rem 0 .5rem;font-family:var(--font-display)">About this ${isLand ? 'land' : 'property'}</h3>
        <p class="muted">${esc(prop.description).replace(/\n/g, '<br>')}</p>
        ${prop.amenities && prop.amenities.length ? `<h3 style="margin:1.5rem 0 .2rem;font-family:var(--font-display)">Amenities</h3>
          <div class="amenity-grid">${prop.amenities.map(a => `<div class="amenity">${esc(a)}</div>`).join('')}</div>` : ''}
        <div class="host-card">
          <span class="avatar">${esc(prop.host.name[0] || 'H').toUpperCase()}</span>
          <div><b>${esc(prop.host.name)}</b><br>
            <span class="muted small">Host on Global Estates since ${new Date(prop.host.memberSince).getFullYear()} · Responds via contact form</span></div>
        </div>
      </div>
      <aside class="book-panel">
        <div class="book-price"><b>${ksh(prop.price)}</b><span class="muted">${isLand ? 'total price' : meta.unit}</span></div>
        ${isLand ? `
          <p class="muted small" style="margin-bottom:1rem">Land purchases use an inquiry flow — no online land transfers. Send an inquiry and the seller will contact you to arrange viewing and due diligence.</p>
          <button class="btn btn-gold btn-block" id="inquiryBtn">Inquire About This Land</button>` : `
          <form id="bookForm">
            <div class="field"><label for="bkIn">${prop.category === 'Outings' ? 'Event date' : 'Check-in'}</label>
              <input type="date" id="bkIn" min="${today}" required></div>
            ${prop.category !== 'Outings' ? `<div class="field"><label for="bkOut">Check-out</label>
              <input type="date" id="bkOut" min="${today}" required></div>` : ''}
            <div class="field"><label for="bkGuests">Guests</label>
              <input type="number" id="bkGuests" min="1" ${prop.guests ? `max="${prop.guests}"` : ''} value="2" required></div>
            <div class="field"><label for="bkName">Your full name</label><input id="bkName" required placeholder="Jane Doe"></div>
            <div class="field"><label for="bkEmail">Your email</label><input id="bkEmail" type="email" required placeholder="jane@email.com"></div>
            <div class="field"><label for="bkPhone">Phone (optional)</label><input id="bkPhone" placeholder="+254 ..."></div>
            <div class="breakdown" id="bkBreakdown"></div>
            <button type="submit" class="btn btn-primary btn-block" style="margin-top:1rem" id="bookNowBtn">Book Now</button>
            <p class="muted small" style="margin-top:.7rem;text-align:center">You'll complete secure payment via Stripe. Free cancellation before payment.</p>
          </form>`}
        <button class="btn btn-outline btn-block" style="margin-top:.7rem" id="contactBtn">Contact Host</button>
        <button class="btn btn-ghost btn-block" id="favBtn2">${favSet.has(prop.id) ? '♥ Saved' : '♡ Save to favorites'}</button>
      </aside>
    </div>`;

  // gallery thumbnail swap
  $$('.g-side img').forEach(im => im.addEventListener('click', () => { const m = $('#gMain'); const t = m.src; m.src = im.src; im.src = t; }));
  $('#contactBtn').addEventListener('click', () => openContactModal(prop));
  $('#favBtn2').addEventListener('click', (e) => { toggleFav(prop.id); e.target.textContent = favSet.has(prop.id) ? '♥ Saved' : '♡ Save to favorites'; });
  if (isLand) { $('#inquiryBtn').addEventListener('click', () => openContactModal(prop, true)); return; }

  // live price breakdown
  const upd = () => {
    const ci = $('#bkIn').value; const co = $('#bkOut') ? $('#bkOut').value : ci;
    if (!ci) { $('#bkBreakdown').innerHTML = ''; return; }
    let html = '';
    if (prop.category === 'Vacation') {
      const nights = Math.max(1, Math.round((new Date(co || ci) - new Date(ci)) / 86400000));
      html = `<div class="row"><span>${ksh(prop.price)} × ${nights} night${nights > 1 ? 's' : ''}</span><span>${ksh(prop.price * nights)}</span></div>`;
      if (co && co <= ci) html += `<div class="row" style="color:var(--danger)">Check-out must be after check-in</div>`;
      $('#bkBreakdown').innerHTML = html + `<div class="row total"><span>Total (fee included)</span><span>${ksh(prop.price * Math.max(1, nights))}</span></div>`;
    } else if (prop.category === 'Rent') {
      const days = Math.max(1, Math.round((new Date(co || ci) - new Date(ci)) / 86400000));
      const months = Math.max(1, Math.ceil(days / 30));
      $('#bkBreakdown').innerHTML = `<div class="row"><span>${ksh(prop.price)} × ${months} month${months > 1 ? 's' : ''}</span><span>${ksh(prop.price * months)}</span></div>
        <div class="row total"><span>Total due</span><span>${ksh(prop.price * months)}</span></div>`;
    } else {
      $('#bkBreakdown').innerHTML = `<div class="row"><span>Experience booking</span><span>${ksh(prop.price)}</span></div>
        <div class="row total"><span>Total due</span><span>${ksh(prop.price)}</span></div>`;
    }
  };
  ['bkIn', 'bkOut'].forEach(id => { const el = $('#' + id); if (el) el.addEventListener('change', upd); });
  $('#bkIn').addEventListener('change', () => { if ($('#bkOut')) { const d = new Date($('#bkIn').value); d.setDate(d.getDate() + 1); $('#bkOut').min = d.toISOString().slice(0, 10); } upd(); });

  $('#bookForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#bookNowBtn');
    const body = {
      propertyId: prop.id, checkIn: $('#bkIn').value,
      checkOut: $('#bkOut') ? $('#bkOut').value : $('#bkIn').value,
      guests: Number($('#bkGuests').value), name: $('#bkName').value.trim(),
      email: $('#bkEmail').value.trim(), phone: $('#bkPhone').value.trim(),
    };
    if (!body.checkIn) return toast('Please choose a check-in date.', 'error');
    if (prop.category !== 'Outings' && body.checkOut <= body.checkIn) return toast('Check-out date must be after check-in.', 'error');
    btn.classList.add('loading'); btn.disabled = true; btn.textContent = 'Starting checkout… ';
    try {
      const r = await api('/api/checkout', { method: 'POST', body });
      window.location.href = r.url; // Stripe Checkout
    } catch (err) {
      toast(err.message, 'error');
      btn.classList.remove('loading'); btn.disabled = false; btn.textContent = 'Book Now';
    }
  });
}

/* ============================================================
   BOOKING CONFIRMATION (post-Stripe redirect)
   ============================================================ */
function renderCheckout(q) {
  const root = $('#app');
  if (q.get('cancelled')) {
    root.innerHTML = `<div class="container"><div class="result-card">
      <div class="result-icon bad">✕</div><h2 style="font-family:var(--font-display)">Payment cancelled</h2>
      <p class="muted" style="margin:.6rem 0 1.4rem">No charge was made. You can try again whenever you're ready.</p>
      <a class="btn btn-primary" href="#/property/${esc(q.get('booking') || '')}">Back to property</a>
      <a class="btn btn-ghost" href="#/browse">Browse more</a></div></div>`;
    return;
  }
  const sid = q.get('session_id');
  root.innerHTML = `<div class="container"><div class="result-card">
    <div class="result-icon wait">…</div><h2 style="font-family:var(--font-display)">Confirming your payment…</h2>
    <p class="muted" style="margin-top:.5rem">Please don't close this page.</p></div></div>`;
  let tries = 0;
  const poll = async () => {
    tries++;
    try {
      const r = await api(`/api/checkout/status?session_id=${encodeURIComponent(sid)}`);
      if (r.payment_status === 'paid') {
        const bk = r.booking || {};
        root.innerHTML = `<div class="container"><div class="result-card">
          <div class="result-icon ok">✓</div>
          <h2 style="font-family:var(--font-display)">Booking confirmed!</h2>
          <p class="muted" style="margin:.6rem 0 1.2rem">Payment received. A confirmation has been noted for <b>${esc(bk.title || 'your booking')}</b>
            ${bk.check_in ? `· ${esc(String(bk.check_in).slice(0,10))} → ${esc(String(bk.check_out).slice(0,10))}` : ''} · ${bk.guests || ''} guest(s).</p>
          <div class="breakdown" style="text-align:left;max-width:340px;margin:0 auto 1.4rem">
            <div class="row total"><span>Amount paid</span><span>${ksh(bk.amount)}</span></div>
            <div class="row"><span>Booking ref</span><span>#${bk.id || '—'}</span></div>
          </div>
          <a class="btn btn-primary" href="#/browse">Explore more stays</a></div></div>`;
        return;
      }
      if (r.payment_status === 'unpaid' || r.payment_status === 'pending') {
        if (tries < 8) return setTimeout(poll, 1800);
        root.innerHTML = `<div class="container"><div class="result-card">
          <div class="result-icon wait">⏳</div><h2 style="font-family:var(--font-display)">Payment pending</h2>
          <p class="muted">We haven't received confirmation yet. If you completed payment, this page will update automatically — or contact support with booking ref #${r.bookingId}.</p></div></div>`;
      }
      if (r.payment_status === 'expired') {
        root.innerHTML = `<div class="container"><div class="result-card">
          <div class="result-icon bad">✕</div><h2 style="font-family:var(--font-display)">Checkout expired</h2>
          <p class="muted" style="margin:.6rem 0 1.2rem">The payment session expired before completing. No charge was made.</p>
          <a class="btn btn-primary" href="#/property/${r.bookingId || ''}">Try again</a></div></div>`;
      }
    } catch (e) {
      root.innerHTML = `<div class="container"><div class="result-card"><div class="result-icon bad">!</div>
        <h2 style="font-family:var(--font-display)">Unable to verify payment</h2><p class="muted">${esc(e.message)}</p></div></div>`;
    }
  };
  poll();
}

/* ============================================================
   SAVED
   ============================================================ */
async function renderSaved() {
  $('#app').innerHTML = `<div class="container section"><div class="section-head"><div><h1 style="font-family:var(--font-display)">Saved properties</h1>
    <p>Your favorites on this device.</p></div><a class="btn btn-outline btn-sm" href="#/browse">Browse more</a></div>
    <div id="savedGrid">${skeletons(4)}</div></div>`;
  try {
    const r = await api(`/api/favorites?device=${encodeURIComponent(deviceId())}`);
    $('#savedGrid').innerHTML = r.properties.length
      ? `<div class="grid grid-cards">${r.properties.map(propertyCard).join('')}</div>`
      : emptyState('No saved properties yet', 'Tap the ♥ on any listing to save it here.', 'Start browsing', '#/browse');
    bindGrid($('#savedGrid'));
  } catch (e) { $('#savedGrid').innerHTML = emptyState('Unable to load saved properties', e.message, 'Retry', '#/saved'); }
}

/* ============================================================
   OWNER DASHBOARD
   ============================================================ */
async function renderDashboard(q) {
  if (!getToken()) { toast('Please sign in to access your dashboard.', 'info'); openAuthModal('signin', 'Please sign in to continue.'); return; }
  $('#app').innerHTML = `<div class="container dash-wrap">${skeletons(4)}</div>`;
  let d;
  try { d = await api('/api/owner/dashboard', { auth: true }); }
  catch (e) { $('#app').innerHTML = `<div class="container section">${emptyState('Unable to load dashboard', e.message, 'Retry', '#/dashboard')}</div>`; return; }

  // Plan-upgrade redirect handling
  const planSession = q.get('plan_session');
  if (planSession) {
    history.replaceState(null, '', '#/dashboard');
    api(`/api/checkout/status?session_id=${encodeURIComponent(planSession)}`).then(r => {
      if (r.payment_status === 'paid') toast(`Payment confirmed — your listing is now ${r.plan === 'premium' ? 'Premium ★' : 'Featured'}.`);
      else toast('Plan upgrade payment has not been confirmed yet.', 'info');
      renderDashboard(new URLSearchParams());
    }).catch(e => toast(e.message, 'error'));
    return;
  }
  if (q.get('plan_cancelled')) { history.replaceState(null, '', '#/dashboard'); toast('Plan upgrade cancelled — no charge was made.', 'info'); }

  const t = d.totals;
  const wrap = $('.dash-wrap');
  wrap.innerHTML = `
    <div class="section-head"><div><h1 style="font-family:var(--font-display)">Owner Dashboard</h1>
      <p>Welcome back, ${esc(d.owner.name)} · ${d.properties.length} listing${d.properties.length === 1 ? '' : 's'}</p></div>
      <button class="btn btn-primary btn-sm" data-action="list-property">+ New Listing</button></div>
    <div class="stat-grid">
      <div class="stat accent"><span>Total earnings (net)</span><b>${ksh(t.net)}</b></div>
      <div class="stat goldy"><span>Pending payouts</span><b>${ksh(t.pending_payout)}</b></div>
      <div class="stat"><span>Booked (gross)</span><b>${ksh(t.gross)}</b></div>
      <div class="stat"><span>Platform fees paid</span><b>${ksh(t.fees)}</b></div>
      <div class="stat"><span>Paid bookings</span><b>${t.paid_bookings}</b></div>
    </div>
    <div class="tabs" role="tablist">
      <button class="tab active" data-tab="props">My Properties</button>
      <button class="tab" data-tab="bookings">Bookings & Payouts</button>
      <button class="tab" data-tab="inquiries">Inquiries</button>
      <button class="tab" data-tab="plans">Listing Plans</button>
    </div>
    <div id="tabContent"></div>`;

  const tabContent = $('#tabContent');
  const tabs = { props: propsTab, bookings: bookingsTab, inquiries: inquiriesTab, plans: plansTab };
  function switchTab(name) {
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    tabContent.innerHTML = '';
    tabs[name]();
  }
  $$('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  function propsTab() {
    tabContent.innerHTML = d.properties.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Property</th><th>Category</th><th>Price</th><th>Plan</th><th>Status</th><th>Bookings</th><th>Actions</th></tr></thead>
      <tbody>${d.properties.map(p => `<tr>
        <td><b>${esc(p.title)}</b><br><span class="muted small">${esc(p.location)}, ${esc(p.country)}</span></td>
        <td>${esc(p.category)}</td><td>${ksh(p.price)}</td>
        <td>${p.listing_plan === 'premium' ? '<span class="status paid">★ Premium</span>' : p.listing_plan === 'featured' ? '<span class="status pending_payment">Featured</span>' : '<span class="status inactive">Free</span>'}</td>
        <td><span class="status ${p.status}">${p.status}</span></td>
        <td>${p.booking_count}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-outline btn-sm" data-act="view" data-id="${p.id}">View</button>
          <button class="btn btn-outline btn-sm" data-act="edit" data-pid="${p.id}">Edit</button>
          <button class="btn btn-danger btn-sm" data-act="del" data-pid="${p.id}" data-title="${esc(p.title)}">Delete</button>
        </td></tr>`).join('')}</tbody></table></div>`
      : emptyState('No properties yet', 'Create your first listing — it takes two minutes.', 'List Your Property', '#/');
    tabContent.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'view') location.hash = '#/property/' + b.dataset.id;
      if (b.dataset.act === 'edit') {
        const p = d.properties.find(x => x.id === Number(b.dataset.pid));
        if (p) openListingModal(p);
      }
      if (b.dataset.act === 'del') openConfirmDelete(Number(b.dataset.pid), b.dataset.title, () => renderDashboard(new URLSearchParams()));
    });
  }

  function bookingsTab() {
    tabContent.innerHTML = d.bookings.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Ref</th><th>Property</th><th>Dates</th><th>Guests</th><th>Amount</th><th>Fee</th><th>Host payout</th><th>Payment</th><th>Payout</th><th></th></tr></thead>
      <tbody>${d.bookings.map(b => `<tr>
        <td>#${b.id}</td><td>${esc(b.property_title)}</td>
        <td>${esc(String(b.check_in).slice(0,10))} → ${esc(String(b.check_out).slice(0,10))}</td>
        <td>${b.guests}</td><td>${ksh(b.amount)}</td><td>${ksh(b.platform_fee)}</td><td><b>${ksh(b.host_payout)}</b></td>
        <td><span class="status ${b.payment_status}">${b.payment_status.replace('_', ' ')}</span></td>
        <td><span class="status ${b.payout_status}">${b.payout_status}</span></td>
        <td>${b.payment_status === 'paid' && b.payout_status === 'pending' ? `<button class="btn btn-gold btn-sm" data-payout="${b.id}">Request payout</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>
      <p class="muted small" style="margin-top:.8rem">Vacation & outings carry a 10% platform commission. Payouts are only marked "transferred" once a real transfer is confirmed.</p>`
      : emptyState('No bookings yet', 'Bookings will appear here once guests pay for your listings.');
    tabContent.querySelectorAll('[data-payout]').forEach(btn => btn.addEventListener('click', async () => {
      btn.disabled = true; btn.classList.add('loading');
      try { const r = await api(`/api/owner/payout/${btn.dataset.payout}`, { method: 'POST', auth: true }); toast(r.message, r.status === 'transferred' ? 'success' : 'info'); switchTab('bookings'); }
      catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.classList.remove('loading'); }
    }));
  }

  async function inquiriesTab() {
    tabContent.innerHTML = skeletons(2);
    try {
      const r = await api('/api/owner/inquiries', { auth: true });
      tabContent.innerHTML = r.inquiries.length ? r.inquiries.map(i => `
        <div class="host-card" style="margin-top:0;margin-bottom:.8rem;flex-wrap:wrap">
          <span class="avatar">${esc(i.name[0] || '?').toUpperCase()}</span>
          <div style="flex:1;min-width:220px"><b>${esc(i.name)}</b> <span class="muted small">· re: ${esc(i.property_title)}</span><br>
          <span class="muted small">${esc(i.email)}${i.phone ? ' · ' + esc(i.phone) : ''} · ${new Date(i.created_at).toLocaleDateString()}</span><br>
          <span style="font-size:.92rem">${esc(i.message)}</span></div>
          <a class="btn btn-outline btn-sm" href="mailto:${encodeURIComponent(i.email)}?subject=Re: ${encodeURIComponent(i.property_title)}">Reply</a>
        </div>`).join('') : emptyState('No inquiries yet', 'Messages from the Contact Host form appear here.');
    } catch (e) { tabContent.innerHTML = emptyState('Unable to load inquiries', e.message); }
  }

  function plansTab() {
    tabContent.innerHTML = `
    <div class="plan-cards">
      <div class="plan-card"><h3>Free</h3><div class="price">KSh 0</div>
        <ul><li>Basic property listing</li><li>Appears in search & browse</li><li>Unlimited standard listings</li></ul>
        <span class="chip emerald" style="align-self:flex-start">Included with every listing</span></div>
      <div class="plan-card hl"><h3>Featured</h3><div class="price">KSh 500</div>
        <ul><li>Featured placement in results</li><li>Featured badge on your card</li><li>One-time payment per listing</li></ul>
        ${upgradeBtns()}</div>
      <div class="plan-card"><h3>Premium ★</h3><div class="price">KSh 2,000</div>
        <ul><li>Top-of-results visibility</li><li>Premium badge & enhanced placement</li><li>Priority in featured sections</li></ul>
        ${upgradeBtns(true)}</div>
    </div>
    <p class="muted small" style="margin-top:1rem">Upgrades are real Stripe charges — your plan only changes once payment is confirmed.</p>`;
    tabContent.querySelectorAll('[data-upgrade]').forEach(btn => btn.addEventListener('click', async () => {
      const [pid, plan] = btn.dataset.upgrade.split(':');
      btn.classList.add('loading'); btn.disabled = true;
      try { const r = await api(`/api/properties/${pid}/plan`, { method: 'POST', body: { plan }, auth: true }); window.location.href = r.url; }
      catch (e) { toast(e.message, 'error'); btn.classList.remove('loading'); btn.disabled = false; }
    }));
    function upgradeBtns(premium = false) {
      if (!d.properties.length) return '<button class="btn btn-outline" disabled>No listings yet — create one first</button>';
      return d.properties.slice(0, 4).map(p => `
        <button class="btn ${premium ? 'btn-gold' : 'btn-primary'} btn-sm" data-upgrade="${p.id}:${premium ? 'premium' : 'featured'}"
          ${p.listing_plan === (premium ? 'premium' : 'featured') || (premium === false && p.listing_plan === 'premium') ? 'disabled' : ''}>
          ${p.listing_plan === (premium ? 'premium' : 'featured') ? esc(p.title) + ' ✓ active' : (premium && p.listing_plan === 'premium' ? esc(p.title) + ' ✓' : 'Upgrade “' + esc(p.title.slice(0, 18)) + (p.title.length > 18 ? '…' : '') + '”')}</button>`).join('');
    }
  }

  switchTab(q.get('tab') || 'props');
}

function openConfirmDelete(id, title, after) {
  openModal({ body: `
    <div class="modal-head"><h2>Delete listing?</h2><button class="modal-close" data-close aria-label="Close">✕</button></div>
    <p class="muted">“${esc(title)}” will be permanently removed. Listings with paid bookings cannot be deleted.</p>
    <div style="display:flex;gap:.7rem;margin-top:1.4rem">
      <button class="btn btn-outline" data-close style="flex:1">Cancel</button>
      <button class="btn btn-danger" id="confirmDel" style="flex:1">Delete property</button>
    </div>` }, (m) => {
    m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
    $('#confirmDel', m).addEventListener('click', async (e) => {
      const btn = e.target; btn.classList.add('loading'); btn.disabled = true;
      try { await api(`/api/properties/${id}`, { method: 'DELETE', auth: true }); toast('Property deleted.'); closeModal(); if (after) after(); }
      catch (err) { toast(err.message, 'error'); btn.classList.remove('loading'); btn.disabled = false; }
    });
  });
}

/* ============================================================
   LIST YOUR PROPERTY (create + edit)
   ============================================================ */
function openListingModal(existing = null) {
  if (!getToken()) { toast('Please sign in to list a property.', 'info'); openAuthModal('signin', 'Sign in to list your property.'); return; }
  const p = existing || {};
  openModal({ wide: true, body: `
    <div class="modal-head"><h2>${existing ? 'Edit property' : 'List Your Property'}</h2><button class="modal-close" data-close aria-label="Close">✕</button></div>
    <form class="form-grid" id="listingForm" novalidate>
      <div class="form-field"><label for="lpTitle">Property title *</label>
        <input id="lpTitle" value="${esc(p.title || '')}" placeholder="e.g. Diani Beach House" maxlength="120"></div>
      <div class="form-row">
        <div class="form-field"><label for="lpCat">Category *</label>
          <select id="lpCat">${CATEGORIES.map(c => `<option ${p.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="form-field"><label for="lpCountry">Country *</label>
          <select id="lpCountry"><option value="">Select country…</option>
            ${COUNTRIES.map(c => `<option ${p.country === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      </div>
      <div class="form-field"><label for="lpLoc">Location (town/city) *</label>
        <input id="lpLoc" value="${esc(p.location || '')}" placeholder="e.g. Kutus"></div>
      <div class="form-field"><label for="lpDesc">Description *</label>
        <textarea id="lpDesc" placeholder="What makes this place special?">${esc(p.description || '')}</textarea></div>
      <div class="form-row">
        <div class="form-field"><label for="lpPrice">Price (KSh) * <span class="hint" id="priceUnit"></span></label>
          <input id="lpPrice" type="number" min="1" value="${p.price || ''}"></div>
        <div class="form-field" id="landSizeField" style="display:${p.category === 'Land' ? 'block' : 'none'}"><label for="lpLand">Land size *</label>
          <input id="lpLand" value="${esc(p.land_size || '')}" placeholder="e.g. 0.5 acre"></div>
      </div>
      <div class="form-row">
        <div class="form-field"><label for="lpBeds">Bedrooms</label>
          <input id="lpBeds" type="number" min="0" value="${p.bedrooms ?? 0}"></div>
        <div class="form-field"><label for="lpGuests">Max guests</label>
          <input id="lpGuests" type="number" min="0" value="${p.guests ?? 0}"></div>
      </div>
      <div class="form-field"><label for="lpAmen">Amenities (comma-separated)</label>
        <input id="lpAmen" value="${esc((p.amenities || []).join(', '))}" placeholder="Wi-Fi, Pool, Parking"></div>
      <div class="form-field"><label for="lpImgs">Images (one URL per line, up to 10)</label>
        <textarea id="lpImgs" placeholder="https://…">${esc((p.images || []).join('\n'))}</textarea>
        <div class="hint">Paste image links (e.g. from your cloud storage). The first image becomes the cover.</div></div>
      <div class="form-row">
        <div class="form-field"><label for="lpCName">Contact name</label><input id="lpCName" value="${esc(p.contact_name || '')}"></div>
        <div class="form-field"><label for="lpCPhone">Contact phone</label><input id="lpCPhone" value="${esc(p.contact_phone || '')}"></div>
      </div>
      <div class="form-field"><label for="lpCEmail">Contact email</label><input id="lpCEmail" type="email" value="${esc(p.contact_email || '')}"></div>
      <div id="lpMsg"></div>
      <button type="submit" class="btn btn-primary btn-block" id="lpSubmit">${existing ? 'Save Changes' : 'Save & List Property'}</button>
    </form>` }, (m) => {
    m.querySelector('[data-close]').addEventListener('click', closeModal);
    const catSel = $('#lpCat', m);
    const updUnit = () => {
      const c = catSel.value;
      $('#priceUnit', m).textContent = c === 'Rent' ? 'per month' : c === 'Vacation' ? 'per night' : c === 'Outings' ? 'per experience' : 'total';
      $('#landSizeField', m).style.display = c === 'Land' ? 'block' : 'none';
    };
    catSel.addEventListener('change', updUnit); updUnit();

    $('#listingForm', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#lpMsg', m), btn = $('#lpSubmit', m);
      msg.innerHTML = '';
      const body = {
        title: $('#lpTitle', m).value.trim(), category: catSel.value, country: $('#lpCountry', m).value,
        location: $('#lpLoc', m).value.trim(), description: $('#lpDesc', m).value.trim(),
        price: Number($('#lpPrice', m).value), bedrooms: Number($('#lpBeds', m).value || 0),
        guests: Number($('#lpGuests', m).value || 0), land_size: $('#lpLand', m).value.trim(),
        amenities: $('#lpAmen', m).value.split(',').map(s => s.trim()).filter(Boolean),
        images: $('#lpImgs', m).value.split('\n').map(s => s.trim()).filter(Boolean),
        contact_name: $('#lpCName', m).value.trim(), contact_phone: $('#lpCPhone', m).value.trim(),
        contact_email: $('#lpCEmail', m).value.trim(),
      };
      // client-side validation (server re-validates everything)
      if (body.title.length < 4) { msg.innerHTML = '<div class="form-msg err">Please enter a property title (at least 4 characters).</div>'; return; }
      if (!body.country) { msg.innerHTML = '<div class="form-msg err">Please select a country.</div>'; return; }
      if (!body.location) { msg.innerHTML = '<div class="form-msg err">Please enter a location.</div>'; return; }
      if (body.description.length < 10) { msg.innerHTML = '<div class="form-msg err">Please add a short description.</div>'; return; }
      if (!body.price || body.price <= 0) { msg.innerHTML = '<div class="form-msg err">Please enter a valid price.</div>'; return; }
      if (body.category === 'Land' && !body.land_size) { msg.innerHTML = '<div class="form-msg err">Please enter the land size.</div>'; return; }
      btn.classList.add('loading'); btn.disabled = true;
      try {
        const r = existing
          ? await api(`/api/properties/${existing.id}`, { method: 'PUT', body, auth: true })
          : await api('/api/properties', { method: 'POST', body, auth: true });
        toast(r.message || 'Property saved successfully.');
        closeModal();
        loadFavorites();
        location.hash = '#/property/' + r.property.id; // new listing appears & opens immediately
      } catch (err) {
        msg.innerHTML = `<div class="form-msg err">${esc(err.message)}</div>`;
        btn.classList.remove('loading'); btn.disabled = false;
      }
    });
  });
}

/* ============================================================
   CONTACT HOST
   ============================================================ */
function openContactModal(prop, isLandInquiry = false) {
  openModal({ body: `
    <div class="modal-head"><h2>${isLandInquiry ? 'Inquire about this land' : 'Contact host'}</h2><button class="modal-close" data-close aria-label="Close">✕</button></div>
    <p class="muted small" style="margin-bottom:1rem">Re: <b>${esc(prop.title)}</b> · ${esc(prop.location)}, ${esc(prop.country)}.
      Your message goes to the ${isLandInquiry ? 'seller' : 'host'} through Global Estates — private details stay protected.</p>
    <form class="form-grid" id="contactForm" novalidate>
      <div class="form-field"><label for="ctName">Your name *</label><input id="ctName"></div>
      <div class="form-row">
        <div class="form-field"><label for="ctEmail">Your email *</label><input id="ctEmail" type="email"></div>
        <div class="form-field"><label for="ctPhone">Phone (optional)</label><input id="ctPhone"></div>
      </div>
      <div class="form-field"><label for="ctMsg">Message *</label>
        <textarea id="ctMsg" placeholder="${isLandInquiry ? 'I would like to arrange a viewing and discuss the purchase…' : 'I would like to ask about availability…'}"></textarea></div>
      <div id="ctMsgBox"></div>
      <button class="btn btn-primary btn-block" id="ctSubmit" type="submit">Send message</button>
    </form>` }, (m) => {
    m.querySelector('[data-close]').addEventListener('click', closeModal);
    $('#contactForm', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#ctSubmit', m), box = $('#ctMsgBox', m);
      btn.classList.add('loading'); btn.disabled = true;
      try {
        const r = await api('/api/inquiries', { method: 'POST', body: {
          propertyId: prop.id, name: $('#ctName', m).value.trim(), email: $('#ctEmail', m).value.trim(),
          phone: $('#ctPhone', m).value.trim(), message: $('#ctMsg', m).value.trim(),
        } });
        box.innerHTML = `<div class="form-msg ok">${esc(r.message)}</div>`;
        btn.textContent = 'Sent ✓'; toast(r.message);
        setTimeout(closeModal, 1600);
      } catch (err) {
        box.innerHTML = `<div class="form-msg err">${esc(err.message)}</div>`;
        btn.classList.remove('loading'); btn.disabled = false;
      }
    });
  });
}

/* ============================================================
   AUTH MODAL
   ============================================================ */
function openAuthModal(mode = 'signin', heading) {
  let m = mode;
  const draw = () => {
    openModal({ body: `
      <div class="modal-head"><h2>${esc(heading || (m === 'signin' ? 'Welcome back' : 'Create your owner account'))}</h2>
        <button class="modal-close" data-close aria-label="Close">✕</button></div>
      <form class="form-grid" id="authForm" novalidate>
        ${m === 'register' ? '<div class="form-field"><label>Full name *</label><input id="auName"></div>' : ''}
        <div class="form-field"><label>Email *</label><input id="auEmail" type="email" autocomplete="email"></div>
        <div class="form-field"><label>Password *</label><input id="auPass" type="password" autocomplete="${m === 'signin' ? 'current-password' : 'new-password'}"></div>
        ${m === 'register' ? '<div class="form-field"><label>Phone (optional)</label><input id="auPhone"></div>' : ''}
        <div id="auMsg"></div>
        <button class="btn btn-primary btn-block" type="submit">${m === 'signin' ? 'Sign In' : 'Create Account'}</button>
      </form>
      <p class="auth-switch">${m === 'signin'
        ? 'New to Global Estates? <button id="auSwitch">Create an account</button>'
        : 'Already have an account? <button id="auSwitch">Sign in</button>'}</p>
      <p class="muted small" style="text-align:center;margin-top:.8rem">Demo owner: demo@global-estates.app / demo1234</p>` },
    (modal) => {
      modal.querySelector('[data-close]').addEventListener('click', closeModal);
      $('#auSwitch', modal).addEventListener('click', () => { m = m === 'signin' ? 'register' : 'signin'; heading = null; draw(); });
      $('#authForm', modal).addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type=submit]'), box = $('#auMsg', modal);
        const body = { email: $('#auEmail', modal).value.trim(), password: $('#auPass', modal).value };
        if (m === 'register') { body.name = $('#auName', modal).value.trim(); body.phone = $('#auPhone', modal).value.trim(); }
        btn.classList.add('loading'); btn.disabled = true;
        try {
          const r = await api(m === 'signin' ? '/api/auth/login' : '/api/auth/register', { method: 'POST', body });
          setSession(r.token, r.user);
          toast(m === 'signin' ? `Welcome back, ${r.user.name.split(' ')[0]}!` : 'Account created. Welcome to Global Estates!');
          closeModal();
          if (pendingListingIntent) { pendingListingIntent = false; openListingModal(); }
          else if (location.hash.startsWith('#/dashboard')) renderDashboard(new URLSearchParams());
        } catch (err) {
          box.innerHTML = `<div class="form-msg err">${esc(err.message)}</div>`;
          btn.classList.remove('loading'); btn.disabled = false;
        }
      });
    });
  };
  draw();
}
let pendingListingIntent = false;

/* ============================================================
   GLOBAL CLICK DELEGATION + BOOT
   ============================================================ */
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const action = a.dataset.action;
  if (action === 'list-property') { e.preventDefault(); if (!getToken()) { pendingListingIntent = true; toast('Please sign in to list a property.', 'info'); openAuthModal('signin', 'Sign in to list your property.'); } else openListingModal(); }
  if (action === 'plans') { e.preventDefault(); if (!getToken()) { openAuthModal('signin', 'Sign in to manage plans.'); } else location.hash = '#/dashboard?tab=plans'; }
});

$('#burgerBtn').addEventListener('click', () => {
  const nav = $('#mainNav'), open = nav.classList.toggle('open');
  $('#burgerBtn').setAttribute('aria-expanded', String(open));
});

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', async () => {
  renderAuthArea();
  await loadFavorites();
  route();
});
