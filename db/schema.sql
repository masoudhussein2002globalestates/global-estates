CREATE TABLE IF NOT EXISTS hosts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone TEXT,
  stripe_account_id TEXT,
  stripe_onboarding TEXT NOT NULL DEFAULT 'not_started',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY,
  host_id INT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Rent','Vacation','Outings','Land')),
  location TEXT NOT NULL,
  country TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INT NOT NULL CHECK (price >= 0),
  bedrooms INT NOT NULL DEFAULT 0,
  guests INT NOT NULL DEFAULT 0,
  land_size TEXT,
  amenities TEXT[] NOT NULL DEFAULT '{}',
  images TEXT[] NOT NULL DEFAULT '{}',
  contact_name TEXT, contact_phone TEXT, contact_email TEXT,
  listing_plan TEXT NOT NULL DEFAULT 'free' CHECK (listing_plan IN ('free','featured','premium')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  property_id INT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  host_id INT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  guests INT NOT NULL DEFAULT 1,
  amount INT NOT NULL,
  platform_fee INT NOT NULL,
  host_payout INT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid','pending_payment','paid','failed','cancelled')),
  payout_status TEXT NOT NULL DEFAULT 'none'
    CHECK (payout_status IN ('none','pending','requested','transferred')),
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_transfer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS favorites (
  device_key TEXT NOT NULL,
  property_id INT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_key, property_id)
);

CREATE TABLE IF NOT EXISTS inquiries (
  id SERIAL PRIMARY KEY,
  property_id INT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_properties_category   ON properties(category);
CREATE INDEX IF NOT EXISTS idx_properties_country    ON properties(country);
CREATE INDEX IF NOT EXISTS idx_properties_status     ON properties(status);
CREATE INDEX IF NOT EXISTS idx_properties_plan       ON properties(listing_plan);
CREATE INDEX IF NOT EXISTS idx_properties_created    ON properties(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_property     ON bookings(property_id);
CREATE INDEX IF NOT EXISTS idx_bookings_host         ON bookings(host_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status       ON bookings(payment_status);
CREATE INDEX IF NOT EXISTS idx_favorites_device      ON favorites(device_key);
CREATE INDEX IF NOT EXISTS idx_inquiries_property    ON inquiries(property_id);
