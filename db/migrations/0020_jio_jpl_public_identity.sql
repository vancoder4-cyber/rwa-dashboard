-- Forward-only reviewed lifecycle repair for the two exact venue products that
-- retained the historical JIO code after Jio Platforms Limited began public
-- trading on 2026-10-28 under NSE symbol JPL. This migration never creates or
-- deletes a catalog lifecycle event. It rebinds the already-admitted exact
-- instrument versions and supplements only their existing confirmed event
-- evidence so the safe publication projection is JPL / Equity / Public.

INSERT INTO identity.asset (asset_key)
VALUES ('equity:JPL')
ON CONFLICT (asset_key) DO NOTHING;

INSERT INTO identity.asset_version
  (asset_id, category, canonical_underlying, display_name, market_origin,
   identity_status, identity_fingerprint, valid_from)
SELECT asset.asset_id, 'equity', 'JPL', 'Jio Platforms Limited', 'unknown',
  'verified',
  encode(digest(convert_to(concat(
    '[',
    to_json('equity:JPL'::text)::text, ',',
    to_json('equity'::text)::text, ',',
    to_json('JPL'::text)::text, ',',
    to_json('Jio Platforms Limited'::text)::text, ',',
    to_json('unknown'::text)::text, ',',
    to_json('verified'::text)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex'),
  COALESCE((
    SELECT min(instrument_version.valid_from)
    FROM identity.source AS source
    JOIN identity.instrument AS instrument
      ON instrument.source_id = source.source_id
    JOIN identity.instrument_version AS instrument_version
      ON instrument_version.instrument_id = instrument.instrument_id
     AND instrument_version.source_id = source.source_id
    JOIN identity.asset_version AS old_asset_version
      ON old_asset_version.asset_version_id = instrument_version.asset_version_id
    WHERE (source.source_key, instrument.official_product_key) IN (
      ('perp:tradexyz', 'XYZ:JIO'),
      ('perp:gate', 'JIO_USDT')
    )
      AND old_asset_version.category = 'pre-ipo'
      AND old_asset_version.canonical_underlying = 'JIO'
  ), clock_timestamp())
FROM identity.asset AS asset
WHERE asset.asset_key = 'equity:JPL'
  AND NOT EXISTS (
    SELECT 1
    FROM identity.asset_version AS current
    WHERE current.asset_id = asset.asset_id
      AND current.valid_to IS NULL
  );

UPDATE identity.asset_version AS asset_version
SET display_name = 'Jio Platforms Limited',
  identity_fingerprint = encode(digest(convert_to(concat(
    '[',
    to_json(asset.asset_key)::text, ',',
    to_json(asset_version.category)::text, ',',
    to_json(asset_version.canonical_underlying)::text, ',',
    to_json('Jio Platforms Limited'::text)::text, ',',
    to_json(asset_version.market_origin)::text, ',',
    to_json(asset_version.identity_status)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex')
FROM identity.asset AS asset
WHERE asset.asset_id = asset_version.asset_id
  AND asset.asset_key = 'equity:JPL'
  AND asset_version.valid_to IS NULL
  AND asset_version.category = 'equity'
  AND asset_version.canonical_underlying = 'JPL'
  AND asset_version.identity_status = 'verified'
  AND asset_version.display_name IS DISTINCT FROM 'Jio Platforms Limited';

-- Rebind every historical and current version of only these two exact official
-- products. Keeping the existing instrument_version_id preserves every event
-- foreign key and cannot synthesize a listed/relisted fact.
WITH correction(source_key, official_product_key) AS (
  VALUES
    ('perp:tradexyz', 'XYZ:JIO'),
    ('perp:gate', 'JIO_USDT')
)
UPDATE identity.instrument_version AS instrument_version
SET asset_version_id = target_asset_version.asset_version_id,
  identity_fingerprint = encode(digest(convert_to(concat(
    '[',
    to_json(source.source_key)::text, ',',
    to_json(instrument.official_product_key)::text, ',',
    to_json(instrument_version.official_venue_symbol)::text, ',',
    to_json(instrument_version.instrument_type)::text, ',',
    to_json(btrim(target_asset_version.identity_fingerprint::text))::text, ',',
    to_json(instrument_version.official_status)::text, ',',
    to_json(instrument_version.identity_status)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex')
FROM correction,
  identity.source AS source,
  identity.instrument AS instrument,
  identity.asset_version AS old_asset_version,
  identity.asset AS target_asset,
  identity.asset_version AS target_asset_version
WHERE source.source_key = correction.source_key
  AND instrument.source_id = source.source_id
  AND instrument.official_product_key = correction.official_product_key
  AND instrument_version.instrument_id = instrument.instrument_id
  AND instrument_version.source_id = source.source_id
  AND old_asset_version.asset_version_id = instrument_version.asset_version_id
  AND old_asset_version.category = 'pre-ipo'
  AND old_asset_version.canonical_underlying = 'JIO'
  AND target_asset.asset_key = 'equity:JPL'
  AND target_asset_version.asset_id = target_asset.asset_id
  AND target_asset_version.valid_to IS NULL
  AND target_asset_version.category = 'equity'
  AND target_asset_version.canonical_underlying = 'JPL'
  AND target_asset_version.identity_status = 'verified';

-- Align the fingerprint of every version already bound to the reviewed target
-- identity. This matters if JPL existed before this migration and its reviewed
-- display name changed; the binding itself is not broadened by this update.
UPDATE identity.instrument_version AS instrument_version
SET identity_fingerprint = encode(digest(convert_to(concat(
    '[',
    to_json(source.source_key)::text, ',',
    to_json(instrument.official_product_key)::text, ',',
    to_json(instrument_version.official_venue_symbol)::text, ',',
    to_json(instrument_version.instrument_type)::text, ',',
    to_json(btrim(target_asset_version.identity_fingerprint::text))::text, ',',
    to_json(instrument_version.official_status)::text, ',',
    to_json(instrument_version.identity_status)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex')
FROM identity.source AS source,
  identity.instrument AS instrument,
  identity.asset AS target_asset,
  identity.asset_version AS target_asset_version
WHERE instrument_version.instrument_id = instrument.instrument_id
  AND instrument_version.source_id = source.source_id
  AND instrument.source_id = source.source_id
  AND target_asset.asset_key = 'equity:JPL'
  AND target_asset_version.asset_id = target_asset.asset_id
  AND target_asset_version.valid_to IS NULL
  AND target_asset_version.category = 'equity'
  AND target_asset_version.canonical_underlying = 'JPL'
  AND target_asset_version.identity_status = 'verified'
  AND instrument_version.asset_version_id = target_asset_version.asset_version_id;

-- The publication view deliberately keeps venue category and issuer lifecycle
-- separate from canonical identity. Supplement those presentation fields only
-- on existing confirmed, non-baseline listed/relisted facts for the two exact
-- products; event id, type, time and source remain unchanged.
WITH correction(source_key, official_product_key) AS (
  VALUES
    ('perp:tradexyz', 'XYZ:JIO'),
    ('perp:gate', 'JIO_USDT')
)
UPDATE analytics.catalog_change_event AS event
SET evidence = event.evidence || jsonb_build_object(
  'canonicalUnderlying', 'JPL',
  'name', 'Jio Platforms Limited',
  'category', 'equity',
  'venueCategory', 'equity',
  'lifecycleStatus', 'public',
  'identityStatus', 'verified',
  'inclusionStatus', 'eligible'
)
FROM correction,
  identity.source AS source,
  identity.instrument AS instrument,
  identity.instrument_version AS instrument_version,
  identity.asset AS target_asset,
  identity.asset_version AS target_asset_version
WHERE source.source_key = correction.source_key
  AND event.source_id = source.source_id
  AND instrument.source_id = source.source_id
  AND instrument.official_product_key = correction.official_product_key
  AND instrument_version.instrument_id = instrument.instrument_id
  AND instrument_version.source_id = source.source_id
  AND instrument_version.instrument_version_id = event.instrument_version_id
  AND target_asset.asset_key = 'equity:JPL'
  AND target_asset_version.asset_id = target_asset.asset_id
  AND target_asset_version.valid_to IS NULL
  AND target_asset_version.category = 'equity'
  AND target_asset_version.canonical_underlying = 'JPL'
  AND target_asset_version.identity_status = 'verified'
  AND instrument_version.asset_version_id = target_asset_version.asset_version_id
  AND event.event_type IN ('listed', 'relisted')
  AND event.status = 'confirmed'
  AND event.baseline = false
  AND (
    event.evidence->>'canonicalUnderlying' IS DISTINCT FROM 'JPL'
    OR event.evidence->>'name' IS DISTINCT FROM 'Jio Platforms Limited'
    OR event.evidence->>'category' IS DISTINCT FROM 'equity'
    OR event.evidence->>'venueCategory' IS DISTINCT FROM 'equity'
    OR event.evidence->>'lifecycleStatus' IS DISTINCT FROM 'public'
    OR event.evidence->>'identityStatus' IS DISTINCT FROM 'verified'
    OR event.evidence->>'inclusionStatus' IS DISTINCT FROM 'eligible'
  );

-- Retire the legacy identity only after every reference has moved. Any unknown
-- third product keeps it current and makes the assertions below fail closed.
UPDATE identity.asset_version AS old_asset_version
SET valid_to = clock_timestamp()
FROM identity.asset AS old_asset
WHERE old_asset.asset_id = old_asset_version.asset_id
  AND old_asset.asset_key = 'pre-ipo:JIO'
  AND old_asset_version.valid_to IS NULL
  AND old_asset_version.valid_from < clock_timestamp()
  AND NOT EXISTS (
    SELECT 1
    FROM identity.instrument_version AS instrument_version
    WHERE instrument_version.asset_version_id = old_asset_version.asset_version_id
  );

DO $reviewed_jio_jpl_public_identity$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM identity.asset AS asset
    JOIN identity.asset_version AS current
      ON current.asset_id = asset.asset_id
     AND current.valid_to IS NULL
    WHERE asset.asset_key = 'equity:JPL'
      AND current.category = 'equity'
      AND current.canonical_underlying = 'JPL'
      AND current.display_name = 'Jio Platforms Limited'
      AND current.identity_status = 'verified'
  ) THEN
    RAISE EXCEPTION 'reviewed JPL public identity was not established';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('perp:tradexyz', 'XYZ:JIO'),
      ('perp:gate', 'JIO_USDT')
    ) AS expected(source_key, official_product_key)
    JOIN identity.source AS source ON source.source_key = expected.source_key
    JOIN identity.instrument AS instrument
      ON instrument.source_id = source.source_id
     AND instrument.official_product_key = expected.official_product_key
    JOIN identity.instrument_version AS instrument_version
      ON instrument_version.instrument_id = instrument.instrument_id
     AND instrument_version.source_id = source.source_id
    JOIN identity.asset_version AS asset_version
      ON asset_version.asset_version_id = instrument_version.asset_version_id
    JOIN identity.asset AS asset ON asset.asset_id = asset_version.asset_id
    WHERE asset.asset_key <> 'equity:JPL'
      OR asset_version.category <> 'equity'
      OR asset_version.canonical_underlying <> 'JPL'
      OR asset_version.valid_to IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'an exact reviewed JIO product version remains on its legacy identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM publication.listing_change_event_v1 AS published
    WHERE (published.market, published.venue, published.venue_symbol) IN (
      ('perp', 'tradexyz', 'XYZ:JIO'),
      ('perp', 'gate', 'JIO_USDT')
    )
      AND published.event_type IN ('listed', 'relisted')
      AND (
        published.canonical_symbol IS DISTINCT FROM 'JPL'
        OR published.display_name IS DISTINCT FROM 'Jio Platforms Limited'
        OR published.category IS DISTINCT FROM 'equity'
        OR published.venue_category IS DISTINCT FROM 'equity'
        OR published.lifecycle_status IS DISTINCT FROM 'public'
        OR published.identity_status IS DISTINCT FROM 'verified'
        OR published.inclusion_status IS DISTINCT FROM 'eligible'
      )
  ) THEN
    RAISE EXCEPTION 'reviewed JIO listing events do not publish as JPL equity/public';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM identity.instrument_version AS instrument_version
    JOIN identity.asset_version AS asset_version
      ON asset_version.asset_version_id = instrument_version.asset_version_id
    JOIN identity.asset AS asset ON asset.asset_id = asset_version.asset_id
    WHERE asset.asset_key = 'pre-ipo:JIO'
  ) THEN
    RAISE EXCEPTION 'an instrument version remains bound to legacy pre-ipo:JIO';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM identity.asset AS asset
    JOIN identity.asset_version AS current
      ON current.asset_id = asset.asset_id
     AND current.valid_to IS NULL
    WHERE asset.asset_key = 'pre-ipo:JIO'
  ) THEN
    RAISE EXCEPTION 'legacy pre-ipo:JIO identity remains current';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM identity.instrument_version AS current
    JOIN identity.asset_version AS asset_version
      ON asset_version.asset_version_id = current.asset_version_id
    WHERE current.valid_to IS NULL
      AND current.identity_status = 'verified'
      AND asset_version.valid_to IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'current verified instrument remains bound to an expired asset version';
  END IF;
END
$reviewed_jio_jpl_public_identity$;
