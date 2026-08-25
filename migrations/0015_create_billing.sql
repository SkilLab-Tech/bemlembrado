-- mig 0015: billing tables. Money is ALWAYS integer cents (BRL by
-- default) — never a float. All rows are tenant-scoped and FK-CASCADE from tenant so
-- a right-to-erasure namespace/tenant delete removes billing history too. Charged amounts are stored here in integer cents; the plan tiers live in application code (src/billing/catalog.ts), not in this schema.

-- One billing subscription per tenant plan binding (history rows allowed). tenant.plan
-- remains the authoritative gating input; subscription tracks the billing lifecycle and,
-- on payment success/failure, is what drives an update to tenant.plan.
CREATE TABLE subscription (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  plan                 TEXT NOT NULL CHECK (plan IN ('open', 'starter', 'pro', 'managed')),
  status               TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  provider             TEXT CHECK (provider IN ('mercadopago', 'stripe', 'manual')),
  external_ref         TEXT,
  current_period_start INTEGER,
  current_period_end   INTEGER,
  created_at           INTEGER NOT NULL,
  canceled_at          INTEGER
);
CREATE INDEX idx_subscription_tenant ON subscription (tenant_id);

-- A charge for a billing period (or a one-off, e.g. a Managed setup fee).
CREATE TABLE invoice (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscription(id) ON DELETE SET NULL,
  amount_cents    INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'BRL',
  status          TEXT NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  period_start    INTEGER,
  period_end      INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_invoice_tenant ON invoice (tenant_id);
CREATE INDEX idx_invoice_subscription ON invoice (subscription_id);

-- A payment attempt/settlement. UNIQUE(provider, external_id) gives webhook idempotency:
-- a provider event id maps to exactly one payment row (SQLite allows multiple NULL
-- external_id, so manual payments are unconstrained).
CREATE TABLE payment (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  invoice_id   TEXT REFERENCES invoice(id) ON DELETE SET NULL,
  provider     TEXT NOT NULL CHECK (provider IN ('mercadopago', 'stripe', 'pix', 'manual')),
  external_id  TEXT,
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'BRL',
  status       TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  paid_at      INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_payment_tenant ON payment (tenant_id);
CREATE INDEX idx_payment_invoice ON payment (invoice_id);
CREATE UNIQUE INDEX idx_payment_provider_ref ON payment (provider, external_id);

-- Founding Members . V1 captures a SIGNAL only (no charge) until the
-- contract is signed (pending outside legal counsel). tenant_id is nullable — a lead
-- may sign up before provisioning a tenant. email is personal data (LGPD).
CREATE TABLE founding_member (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT REFERENCES tenant(id) ON DELETE SET NULL,
  email        TEXT NOT NULL,
  tier         TEXT NOT NULL CHECK (tier IN ('bronze', 'silver', 'gold')),
  amount_cents INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'signal' CHECK (status IN ('signal', 'contracted', 'paid', 'refunded')),
  signal_at    INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_founding_member_tier ON founding_member (tier);
CREATE INDEX idx_founding_member_email ON founding_member (email);
