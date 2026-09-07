-- Dated identity repair for Binance's 2026-09-07 TradFi perpetual launch.
-- Official Binance notice 89a035c3ee0e4b7782bf0089323d8e78 identifies
-- BYDUSDT as BYD Company Limited H shares (HKEX 1211) and HK0992USDT as
-- Lenovo Group Limited (HKEX 0992). BYD and Lenovo issuer records confirm the
-- legal names and listing codes. This migration changes identity only; it does
-- not insert, update or delete a catalog lifecycle event.

INSERT INTO identity.asset (asset_key)
VALUES ('equity:BYD'), ('equity:LENOVO')
ON CONFLICT (asset_key) DO NOTHING;

WITH correction(asset_key, canonical_underlying, display_name) AS (
  VALUES
    ('equity:BYD', 'BYD', 'BYD Company Limited'),
    ('equity:LENOVO', 'LENOVO', 'Lenovo Group Limited')
)
INSERT INTO identity.asset_version
  (asset_id, category, canonical_underlying, display_name, market_origin,
   identity_status, identity_fingerprint, valid_from)
SELECT asset.asset_id, 'equity', correction.canonical_underlying,
  correction.display_name, 'unknown', 'verified',
  encode(digest(convert_to(concat(
    '[',
    to_json(correction.asset_key)::text, ',',
    to_json('equity'::text)::text, ',',
    to_json(correction.canonical_underlying)::text, ',',
    to_json(correction.display_name)::text, ',',
    to_json('unknown'::text)::text, ',',
    to_json('verified'::text)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex'),
  clock_timestamp()
FROM correction
JOIN identity.asset AS asset ON asset.asset_key = correction.asset_key
WHERE NOT EXISTS (
  SELECT 1
  FROM identity.asset_version AS current
  WHERE current.asset_id = asset.asset_id
    AND current.valid_to IS NULL
);

WITH correction(asset_key, canonical_underlying, display_name) AS (
  VALUES
    ('equity:BYD', 'BYD', 'BYD Company Limited'),
    ('equity:LENOVO', 'LENOVO', 'Lenovo Group Limited')
)
UPDATE identity.asset_version AS asset_version
SET display_name = correction.display_name,
  identity_fingerprint = encode(digest(convert_to(concat(
    '[',
    to_json(correction.asset_key)::text, ',',
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
  AND asset_version.valid_to IS NULL
  AND asset_version.category = 'equity'
  AND asset_version.canonical_underlying = correction.canonical_underlying
  AND asset_version.identity_status = 'verified'
  AND asset_version.display_name IS DISTINCT FROM correction.display_name;

-- If the old collector already persisted the literal Binance base code before
-- this migration ran, bind only that exact official product to Lenovo. No bare
-- ticker or fuzzy cross-venue rewrite is permitted.
UPDATE identity.instrument_version AS instrument_version
SET asset_version_id = corrected_asset_version.asset_version_id,
  identity_fingerprint = encode(digest(convert_to(concat(
    '[',
    to_json(source.source_key)::text, ',',
    to_json(instrument.official_product_key)::text, ',',
    to_json(instrument_version.official_venue_symbol)::text, ',',
    to_json(instrument_version.instrument_type)::text, ',',
    to_json(btrim(corrected_asset_version.identity_fingerprint::text))::text, ',',
    to_json(instrument_version.official_status)::text, ',',
    to_json(instrument_version.identity_status)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex')
FROM identity.source AS source,
  identity.instrument AS instrument,
  identity.asset_version AS old_asset_version,
  identity.asset AS corrected_asset,
  identity.asset_version AS corrected_asset_version
WHERE source.source_key = 'perp:binance'
  AND instrument.source_id = source.source_id
  AND instrument.official_product_key = 'HK0992USDT'
  AND instrument_version.instrument_id = instrument.instrument_id
  AND instrument_version.source_id = source.source_id
  AND instrument_version.valid_to IS NULL
  AND old_asset_version.asset_version_id = instrument_version.asset_version_id
  AND old_asset_version.category = 'equity'
  AND old_asset_version.canonical_underlying = 'HK0992'
  AND corrected_asset.asset_key = 'equity:LENOVO'
  AND corrected_asset_version.asset_id = corrected_asset.asset_id
  AND corrected_asset_version.valid_to IS NULL
  AND corrected_asset_version.category = 'equity'
  AND corrected_asset_version.canonical_underlying = 'LENOVO'
  AND corrected_asset_version.identity_status = 'verified';

-- Asset-name fingerprint changes must propagate to every bound instrument so
-- the next trusted catalog retry remains identical instead of appearing as
-- unexplained identity drift.
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
  AND asset.asset_key IN ('equity:BYD', 'equity:LENOVO')
  AND source.source_id = instrument_version.source_id
  AND instrument.instrument_id = instrument_version.instrument_id
  AND instrument.source_id = instrument_version.source_id;

UPDATE identity.asset_version AS old_asset_version
SET valid_to = clock_timestamp()
FROM identity.asset AS old_asset
WHERE old_asset.asset_id = old_asset_version.asset_id
  AND old_asset.asset_key = 'equity:HK0992'
  AND old_asset_version.valid_to IS NULL
  AND old_asset_version.valid_from < clock_timestamp()
  AND NOT EXISTS (
    SELECT 1
    FROM identity.instrument_version AS instrument_version
    WHERE instrument_version.asset_version_id = old_asset_version.asset_version_id
  );

DO $reviewed_binance_hk_equities$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('equity:BYD', 'BYD', 'BYD Company Limited'),
      ('equity:LENOVO', 'LENOVO', 'Lenovo Group Limited')
    ) AS expected(asset_key, canonical_underlying, display_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM identity.asset AS asset
      JOIN identity.asset_version AS current
        ON current.asset_id = asset.asset_id
       AND current.valid_to IS NULL
       AND current.identity_status = 'verified'
      WHERE asset.asset_key = expected.asset_key
        AND current.category = 'equity'
        AND current.canonical_underlying = expected.canonical_underlying
        AND current.display_name = expected.display_name
    )
  ) THEN
    RAISE EXCEPTION 'reviewed BYD/Lenovo identities were not established';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM identity.source AS source
    JOIN identity.instrument AS instrument ON instrument.source_id = source.source_id
    JOIN identity.instrument_version AS current
      ON current.instrument_id = instrument.instrument_id
     AND current.valid_to IS NULL
    JOIN identity.asset_version AS asset_version
      ON asset_version.asset_version_id = current.asset_version_id
    WHERE source.source_key = 'perp:binance'
      AND instrument.official_product_key = 'HK0992USDT'
      AND (asset_version.category <> 'equity' OR asset_version.canonical_underlying <> 'LENOVO')
  ) THEN
    RAISE EXCEPTION 'Binance HK0992USDT is not bound to the reviewed Lenovo identity';
  END IF;
END
$reviewed_binance_hk_equities$;
