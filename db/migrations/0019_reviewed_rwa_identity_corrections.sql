-- Forward-only reviewed identity repair for three exact production drifts:
-- Gate H100 is compute-rental capacity (Commodity) even though Gate's broad
-- product class is `indices`; MOONSHOT and OURA remain private companies even
-- where Bitget/OKX expose only a broad stock category. The correction is
-- identity metadata for already admitted official products. It never writes
-- analytics.catalog_change_event; lifecycle-event evidence remains immutable
-- and the publication view derives canonical identity from the rebound version.

INSERT INTO identity.asset (asset_key)
VALUES ('commodity:H100'), ('pre-ipo:MOONSHOT'), ('pre-ipo:OURA')
ON CONFLICT (asset_key) DO NOTHING;

WITH target(asset_key, category, canonical_underlying, display_name) AS (
  VALUES
    ('commodity:H100', 'commodity', 'H100', 'H100'),
    ('pre-ipo:MOONSHOT', 'pre-ipo', 'MOONSHOT', 'Moonshot AI (Pre-IPO)'),
    ('pre-ipo:OURA', 'pre-ipo', 'OURA', 'Oura Inc. (Pre-IPO)')
)
INSERT INTO identity.asset_version
  (asset_id, category, canonical_underlying, display_name, market_origin,
   identity_status, identity_fingerprint, valid_from)
