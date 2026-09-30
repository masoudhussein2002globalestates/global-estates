require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Stripe = require('stripe');

/* ---------------- Configuration (server-side only — never sent to client) ---------------- */
const DATABASE_URL        = process.env.DATABASE_URL;
const STRIPE_SECRET_KEY   = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const JWT_SECRET          = process.env.JWT_SECRET || 'dev-insecure-secret';
const PORT                = process.env.PORT || 3000;
const APP_URL             = process.env.APP_URL || `http://localhost:${PORT}`;
const CURRENCY            = (process.env.CURRENCY || 'kes').toLowerCase();
const PLATFORM_FEE_PERCENT = Math.min(90, Math.max(0, Number(process.env.PLATFORM_FEE_PERCENT || 5)));
const VACATION_OUTING_COMMISSION = 10; // fixed by product rules
const PLAN_PRICES = {
  featured: Math.max(0, Number(process.env.PLAN_PRICE_FEATURED || 500)),
  premium:  Math.max(0, Number(process.env.PLAN_PRICE_PREMIUM || 2000)),
};
const CATEGORIES = ['Rent', 'Vacation', 'Outings', 'Land'];

/* ---------------- Database ---------------- */
let pool = null;
if (DATABASE_URL) {
  let host = '';
  try { host = new URL(DATABASE_URL.replace(/^postgres(ql)?:/, 'http:')).hostname; } catch {}
  const needsSSL = !['localhost', '127.0.0.1', ''].includes(host) && !/sslmode=disable/.test(DATABASE_URL);
  pool = new Pool({ connectionString: DATABASE_URL, ssl: needsSSL ? { rejectUnauthorized: false } : undefined });
}
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function q(text, params) {
  if (!pool) throw new HttpError(503, 'Database is not configured on this server.');
  try { return await pool.query(text, params); }
  catch (e) { console.error('DB error:', e.message); throw new HttpError(503, 'Database error. Please try again.'); }
}

/* ---------------- Validation helpers ---------------- */
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const intOr = (v, fallback = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : fallback; };
const isUrl = (u) => /^https?:\/\/[^\s]{5,500}$/i.test(u || '');
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(new Date(d + 'T00:00:00Z').getTime());
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e || '');

function feeFor(category, amount) {
  const pct = (category === 'Vacation' || category === 'Outings') ? VACATION_OUTING_COMMISSION : PLATFORM_FEE_PERCENT;
  return { fee: Math.round(amount * pct / 100), pct };
}
function publicHost(row) { return { id: row.host_id ?? row.id, name: row.host_name || row.name, memberSince: row.host_created || row.created_at }; }

/* ---------------- Auth ---------------- */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please sign in to continue.' });
  try { req.hostId = jwt.verify(token, JWT_SECRET).sub; next(); }
  catch { return res.status(401).json({ error: 'Your session has expired. Please sign in again.' }); }
}
function signToken(host) { return jwt.sign({ sub: host.id, email: host.email }, JWT_SECRET, { expiresIn: '14d' }); }
function safeHost(h) { return { id: h.id, name: h.name, email: h.email, phone: h.phone || '', createdAt: h.created_at }; }

/* ---------------- App ---------------- */
const app = express();
app.use(cors());

/* Stripe webhook MUST receive the raw body — mount before express.json() */
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), h(async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.json({ received: true, note: 'Stripe webhook not configured' });
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET); }
  catch (err) { console.error('Webhook signature failed:', err.message); return res.status(400).send(`Webhook Error: ${err.message}`); }
  try { await handleStripeEvent(event); } catch (e) { console.error('Webhook processing error:', e.message); }
  res.json({ received: true });
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ================= HEALTH ================= */
app.get('/api/health', h(async (req, res) => {
  let pgConnected = false;
  if (pool) { try { await pool.query('SELECT 1'); pgConnected = true; } catch {} }
  res.json({
    status: 'ok',
    service: 'Global Estates',
    time: new Date().toISOString(),
    postgres: { configured: !!DATABASE_URL, connected: pgConnected },
    stripe: { configured: !!stripe, webhookConfigured: !!STRIPE_WEBHOOK_SECRET },
    currency: CURRENCY,
    platformFee: { vacationOutings: `${VACATION_OUTING_COMMISSION}%`, rent: `${PLATFORM_FEE_PERCENT}%`, land: 'inquiry-based' },
    plans: { free: 0, featured: PLAN_PRICES.featured, premium: PLAN_PRICES.premium },
  });
}));

