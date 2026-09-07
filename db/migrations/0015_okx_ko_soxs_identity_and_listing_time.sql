-- Forward repair for the two OKX X-Perps first observed on 2026-09-07.
--
-- The official live catalog already admitted these exact products and the
-- normal trusted-directory diff created their listing events. This migration
-- only aligns the bound Dashboard display identity and supplements the
-- independently detected events with OKX's official listTime. It never creates
-- a lifecycle event or widens admission beyond the two exact product keys.

WITH correction(asset_key, canonical_underlying, category, display_name) AS (
  VALUES
    ('equity:KO', 'KO', 'equity', 'The Coca-Cola Company'),
    ('etf:SOXS', 'SOXS', 'etf', 'Direxion Daily Semiconductor Bear 3X ETF')
)
UPDATE identity.asset_version AS asset_version
SET display_name = correction.display_name,
  identity_fingerprint = encode(digest(convert_to(concat(
    '[',
    to_json(asset.asset_key)::text, ',',
    to_json(asset_version.category)::text, ',',
    to_json(asset_version.canonical_underlying)::text, ',',
    to_json(correction.display_name)::text, ',',
    to_json(asset_version.market_origin)::text, ',',
    to_json(asset_version.identity_status)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex')
FROM identity.asset AS asset, correction
WHERE asset.asset_id = asset_version.asset_id
  AND asset.asset_key = correction.asset_key
  AND asset_version.category = correction.category
  AND asset_version.canonical_underlying = correction.canonical_underlying
  AND asset_version.identity_status = 'verified'
  AND asset_version.display_name IS DISTINCT FROM correction.display_name;

UPDATE identity.instrument_version AS instrument_version
SET identity_fingerprint = encode(digest(convert_to(concat(
    '[',
    to_json(source.source_key)::text, ',',
    to_json(instrument.official_product_key)::text, ',',
    to_json(instrument_version.official_venue_symbol)::text, ',',
    to_json(instrument_version.instrument_type)::text, ',',
    to_json(btrim(asset_version.identity_fingerprint::text))::text, ',',
    to_json(instrument_version.official_status)::text, ',',
    to_json(instrument_version.identity_status)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex')
FROM identity.asset_version AS asset_version,
  identity.asset AS asset,
  identity.source AS source,
  identity.instrument AS instrument
WHERE asset_version.asset_version_id = instrument_version.asset_version_id
  AND asset.asset_id = asset_version.asset_id
  AND asset.asset_key IN ('equity:KO', 'etf:SOXS')
  AND source.source_id = instrument_version.source_id
  AND instrument.instrument_id = instrument_version.instrument_id
  AND instrument.source_id = instrument_version.source_id;

WITH correction(official_product_key, official_listed_at) AS (
  VALUES
    ('KO-USD_UM_XPERP-310912', '2026-09-07 08:45:00.112+00'::timestamptz),
    ('SOXS-USD_UM_XPERP-310912', '2026-09-07 08:30:00.170+00'::timestamptz)
)
UPDATE analytics.catalog_change_event AS event
SET official_listed_at = correction.official_listed_at,
  time_basis = 'official',
  evidence = event.evidence || jsonb_build_object(
    'officialListedAt', correction.official_listed_at,
    'timeBasis', 'official'
  )
FROM identity.source AS source,
  identity.instrument_version AS instrument_version,
  correction
WHERE source.source_key = 'perp:okx'
  AND instrument_version.source_id = source.source_id
  AND instrument_version.normalized_venue_symbol = correction.official_product_key
  AND event.source_id = source.source_id
  AND event.instrument_version_id = instrument_version.instrument_version_id
  AND event.event_type IN ('listed', 'relisted')
  AND event.baseline = false
  AND event.official_listed_at IS NULL
  AND event.observed_at >= correction.official_listed_at;

DO $reviewed_okx_ko_soxs_repair$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('equity:KO', 'The Coca-Cola Company'),
      ('etf:SOXS', 'Direxion Daily Semiconductor Bear 3X ETF')
    ) AS expected(asset_key, display_name)
    JOIN identity.asset AS asset ON asset.asset_key = expected.asset_key
    JOIN identity.asset_version AS asset_version ON asset_version.asset_id = asset.asset_id
    WHERE asset_version.identity_status = 'verified'
      AND asset_version.display_name <> expected.display_name
  ) THEN
    RAISE EXCEPTION 'reviewed OKX KO/SOXS identity names remain inconsistent';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('KO-USD_UM_XPERP-310912', '2026-09-07 08:45:00.112+00'::timestamptz),
      ('SOXS-USD_UM_XPERP-310912', '2026-09-07 08:30:00.170+00'::timestamptz)
    ) AS expected(official_product_key, official_listed_at)
    JOIN identity.source AS source ON source.source_key = 'perp:okx'
    JOIN identity.instrument_version AS instrument_version
      ON instrument_version.source_id = source.source_id
     AND instrument_version.normalized_venue_symbol = expected.official_product_key
    JOIN analytics.catalog_change_event AS event
      ON event.source_id = source.source_id
     AND event.instrument_version_id = instrument_version.instrument_version_id
     AND event.event_type IN ('listed', 'relisted')
     AND event.baseline = false
    WHERE event.official_listed_at IS DISTINCT FROM expected.official_listed_at
      OR event.time_basis <> 'official'
  ) THEN
    RAISE EXCEPTION 'reviewed OKX KO/SOXS event times remain inconsistent';
  END IF;
END
$reviewed_okx_ko_soxs_repair$;
