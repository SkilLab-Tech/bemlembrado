-- mig 0017: one flat invoice per (subscription, period). The usage→billing
-- rollup is idempotent so a cron re-run is safe; this partial UNIQUE index is the race-safe
-- backstop against a concurrent double-run creating two invoices for the same period. It is
-- PARTIAL (both columns NOT NULL) so manual/ad-hoc invoices with a null subscription or a
-- null period are unaffected. Additive-only; applies clean from zero after 0016.
CREATE UNIQUE INDEX idx_invoice_subscription_period
  ON invoice (subscription_id, period_start)
  WHERE subscription_id IS NOT NULL AND period_start IS NOT NULL;
