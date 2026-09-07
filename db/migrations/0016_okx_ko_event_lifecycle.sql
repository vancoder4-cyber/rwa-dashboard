-- Forward repair for the KO X-Perp event first observed before KO entered the
-- reviewed public-company lifecycle registry.
--
-- The later trusted catalog run already records KO as public. This migration
-- supplements only the exact pre-existing OKX KO listed/relisted event so the
-- PostgreSQL publication view exposes the same reviewed lifecycle identity.
-- It never creates an event, changes a product category, or assigns a company
-- lifecycle to the SOXS ETF.

UPDATE analytics.catalog_change_event AS event
SET evidence = event.evidence || jsonb_build_object('lifecycleStatus', 'public')
FROM identity.source AS source,
  identity.instrument_version AS instrument_version,
  identity.asset_version AS asset_version,
  identity.asset AS asset
WHERE source.source_key = 'perp:okx'
  AND event.source_id = source.source_id
  AND instrument_version.instrument_version_id = event.instrument_version_id
  AND instrument_version.source_id = source.source_id
  AND instrument_version.normalized_venue_symbol = 'KO-USD_UM_XPERP-310912'
  AND asset_version.asset_version_id = instrument_version.asset_version_id
  AND asset.asset_id = asset_version.asset_id
  AND asset.asset_key = 'equity:KO'
  AND asset_version.category = 'equity'
  AND asset_version.canonical_underlying = 'KO'
  AND asset_version.identity_status = 'verified'
  AND event.event_type IN ('listed', 'relisted')
  AND event.baseline = false
  AND event.evidence->>'lifecycleStatus' IS DISTINCT FROM 'public';

DO $reviewed_okx_ko_event_lifecycle$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM publication.listing_change_event_v1 AS published
    WHERE published.market = 'perp'
      AND published.venue = 'okx'
      AND published.venue_symbol = 'KO-USD_UM_XPERP-310912'
      AND published.canonical_symbol = 'KO'
      AND published.category = 'equity'
      AND published.identity_status = 'verified'
      AND published.inclusion_status = 'eligible'
      AND published.lifecycle_status IS DISTINCT FROM 'public'
  ) THEN
    RAISE EXCEPTION 'reviewed OKX KO event lifecycle remains inconsistent';
  END IF;
END
$reviewed_okx_ko_event_lifecycle$;

DO $reviewed_okx_soxs_lifecycle_separation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM publication.listing_change_event_v1 AS published
    WHERE published.market = 'perp'
      AND published.venue = 'okx'
      AND published.venue_symbol = 'SOXS-USD_UM_XPERP-310912'
      AND (
        published.canonical_symbol IS DISTINCT FROM 'SOXS'
        OR published.category IS DISTINCT FROM 'etf'
        OR published.venue_category IS DISTINCT FROM 'equity'
        OR published.lifecycle_status IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'reviewed OKX SOXS ETF product category and company lifecycle are conflated';
  END IF;
END
$reviewed_okx_soxs_lifecycle_separation$;
