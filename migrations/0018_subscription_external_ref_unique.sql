-- mig 0018: one subscription per (provider, external_ref). The Stripe
-- webhook creates a subscription on checkout.session.completed keyed by the Stripe
-- subscription id (external_ref); a redelivered event must not create a duplicate. This
-- partial UNIQUE index is the race-safe backstop (the handler pre-checks for the friendly
-- path). PARTIAL (both cols NOT NULL) so manual subscriptions with a null external_ref are
-- unaffected. Additive-only; applies clean from zero after 0017.
CREATE UNIQUE INDEX idx_subscription_provider_ref
  ON subscription (provider, external_ref)
  WHERE provider IS NOT NULL AND external_ref IS NOT NULL;
