-- Forward repair for the real HK0992USDT listing event that was first
-- observed before the exact Binance venue code was normalized to LENOVO.
--
-- The event itself remains the same confirmed listed/relisted fact. This
-- migration only supplements its public identity evidence so PostgreSQL, the
-- Runtime Cache and every Dashboard API consumer expose the same reviewed
-- Lenovo name, category and public-company lifecycle.

UPDATE analytics.catalog_change_event AS event
SET evidence = event.evidence || jsonb_build_object(
  'canonicalUnderlying', 'LENOVO',
  'name', 'Lenovo Group Limited',
  'category', 'equity',
  'venueCategory', 'equity',
  'lifecycleStatus', 'public',
  'identityStatus', 'verified',
  'inclusionStatus', 'eligible'
)
FROM identity.source AS source,
  identity.instrument_version AS instrument_version,
  identity.asset_version AS asset_version,
  identity.asset AS asset
WHERE source.source_key = 'perp:binance'
  AND event.source_id = source.source_id
  AND instrument_version.instrument_version_id = event.instrument_version_id
  AND instrument_version.source_id = source.source_id
  AND instrument_version.normalized_venue_symbol = 'HK0992USDT'
  AND instrument_version.valid_to IS NULL
  AND asset_version.asset_version_id = instrument_version.asset_version_id
  AND asset.asset_id = asset_version.asset_id
  AND asset.asset_key = 'equity:LENOVO'
  AND asset_version.category = 'equity'
  AND asset_version.canonical_underlying = 'LENOVO'
  AND asset_version.display_name = 'Lenovo Group Limited'
  AND asset_version.identity_status = 'verified'
  AND event.event_type IN ('listed', 'relisted')
  AND event.status = 'confirmed'
  AND event.baseline = false
  AND (
    event.evidence->>'canonicalUnderlying' IS DISTINCT FROM 'LENOVO'
    OR event.evidence->>'name' IS DISTINCT FROM 'Lenovo Group Limited'
    OR event.evidence->>'category' IS DISTINCT FROM 'equity'
    OR event.evidence->>'venueCategory' IS DISTINCT FROM 'equity'
    OR event.evidence->>'lifecycleStatus' IS DISTINCT FROM 'public'
    OR event.evidence->>'identityStatus' IS DISTINCT FROM 'verified'
    OR event.evidence->>'inclusionStatus' IS DISTINCT FROM 'eligible'
  );

DO $reviewed_binance_lenovo_event_identity$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM publication.listing_change_event_v1 AS published
    WHERE published.market = 'perp'
      AND published.venue = 'binance'
      AND published.venue_symbol = 'HK0992USDT'
      AND published.event_type IN ('listed', 'relisted')
      AND (
        published.canonical_symbol IS DISTINCT FROM 'LENOVO'
        OR published.display_name IS DISTINCT FROM 'Lenovo Group Limited'
        OR published.category IS DISTINCT FROM 'equity'
        OR published.venue_category IS DISTINCT FROM 'equity'
        OR published.lifecycle_status IS DISTINCT FROM 'public'
        OR published.identity_status IS DISTINCT FROM 'verified'
        OR published.inclusion_status IS DISTINCT FROM 'eligible'
      )
  ) THEN
    RAISE EXCEPTION 'reviewed Binance Lenovo event identity remains inconsistent';
  END IF;
END
$reviewed_binance_lenovo_event_identity$;

DO $no_legacy_binance_hk0992_event_identity$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM analytics.catalog_change_event AS event
    JOIN identity.source AS source ON source.source_id = event.source_id
    WHERE source.source_key = 'perp:binance'
      AND event.event_type IN ('listed', 'relisted')
      AND event.status = 'confirmed'
      AND event.baseline = false
      AND event.evidence->>'listingKey' = 'perp:binance:HK0992USDT'
      AND event.evidence->>'canonicalUnderlying' IS DISTINCT FROM 'LENOVO'
  ) THEN
    RAISE EXCEPTION 'legacy HK0992 canonical remains in the Binance Lenovo event evidence';
  END IF;
END
$no_legacy_binance_hk0992_event_identity$;