SELECT asset.asset_id, target.category, target.canonical_underlying,
  target.display_name, 'unknown', 'verified',
  encode(digest(convert_to(concat(
    '[',
    to_json(target.asset_key)::text, ',',
    to_json(target.category)::text, ',',
    to_json(target.canonical_underlying)::text, ',',
    to_json(target.display_name)::text, ',',
    to_json('unknown'::text)::text, ',',
    to_json('verified'::text)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex'),
  COALESCE((
    SELECT min(instrument_version.valid_from)
    FROM identity.instrument_version AS instrument_version
    JOIN identity.asset_version AS old_asset_version
      ON old_asset_version.asset_version_id = instrument_version.asset_version_id
    WHERE old_asset_version.canonical_underlying = target.canonical_underlying
  ), clock_timestamp())
FROM target
JOIN identity.asset AS asset ON asset.asset_key = target.asset_key
WHERE NOT EXISTS (
  SELECT 1
  FROM identity.asset_version AS current
  WHERE current.asset_id = asset.asset_id
    AND current.valid_to IS NULL
);

WITH target(asset_key, category, canonical_underlying, display_name) AS (
  VALUES
    ('commodity:H100', 'commodity', 'H100', 'H100'),
    ('pre-ipo:MOONSHOT', 'pre-ipo', 'MOONSHOT', 'Moonshot AI (Pre-IPO)'),
    ('pre-ipo:OURA', 'pre-ipo', 'OURA', 'Oura Inc. (Pre-IPO)')
)
UPDATE identity.asset_version AS asset_version
SET display_name = target.display_name,
  identity_fingerprint = encode(digest(convert_to(concat(
    '[',
    to_json(target.asset_key)::text, ',',
    to_json(asset_version.category)::text, ',',
    to_json(asset_version.canonical_underlying)::text, ',',
    to_json(target.display_name)::text, ',',
    to_json(asset_version.market_origin)::text, ',',
    to_json(asset_version.identity_status)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex')
FROM identity.asset AS asset, target
WHERE asset.asset_id = asset_version.asset_id
  AND asset.asset_key = target.asset_key
  AND asset_version.valid_to IS NULL
  AND asset_version.category = target.category
  AND asset_version.canonical_underlying = target.canonical_underlying
  AND asset_version.identity_status = 'verified'
  AND asset_version.display_name IS DISTINCT FROM target.display_name;

-- Rebind only the five exact products that were previously persisted under a
-- broad venue category. Historical versions are intentionally included so an
-- already-confirmed event projects the same reviewed identity as current data.
WITH correction(
  source_key, official_product_key, previous_category,
  previous_canonical_underlying, target_asset_key
) AS (
  VALUES
    ('perp:gate', 'H100_USDT', 'index', 'H100', 'commodity:H100'),
    ('perp:bitget', 'MOONSHOTUSDT', 'equity', 'MOONSHOT', 'pre-ipo:MOONSHOT'),
    ('perp:okx', 'MOONSHOT-USDT-SWAP', 'equity', 'MOONSHOT', 'pre-ipo:MOONSHOT'),
    ('perp:bitget', 'OURAUSDT', 'equity', 'OURA', 'pre-ipo:OURA'),
    ('perp:okx', 'OURA-USDT-SWAP', 'equity', 'OURA', 'pre-ipo:OURA')
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
  AND old_asset_version.category = correction.previous_category
  AND old_asset_version.canonical_underlying = correction.previous_canonical_underlying
  AND target_asset.asset_key = correction.target_asset_key
  AND target_asset_version.asset_id = target_asset.asset_id
  AND target_asset_version.valid_to IS NULL
  AND target_asset_version.identity_status = 'verified';

-- A reviewed display-name fingerprint is shared by every venue already bound
-- to the target identity, including sources that were correctly Pre-IPO before
-- this migration.
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
  AND asset.asset_key IN ('commodity:H100', 'pre-ipo:MOONSHOT', 'pre-ipo:OURA')
  AND asset_version.identity_status = 'verified'
  AND source.source_id = instrument_version.source_id
  AND instrument.instrument_id = instrument_version.instrument_id
  AND instrument.source_id = instrument_version.source_id;

-- Retire only unreferenced legacy identities. Unknown or newly discovered
-- bindings keep the old version open and make the assertion below fail closed.
UPDATE identity.asset_version AS old_asset_version
SET valid_to = clock_timestamp()
FROM identity.asset AS old_asset
WHERE old_asset.asset_id = old_asset_version.asset_id
  AND old_asset.asset_key IN ('index:H100', 'equity:MOONSHOT', 'equity:OURA')
  AND old_asset_version.valid_to IS NULL
  AND old_asset_version.valid_from < clock_timestamp()
  AND NOT EXISTS (
    SELECT 1
    FROM identity.instrument_version AS instrument_version
    WHERE instrument_version.asset_version_id = old_asset_version.asset_version_id
  );

DO $reviewed_rwa_identity_corrections$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('commodity:H100', 'commodity', 'H100', 'H100'),
      ('pre-ipo:MOONSHOT', 'pre-ipo', 'MOONSHOT', 'Moonshot AI (Pre-IPO)'),
      ('pre-ipo:OURA', 'pre-ipo', 'OURA', 'Oura Inc. (Pre-IPO)')
    ) AS expected(asset_key, category, canonical_underlying, display_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM identity.asset AS asset
      JOIN identity.asset_version AS current
        ON current.asset_id = asset.asset_id
       AND current.valid_to IS NULL
       AND current.identity_status = 'verified'
      WHERE asset.asset_key = expected.asset_key
        AND current.category = expected.category
        AND current.canonical_underlying = expected.canonical_underlying
        AND current.display_name = expected.display_name
    )
  ) THEN
    RAISE EXCEPTION 'reviewed H100/MOONSHOT/OURA target identities were not established';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('perp:gate', 'H100_USDT', 'commodity:H100'),
      ('perp:bitget', 'MOONSHOTUSDT', 'pre-ipo:MOONSHOT'),
      ('perp:okx', 'MOONSHOT-USDT-SWAP', 'pre-ipo:MOONSHOT'),
      ('perp:bitget', 'OURAUSDT', 'pre-ipo:OURA'),
      ('perp:okx', 'OURA-USDT-SWAP', 'pre-ipo:OURA')
    ) AS expected(source_key, official_product_key, asset_key)
    JOIN identity.source AS source ON source.source_key = expected.source_key
    JOIN identity.instrument AS instrument
      ON instrument.source_id = source.source_id
     AND instrument.official_product_key = expected.official_product_key
    LEFT JOIN identity.instrument_version AS current
      ON current.instrument_id = instrument.instrument_id
     AND current.valid_to IS NULL
     AND current.identity_status = 'verified'
    LEFT JOIN identity.asset_version AS asset_version
      ON asset_version.asset_version_id = current.asset_version_id
    LEFT JOIN identity.asset AS asset ON asset.asset_id = asset_version.asset_id
    WHERE current.instrument_version_id IS NULL
      OR asset.asset_key <> expected.asset_key
      OR asset_version.valid_to IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'an exact reviewed H100/MOONSHOT/OURA product remains on its legacy identity';
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

  IF EXISTS (
    SELECT 1
    FROM identity.asset AS asset
    JOIN identity.asset_version AS current
      ON current.asset_id = asset.asset_id
     AND current.valid_to IS NULL
    WHERE asset.asset_key IN ('index:H100', 'equity:MOONSHOT', 'equity:OURA')
  ) THEN
    RAISE EXCEPTION 'a legacy H100/MOONSHOT/OURA asset identity remains current';
  END IF;
END
$reviewed_rwa_identity_corrections$;