/* ================= AUTH ================= */
app.post('/api/auth/register', h(async (req, res) => {
  const name = str(req.body.name, 80), email = str(req.body.email, 120).toLowerCase();
  const password = str(req.body.password, 100), phone = str(req.body.phone, 30);
  if (name.length < 2) return res.status(400).json({ error: 'Please enter your full name.' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const exists = await q('SELECT 1 FROM hosts WHERE email=$1', [email]);
  if (exists.rowCount) return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
  const hash = await bcrypt.hash(password, 10);
  const r = await q('INSERT INTO hosts(name,email,password_hash,phone) VALUES($1,$2,$3,$4) RETURNING *', [name, email, hash, phone || null]);
  res.status(201).json({ token: signToken(r.rows[0]), user: safeHost(r.rows[0]) });
}));

app.post('/api/auth/login', h(async (req, res) => {
  const email = str(req.body.email, 120).toLowerCase(), password = str(req.body.password, 100);
  if (!isEmail(email) || !password) return res.status(400).json({ error: 'Please enter your email and password.' });
  const r = await q('SELECT * FROM hosts WHERE email=$1', [email]);
  if (!r.rowCount || !(await bcrypt.compare(password, r.rows[0].password_hash)))
    return res.status(401).json({ error: 'Invalid email or password.' });
  res.json({ token: signToken(r.rows[0]), user: safeHost(r.rows[0]) });
}));

app.get('/api/auth/me', requireAuth, h(async (req, res) => {
  const r = await q('SELECT * FROM hosts WHERE id=$1', [req.hostId]);
  if (!r.rowCount) return res.status(404).json({ error: 'Account not found.' });
  res.json({ user: safeHost(r.rows[0]) });
}));

/* ================= PROPERTIES (search / browse) ================= */
app.get('/api/properties', h(async (req, res) => {
  const { location, country, category, minPrice, maxPrice, bedrooms, guests, sort } = req.query;
  const limit = Math.min(100, intOr(req.query.limit, 48) || 48);
  const offset = intOr(req.query.offset, 0);
  const where = ["p.status='active'"], params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$n', `$${params.length}`)); };

  if (location) add('(p.location ILIKE $n OR p.title ILIKE $n OR p.country ILIKE $n)', `%${str(location, 80)}%`);
  if (country)  add('p.country ILIKE $n', `%${str(country, 80)}%`);
  if (category && CATEGORIES.includes(category)) add('p.category=$n', category);
  if (minPrice !== undefined && minPrice !== '') add('p.price >= $n', intOr(minPrice));
  if (maxPrice !== undefined && maxPrice !== '') add('p.price <= $n', intOr(maxPrice));
  if (bedrooms !== undefined && bedrooms !== '') add('p.bedrooms >= $n', intOr(bedrooms));
  if (guests   !== undefined && guests   !== '') add('p.guests >= $n', intOr(guests));

  const order = sort === 'price_asc' ? 'p.price ASC, p.created_at DESC'
              : sort === 'price_desc' ? 'p.price DESC, p.created_at DESC'
              : "(p.listing_plan='premium') DESC, (p.listing_plan='featured') DESC, p.created_at DESC";

  const count = await q(`SELECT COUNT(*)::int AS n FROM properties p WHERE ${where.join(' AND ')}`, params);
  const r = await q(
    `SELECT p.*, h.name AS host_name, h.created_at AS host_created
     FROM properties p JOIN hosts h ON h.id=p.host_id
     WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ total: count.rows[0].n, properties: r.rows });
}));

app.get('/api/properties/:id', h(async (req, res) => {
  const r = await q(
    `SELECT p.id, p.host_id, p.title, p.category, p.location, p.country, p.description, p.price,
            p.bedrooms, p.guests, p.land_size, p.amenities, p.images, p.listing_plan, p.status, p.created_at,
            h.name AS host_name, h.created_at AS host_created
     FROM properties p JOIN hosts h ON h.id=p.host_id WHERE p.id=$1`, [intOr(req.params.id, -1)]);
  if (!r.rowCount) return res.status(404).json({ error: 'Property not found.' });
  const prop = r.rows[0];
  let isOwner = false;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try { isOwner = jwt.verify(header.slice(7), JWT_SECRET).sub === prop.host_id; } catch {}
  }
  res.json({ property: { ...prop, host: publicHost(prop), isOwner } });
}));

/* Create property — owners must be authenticated */
app.post('/api/properties', requireAuth, h(async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 120), category = str(b.category, 20), location = str(b.location, 100);
  const country = str(b.country, 80), description = str(b.description, 4000);
  const price = intOr(b.price, -1), bedrooms = intOr(b.bedrooms), guests = intOr(b.guests);
  const landSize = str(b.land_size, 60);
  const amenities = Array.isArray(b.amenities) ? b.amenities.map(a => str(a, 60)).filter(Boolean).slice(0, 30) : [];
  const images = Array.isArray(b.images) ? b.images.filter(isUrl).slice(0, 10) : [];
  if (title.length < 4) return res.status(400).json({ error: 'Please enter a property title (at least 4 characters).' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Please choose a valid category.' });
  if (!location) return res.status(400).json({ error: 'Please enter a location.' });
  if (!country) return res.status(400).json({ error: 'Please select a country.' });
  if (description.length < 10) return res.status(400).json({ error: 'Please add a short description (at least 10 characters).' });
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'Please enter a valid price greater than 0.' });
  if (category === 'Land' && !landSize) return res.status(400).json({ error: 'Please enter the land size.' });
  const r = await q(
    `INSERT INTO properties(host_id,title,category,location,country,description,price,bedrooms,guests,land_size,
      amenities,images,contact_name,contact_phone,contact_email,listing_plan,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'free','active') RETURNING *`,
    [req.hostId, title, category, location, country, description, price, bedrooms, guests,
     category === 'Land' ? landSize : null, amenities, images,
     str(b.contact_name, 80) || null, str(b.contact_phone, 30) || null, str(b.contact_email, 120) || null]);
  res.status(201).json({ property: r.rows[0], message: 'Property saved successfully.' });
}));

/* Update / delete — owner only */
async function ownPropertyOrThrow(hostId, id) {
  const r = await q('SELECT * FROM properties WHERE id=$1', [intOr(id, -1)]);
  if (!r.rowCount) throw new HttpError(404, 'Property not found.');
  if (r.rows[0].host_id !== hostId) throw new HttpError(403, 'You do not have permission to modify this property.');
  return r.rows[0];
}

app.put('/api/properties/:id', requireAuth, h(async (req, res) => {
  const prop = await ownPropertyOrThrow(req.hostId, req.params.id);
  const b = req.body || {};
  const title = str(b.title, 120) || prop.title;
  const category = CATEGORIES.includes(b.category) ? b.category : prop.category;
  const location = str(b.location, 100) || prop.location;
  const country = str(b.country, 80) || prop.country;
  const description = b.description !== undefined ? str(b.description, 4000) : prop.description;
  const price = b.price !== undefined ? intOr(b.price, prop.price) : prop.price;
  const amenities = Array.isArray(b.amenities) ? b.amenities.map(a => str(a, 60)).filter(Boolean).slice(0, 30) : prop.amenities;
  const images = Array.isArray(b.images) ? b.images.filter(isUrl).slice(0, 10) : prop.images;
  if (title.length < 4) return res.status(400).json({ error: 'Title must be at least 4 characters.' });
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'Please enter a valid price.' });
  const r = await q(
    `UPDATE properties SET title=$2,category=$3,location=$4,country=$5,description=$6,price=$7,
      bedrooms=$8,guests=$9,land_size=$10,amenities=$11,images=$12,contact_name=$13,contact_phone=$14,contact_email=$15
     WHERE id=$1 RETURNING *`,
    [prop.id, title, category, location, country, description, price, intOr(b.bedrooms, prop.bedrooms),
     intOr(b.guests, prop.guests), category === 'Land' ? (str(b.land_size, 60) || prop.land_size) : prop.land_size,
     amenities, images, str(b.contact_name, 80) || prop.contact_name, str(b.contact_phone, 30) || prop.contact_phone,
     str(b.contact_email, 120) || prop.contact_email]);
  res.json({ property: r.rows[0], message: 'Property updated successfully.' });
}));

app.delete('/api/properties/:id', requireAuth, h(async (req, res) => {
  const prop = await ownPropertyOrThrow(req.hostId, req.params.id);
  const paid = await q("SELECT COUNT(*)::int AS n FROM bookings WHERE property_id=$1 AND payment_status='paid'", [prop.id]);
  if (paid.rows[0].n > 0)
    return res.status(409).json({ error: 'This property has paid bookings and cannot be deleted. Mark it inactive instead.' });
  await q('DELETE FROM properties WHERE id=$1', [prop.id]);
  res.json({ ok: true, message: 'Property deleted.' });
}));

/* ================= CHECKOUT & BOOKINGS (amounts computed SERVER-SIDE) ================= */
app.post('/api/checkout', h(async (req, res) => {
  const b = req.body || {};
  const propertyId = intOr(b.propertyId, -1);
  const checkIn = str(b.checkIn, 10), checkOutRaw = str(b.checkOut, 10);
  const guests = intOr(b.guests, 1), name = str(b.name, 80), email = str(b.email, 120).toLowerCase(), phone = str(b.phone, 30);
  if (!isDate(checkIn)) return res.status(400).json({ error: 'Please choose a valid check-in date.' });
  if (name.length < 2) return res.status(400).json({ error: 'Please enter your full name.' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const pr = await q("SELECT * FROM properties WHERE id=$1 AND status='active'", [propertyId]);
  if (!pr.rowCount) return res.status(404).json({ error: 'Property not found or unavailable.' });
  const prop = pr.rows[0];
  if (prop.category === 'Land') return res.status(400).json({ error: 'Land purchases use the inquiry flow. Please contact the seller.' });

  const today = new Date().toISOString().slice(0, 10);
  let checkOut = isDate(checkOutRaw) ? checkOutRaw : checkIn;
  if (prop.category === 'Outings' && checkOut <= checkIn) {
    const d = new Date(checkIn + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
    checkOut = d.toISOString().slice(0, 10);
  }
  if (checkIn < today) return res.status(400).json({ error: 'Check-in date cannot be in the past.' });
  if (checkOut <= checkIn) return res.status(400).json({ error: 'Check-out date must be after check-in.' });
  const days = Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
  if (days > 366) return res.status(400).json({ error: 'Bookings are limited to 366 days.' });
  if (guests < 1) return res.status(400).json({ error: 'Please enter the number of guests.' });
  if (prop.guests > 0 && guests > prop.guests)
    return res.status(400).json({ error: `This property accommodates up to ${prop.guests} guests.` });

  const overlap = await q(
    `SELECT 1 FROM bookings WHERE property_id=$1 AND payment_status IN ('paid','pending_payment')
     AND daterange(check_in, check_out, '[]') && daterange($2, $3, '[]')`, [prop.id, checkIn, checkOut]);
  if (overlap.rowCount) return res.status(409).json({ error: 'Those dates are not available. Please choose different dates.' });

  let units, unitLabel;
  if (prop.category === 'Vacation') { units = days; unitLabel = `${days} night${days > 1 ? 's' : ''} × KSh ${prop.price.toLocaleString()}`; }
  else if (prop.category === 'Rent') { units = Math.max(1, Math.ceil(days / 30)); unitLabel = `${units} month${units > 1 ? 's' : ''} × KSh ${prop.price.toLocaleString()}`; }
  else { units = 1; unitLabel = 'Experience booking'; }
  const amount = units * prop.price;
  const { fee } = feeFor(prop.category, amount);

  const ins = await q(
    `INSERT INTO bookings(property_id,host_id,customer_name,customer_email,customer_phone,check_in,check_out,guests,
      amount,platform_fee,host_payout,payment_status,payout_status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unpaid','none') RETURNING *`,
    [prop.id, prop.host_id, name, email, phone || null, checkIn, checkOut, guests, amount, fee, amount - fee]);
  const booking = ins.rows[0];

  if (!stripe) {
    return res.status(503).json({
      error: 'Payment could not be started: online payments are not configured on this server yet. Your booking request has been recorded.',
      bookingId: booking.id, stripeConfigured: false,
    });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [{ quantity: 1, price_data: {
        currency: CURRENCY, unit_amount: amount * 100,
        product_data: { name: `Global Estates — ${prop.title}`, description: `${unitLabel} · ${guests} guest(s)` },
      } }],
      metadata: { kind: 'booking', bookingId: String(booking.id) },
      success_url: `${APP_URL}/#/checkout?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/#/checkout?cancelled=1&booking=${booking.id}`,
    });
    await q("UPDATE bookings SET payment_status='pending_payment', stripe_session_id=$2 WHERE id=$1", [booking.id, session.id]);
    res.json({ url: session.url, bookingId: booking.id, amount, platformFee: fee, hostPayout: amount - fee });
  } catch (e) {
    console.error('Stripe checkout error:', e.message);
    await q("UPDATE bookings SET payment_status='failed' WHERE id=$1", [booking.id]);
    res.status(502).json({ error: 'Payment could not be started. Please try again shortly.' });
  }
}));

async function fulfillPaidSession(session) {
  if (session.metadata?.kind === 'booking') {
    await q(`UPDATE bookings SET payment_status='paid', payout_status='pending', stripe_payment_intent_id=$2, paid_at=NOW()
             WHERE id=$1 AND payment_status<>'paid'`, [Number(session.metadata.bookingId), session.payment_intent || null]);
  } else if (session.metadata?.kind === 'plan') {
    const plan = ['featured', 'premium'].includes(session.metadata.plan) ? session.metadata.plan : null;
    if (plan) await q('UPDATE properties SET listing_plan=$2 WHERE id=$1', [Number(session.metadata.propertyId), plan]);
  }
}
async function handleStripeEvent(event) {
  const s = event.data.object;
  if (event.type === 'checkout.session.completed' && s.payment_status === 'paid') await fulfillPaidSession(s);
  if (event.type === 'checkout.session.expired' && s.metadata?.kind === 'booking')
    await q("UPDATE bookings SET payment_status='cancelled' WHERE id=$1 AND payment_status='pending_payment'", [Number(s.metadata.bookingId)]);
  if (event.type === 'checkout.session.async_payment_failed' && s.metadata?.kind === 'booking')
    await q("UPDATE bookings SET payment_status='failed' WHERE id=$1", [Number(s.metadata.bookingId)]);
}

/* Checkout status — reconciles with Stripe so a booking is only 'paid' when payment is confirmed */
app.get('/api/checkout/status', h(async (req, res) => {
  const sessionId = str(req.query.session_id, 200), bookingId = intOr(req.query.booking, 0);
  if (sessionId && stripe) {
    let session;
    try { session = await stripe.checkout.sessions.retrieve(sessionId); }
    catch { return res.status(404).json({ error: 'Checkout session not found.' }); }
    if (session.payment_status === 'paid') await fulfillPaidSession(session);
    if (session.payment_status === 'expired' && session.metadata?.kind === 'booking')
      await q("UPDATE bookings SET payment_status='cancelled' WHERE id=$1 AND payment_status='pending_payment'", [Number(session.metadata.bookingId)]);
    const bid = Number(session.metadata?.bookingId || 0);
    let booking = null;
    if (bid) {
      const r = await q(`SELECT b.*, p.title, p.location, p.country FROM bookings b JOIN properties p ON p.id=b.property_id WHERE b.id=$1`, [bid]);
      if (r.rowCount) booking = r.rows[0];
    }
    return res.json({
      kind: session.metadata?.kind || 'booking', plan: session.metadata?.plan || null,
      payment_status: session.payment_status, bookingId: bid || null, booking,
    });
  }
  if (bookingId) {
    const r = await q(`SELECT b.*, p.title, p.location, p.country FROM bookings b JOIN properties p ON p.id=b.property_id WHERE b.id=$1`, [bookingId]);
    if (!r.rowCount) return res.status(404).json({ error: 'Booking not found.' });
    const bk = r.rows[0];
    return res.json({ kind: 'booking', payment_status: bk.payment_status === 'pending_payment' ? 'pending' : bk.payment_status, bookingId, booking: bk });
  }
  res.status(400).json({ error: 'Provide session_id or booking.' });
}));

/* ================= LISTING PLAN UPGRADES (real Stripe charges) ================= */
app.post('/api/properties/:id/plan', requireAuth, h(async (req, res) => {
  const prop = await ownPropertyOrThrow(req.hostId, req.params.id);
  const plan = str(req.body.plan, 10);
  if (!['featured', 'premium'].includes(plan)) return res.status(400).json({ error: 'Invalid plan.' });
  const price = PLAN_PRICES[plan];
  if (!stripe) return res.status(503).json({ error: 'Payments are not configured on this server yet, so plan upgrades cannot be charged. Your listing stays on its current plan.' });
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: {
        currency: CURRENCY, unit_amount: price * 100,
        product_data: { name: `Global Estates — ${plan === 'premium' ? 'Premium' : 'Featured'} listing plan`, description: prop.title },
      } }],
      metadata: { kind: 'plan', propertyId: String(prop.id), plan },
      success_url: `${APP_URL}/#/dashboard?plan_session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/#/dashboard?plan_cancelled=1`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Plan checkout error:', e.message);
    res.status(502).json({ error: 'Payment could not be started. Please try again shortly.' });
  }
}));

