-- Reviewed factual identity correction for the two Nasdaq-listed GraniteShares
-- daily leveraged ETFs. OKX exposes them inside its broad Stocks catalog, but
-- SKDD/SKUU are ETF securities referencing SK Hynix ADR (SKHY); neither ticker
-- is an alias for SK Hynix common equity. This migration changes identity only
-- and deliberately does not create or modify any catalog lifecycle event.

INSERT INTO identity.asset (asset_key)
VALUES ('etf:SKDD'), ('etf:SKUU')
ON CONFLICT (asset_key) DO NOTHING;

INSERT INTO identity.asset_version
  (asset_id, category, canonical_underlying, display_name, market_origin,
   identity_status, identity_fingerprint, valid_from)
SELECT asset.asset_id, 'etf', correction.canonical_underlying,
  correction.canonical_underlying, 'unknown', 'verified',
  correction.identity_fingerprint,
  COALESCE((
    SELECT min(instrument_version.valid_from)
    FROM identity.instrument_version AS instrument_version
    JOIN identity.asset_version AS old_asset_version
      ON old_asset_version.asset_version_id = instrument_version.asset_version_id
    WHERE old_asset_version.category = 'equity'
      AND old_asset_version.canonical_underlying = correction.canonical_underlying
  ), clock_timestamp())
FROM (VALUES
  ('SKDD', 'c64570a9c8dbe060eef8289ba280db7e6b6a9cf572685f10207c597dbf25c2aa'),
  ('SKUU', '86f54c6ebde54756c2a7e1fd296c1ffb63210f6d59b5cc76599d23793f013459')
) AS correction(canonical_underlying, identity_fingerprint)
JOIN identity.asset AS asset
  ON asset.asset_key = 'etf:' || correction.canonical_underlying
WHERE NOT EXISTS (
  SELECT 1
  FROM identity.asset_version AS current
  WHERE current.asset_id = asset.asset_id
    AND current.valid_to IS NULL
);

DO $reviewed_etf_identity$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES ('SKDD'), ('SKUU')) AS expected(canonical_underlying)
    WHERE NOT EXISTS (
      SELECT 1
      FROM identity.asset AS asset
      JOIN identity.asset_version AS current
        ON current.asset_id = asset.asset_id
       AND current.valid_to IS NULL
       AND current.identity_status = 'verified'
      WHERE asset.asset_key = 'etf:' || expected.canonical_underlying
        AND current.category = 'etf'
        AND current.canonical_underlying = expected.canonical_underlying
    )
  ) THEN
    RAISE EXCEPTION 'reviewed SKDD/SKUU ETF identity correction could not establish both verified assets';
  END IF;
END
$reviewed_etf_identity$;

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
FROM identity.asset_version AS old_asset_version,
  identity.asset AS corrected_asset,
  identity.asset_version AS corrected_asset_version,
  identity.source AS source,
  identity.instrument AS instrument
WHERE old_asset_version.asset_version_id = instrument_version.asset_version_id
  AND old_asset_version.category = 'equity'
  AND old_asset_version.canonical_underlying IN ('SKDD', 'SKUU')
  AND corrected_asset.asset_key = 'etf:' || old_asset_version.canonical_underlying
  AND corrected_asset_version.asset_id = corrected_asset.asset_id
  AND corrected_asset_version.valid_to IS NULL
  AND corrected_asset_version.identity_status = 'verified'
  AND source.source_id = instrument_version.source_id
  AND instrument.instrument_id = instrument_version.instrument_id
  AND instrument.source_id = instrument_version.source_id;

UPDATE identity.asset_version AS old_asset_version
SET valid_to = clock_timestamp()
WHERE old_asset_version.category = 'equity'
  AND old_asset_version.canonical_underlying IN ('SKDD', 'SKUU')
  AND old_asset_version.valid_to IS NULL
  AND old_asset_version.valid_from < clock_timestamp()
  AND NOT EXISTS (
    SELECT 1
    FROM identity.instrument_version AS instrument_version
    WHERE instrument_version.asset_version_id = old_asset_version.asset_version_id
  );