/* ================= OWNER DASHBOARD ================= */
app.get('/api/owner/dashboard', requireAuth, h(async (req, res) => {
  const me = await q('SELECT * FROM hosts WHERE id=$1', [req.hostId]);
  if (!me.rowCount) return res.status(404).json({ error: 'Account not found.' });
  const props = await q(
    `SELECT p.*, (SELECT COUNT(*)::int FROM bookings b WHERE b.property_id=p.id) AS booking_count
     FROM properties p WHERE p.host_id=$1 ORDER BY p.created_at DESC`, [req.hostId]);
  const bookings = await q(
    `SELECT b.*, p.title AS property_title, p.category FROM bookings b
     JOIN properties p ON p.id=b.property_id WHERE b.host_id=$1 ORDER BY b.created_at DESC LIMIT 200`, [req.hostId]);
  const t = await q(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE payment_status='paid'),0)::int AS gross,
            COALESCE(SUM(platform_fee) FILTER (WHERE payment_status='paid'),0)::int AS fees,
            COALESCE(SUM(host_payout) FILTER (WHERE payment_status='paid'),0)::int AS net,
            COALESCE(SUM(host_payout) FILTER (WHERE payment_status='paid' AND payout_status='pending'),0)::int AS pending_payout,
            COALESCE(SUM(host_payout) FILTER (WHERE payment_status='paid' AND payout_status='requested'),0)::int AS requested,
            COUNT(*) FILTER (WHERE payment_status='paid')::int AS paid_bookings
     FROM bookings WHERE host_id=$1`, [req.hostId]);
  res.json({ owner: safeHost(me.rows[0]), properties: props.rows, bookings: bookings.rows, totals: t.rows[0], planPrices: PLAN_PRICES });
}));

/* Payout request — only records 'requested'; 'transferred' only after a real Stripe transfer succeeds */
app.post('/api/owner/payout/:id', requireAuth, h(async (req, res) => {
  const r = await q('SELECT b.*, h.stripe_account_id FROM bookings b JOIN hosts h ON h.id=b.host_id WHERE b.id=$1', [intOr(req.params.id, -1)]);
  if (!r.rowCount) return res.status(404).json({ error: 'Booking not found.' });
  const bk = r.rows[0];
  if (bk.host_id !== req.hostId) return res.status(403).json({ error: 'Not your booking.' });
  if (bk.payment_status !== 'paid') return res.status(400).json({ error: 'Only paid bookings can be paid out.' });
  if (bk.payout_status === 'transferred') return res.status(409).json({ error: 'This payout has already been transferred.' });
  if (bk.payout_status === 'requested') return res.status(409).json({ error: 'This payout is already being processed.' });

  if (stripe && bk.stripe_account_id) {
    try {
      const tr = await stripe.transfers.create({
        amount: bk.host_payout * 100, currency: CURRENCY,
        destination: bk.stripe_account_id, metadata: { bookingId: String(bk.id) },
      });
      await q("UPDATE bookings SET payout_status='transferred', stripe_transfer_id=$2 WHERE id=$1", [bk.id, tr.id]);
      return res.json({ status: 'transferred', message: 'Payout transferred successfully.', transferId: tr.id });
    } catch (e) {
      console.error('Transfer error:', e.message);
      await q("UPDATE bookings SET payout_status='requested' WHERE id=$1", [bk.id]);
      return res.json({ status: 'requested', message: 'Payout queued. The automatic transfer could not be completed and will be processed manually.' });
    }
  }
  await q("UPDATE bookings SET payout_status='requested' WHERE id=$1", [bk.id]);
  res.json({ status: 'requested', message: 'Payout request recorded. Funds are only marked as transferred once the transfer is confirmed.' });
}));

/* ================= INQUIRIES / CONTACT HOST ================= */
app.post('/api/inquiries', h(async (req, res) => {
  const b = req.body || {};
  const propertyId = intOr(b.propertyId, -1), name = str(b.name, 80), email = str(b.email, 120).toLowerCase();
  const phone = str(b.phone, 30), message = str(b.message, 2000);
  if (!name || !isEmail(email)) return res.status(400).json({ error: 'Please enter your name and a valid email.' });
  if (message.length < 5) return res.status(400).json({ error: 'Please write a short message.' });
  const p = await q('SELECT id FROM properties WHERE id=$1', [propertyId]);
  if (!p.rowCount) return res.status(404).json({ error: 'Property not found.' });
  await q('INSERT INTO inquiries(property_id,name,email,phone,message) VALUES($1,$2,$3,$4,$5)',
    [propertyId, name, email, phone || null, message]);
  res.status(201).json({ ok: true, message: 'Message sent to the host. They will reply to your email.' });
}));

app.get('/api/owner/inquiries', requireAuth, h(async (req, res) => {
  const r = await q(
    `SELECT i.*, p.title AS property_title FROM inquiries i JOIN properties p ON p.id=i.property_id
     WHERE p.host_id=$1 ORDER BY i.created_at DESC LIMIT 200`, [req.hostId]);
  res.json({ inquiries: r.rows });
}));

/* ================= FAVORITES ================= */
app.get('/api/favorites', h(async (req, res) => {
  const device = str(req.query.device, 64);
  if (!device) return res.status(400).json({ error: 'Missing device key.' });
  const r = await q(
    `SELECT p.* FROM properties p JOIN favorites f ON f.property_id=p.id WHERE f.device_key=$1 ORDER BY f.created_at DESC`, [device]);
  res.json({ properties: r.rows });
}));
app.post('/api/favorites', h(async (req, res) => {
  const device = str(req.body.device, 64), propertyId = intOr(req.body.propertyId, -1);
  if (!device || propertyId < 0) return res.status(400).json({ error: 'Invalid favorite request.' });
  await q('INSERT INTO favorites(device_key,property_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [device, propertyId]);
  res.status(201).json({ ok: true });
}));
app.delete('/api/favorites', h(async (req, res) => {
  const device = str(req.query.device, 64), propertyId = intOr(req.query.propertyId, -1);
  await q('DELETE FROM favorites WHERE device_key=$1 AND property_id=$2', [device, propertyId]);
  res.json({ ok: true });
}));

/* ================= Catch-alls ================= */
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

/* ---------------- Boot: schema + seed ---------------- */
async function boot() {
  if (pool) {
    try {
      await pool.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
      console.log('✓ Schema ready');
      if (process.env.SEED_ON_BOOT !== 'false') await seedIfEmpty();
    } catch (e) { console.error('Schema init failed:', e.message); }
  } else {
    console.warn('⚠ DATABASE_URL not set — API will return 503 until configured.');
  }
  app.listen(PORT, () => console.log(`✓ Global Estates running on ${APP_URL}`));
}

async function seedIfEmpty() {
  const c = await pool.query('SELECT COUNT(*)::int AS n FROM properties');
  if (c.rows[0].n > 0) return;
  const hash = await bcrypt.hash('demo1234', 10);
  const host = (await pool.query(
    `INSERT INTO hosts(name,email,password_hash,phone) VALUES('Amina Njeri','demo@global-estates.app',$1,'+254700000000')
     ON CONFLICT (email) DO UPDATE SET email=excluded.email RETURNING id`, [hash])).rows[0];
  const img = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=70`;
  const P = [
    ['Kutus Garden Villa','Rent','Kutus','Kenya',85000,4,6,'A spacious family villa with mature gardens, borehole water and mountain views in quiet Kutus.',["Wi-Fi","Parking","Garden","Borehole water","Security"],[img('photo-1600596542815-ffad4c1539a9'),img('photo-1600585154340-be6161a56a0c')],'featured'],
    ['Westlands Skyline Apartment','Rent','Nairobi','Kenya',120000,3,4,'Modern 3BR apartment with gym, pool and skyline views in the heart of Westlands.',["Gym","Pool","Backup power","Wi-Fi","Elevator"],[img('photo-1522708323590-d24dbb6b0267'),img('photo-1560448204-e02f11c3d0e2')],'free'],
    ['Kampala Heights 2BR','Rent','Kampala','Uganda',65000,2,3,'Bright furnished 2BR near Kololo with fast Wi-Fi and secure parking.',["Wi-Fi","Parking","Furnished","Water backup"],[img('photo-1502672260266-1c1ef2d93688')],'free'],
    ['Shoreditch Loft','Rent','London','United Kingdom',260000,2,3,'Designer loft in Shoreditch with exposed brick, roof terrace and great transport links.',["Wi-Fi","Roof terrace","Furnished","Elevator"],[img('photo-1493809842364-78817add7ffb')],'premium'],
    ['Diani Beach House','Vacation','Diani','Kenya',18000,3,8,'Steps from Diani beach — private pool, chef available, sunset terrace.',["Pool","Beach access","Wi-Fi","Chef on request","AC"],[img('photo-1499793983690-e29da59ef1c2'),img('photo-1540541338287-41700207dee6')],'featured'],
    ['Zanzibar Ocean Villa','Vacation','Zanzibar','Tanzania',25000,4,10,'Beachfront villa with private chef, dhow trips and infinity pool over the Indian Ocean.',["Infinity pool","Beachfront","Chef","Wi-Fi","AC"],[img('photo-1520250497591-112f2f40a3f4'),img('photo-1571896349842-33c89424de2d')],'premium'],
    ['Bali Jungle Pool Villa','Vacation','Ubud','Indonesia',15000,2,4,'Hidden villa above the rice terraces with private pool and daily breakfast.',["Private pool","Breakfast","Wi-Fi","Yoga deck"],[img('photo-1537640538966-79f369143f8f')],'free'],
    ['Clifton Penthouse','Vacation','Cape Town','South Africa',40000,3,6,'Ocean-facing penthouse in Clifton with sunset deck and concierge service.',["Ocean view","Concierge","Wi-Fi","Pool","Parking"],[img('photo-1512917774080-9991f1c4c750')],'free'],
    ['Maasai Mara Safari Day','Outings','Maasai Mara','Kenya',15000,0,6,'Full-day game drive with a certified guide, park fees and bush lunch included.',["Game drive","Guide","Bush lunch","Park fees"],[img('photo-1547471080-7cc2caa01a7e'),img('photo-1516426122078-c23e76319801')],'featured'],
    ['Kigali City & Culture Tour','Outings','Kigali','Rwanda',8000,0,10,'Half-day guided tour of Kigali — markets, memorial museum and craft villages.',["Guide","Transport","Museum entry"],[img('photo-1449824913935-59a10b8d2000')],'free'],
    ['Accra Street Food Walk','Outings','Accra','Ghana',6500,0,8,'Evening food walk through Makola with tastings and a local food historian.',["Tastings","Guide","Transport"],[img('photo-1555396273-367ea4eb4db5')],'free'],
    ['Dubai Desert Evening','Outings','Dubai','United Arab Emirates',22000,0,6,'Dune bashing, camel ride, BBQ dinner and live shows under the stars.',["Hotel pickup","Dinner","Shows","Dune drive"],[img('photo-1512632578888-169bbbc67f33')],'premium'],
    ['1-Acre Farm Plot, Kirinyaga','Land','Kutus','Kenya',1200000,0,0,'Fertile 1-acre plot 15 minutes from Kutus town, ready title deed, water on site.',["Title deed","Water","Road access"],[img('photo-1500382017468-9049fed747ef'),img('photo-1466692476868-aef1dfb1e735')],'free'],
    ['Beach Road Plot, Kilifi','Land','Kilifi','Kenya',3500000,0,0,'Half-acre plot 400m from Kilifi creek — ideal for a boutique hotel or home.',["Title deed","Ocean breeze","Tarmac access"],[img('photo-1500530855697-b586d89ba3ee')],'featured'],
    ['Lakeside Plot, Entebbe','Land','Entebbe','Uganda',2000000,0,0,'Quarter-acre with Lake Victoria views, surveyed and fenced.',["Surveyed","Fenced","Lake view"],[img('photo-1465447142348-e9952c393450')],'free'],
    ['Suburban Lot, Austin','Land','Austin','United States',9500000,0,0,'0.3-acre build-ready lot in fast-growing East Austin with utilities at the road.',["Utilities","Build-ready","Corner lot"],[img('photo-1464822759023-fed622ff2c3b')],'free'],
  ];
  for (const [title,category,location,country,price,beds,guests,desc,amen,images,plan] of P) {
    await pool.query(
      `INSERT INTO properties(host_id,title,category,location,country,description,price,bedrooms,guests,land_size,amenities,images,listing_plan)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [host.id,title,category,location,country,desc,price,beds,guests,
       category==='Land' ? (title.includes('1-Acre')?'1 acre (0.4 ha)':title.includes('Half')?'0.5 acre':title.includes('Quarter')?'0.25 acre':'0.3 acre') : null,
       amen,images,plan]);
  }
  // Demo paid bookings so the dashboard shows real revenue math (10% commission on Vacation)
  const diani = await pool.query("SELECT * FROM properties WHERE title='Diani Beach House'");
  if (diani.rowCount) {
    const p = diani.rows[0], amt = 5 * p.price, fee = Math.round(amt * 0.10);
    await pool.query(
      `INSERT INTO bookings(property_id,host_id,customer_name,customer_email,check_in,check_out,guests,amount,platform_fee,host_payout,payment_status,payout_status,paid_at)
       VALUES($1,$2,'John Mwangi','john@example.com',CURRENT_DATE - 20,CURRENT_DATE - 15,4,$3,$4,$5,'paid','pending',CURRENT_DATE - 21)`,
      [p.id, p.host_id, amt, fee, amt - fee]);
    const amt2 = 3 * p.price, fee2 = Math.round(amt2 * 0.10);
    await pool.query(
      `INSERT INTO bookings(property_id,host_id,customer_name,customer_email,check_in,check_out,guests,amount,platform_fee,host_payout,payment_status,payout_status,paid_at)
       VALUES($1,$2,'Sarah Wanjiru','sarah@example.com',CURRENT_DATE + 10,CURRENT_DATE + 13,2,$3,$4,$5,'paid','requested',CURRENT_DATE - 2)`,
      [p.id, p.host_id, amt2, fee2, amt2 - fee2]);
  }
  console.log('✓ Seeded demo data (demo owner: demo@global-estates.app / demo1234)');
}

boot();
