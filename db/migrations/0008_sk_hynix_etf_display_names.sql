-- Forward repair for the display-name rows introduced by migration 0007.
-- The canonical ETF identities and exact venue instruments stay unchanged;
-- this migration only aligns the durable identity names/fingerprints with the
-- reviewed GraniteShares registry. It deliberately does not create or modify
-- any catalog lifecycle event.

WITH correction(canonical_underlying, display_name) AS (
  VALUES
    ('SKDD', 'GraniteShares 2x Short SK Hynix Daily ETF'),
    ('SKUU', 'GraniteShares 2x Long SK Hynix Daily ETF')
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
  AND asset.asset_key = 'etf:' || correction.canonical_underlying
  AND asset_version.category = 'etf'
  AND asset_version.canonical_underlying = correction.canonical_underlying
  AND asset_version.identity_status = 'verified'
  AND (
    asset_version.display_name IS DISTINCT FROM correction.display_name
    OR btrim(asset_version.identity_fingerprint::text) IS DISTINCT FROM encode(digest(convert_to(concat(
      '[',
      to_json(asset.asset_key)::text, ',',
      to_json(asset_version.category)::text, ',',
      to_json(asset_version.canonical_underlying)::text, ',',
      to_json(correction.display_name)::text, ',',
      to_json(asset_version.market_origin)::text, ',',
      to_json(asset_version.identity_status)::text,
      ']'
    ), 'UTF8'), 'sha256'), 'hex')
  );

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
  AND asset.asset_key IN ('etf:SKDD', 'etf:SKUU')
  AND source.source_id = instrument_version.source_id
  AND instrument.instrument_id = instrument_version.instrument_id
  AND instrument.source_id = instrument_version.source_id;

DO $reviewed_etf_display_names$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('SKDD', 'GraniteShares 2x Short SK Hynix Daily ETF'),
      ('SKUU', 'GraniteShares 2x Long SK Hynix Daily ETF')
    ) AS expected(canonical_underlying, display_name)
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
        AND current.display_name = expected.display_name
    )
  ) THEN
    RAISE EXCEPTION 'reviewed SKDD/SKUU ETF display-name repair did not establish both exact names';
  END IF;
END
$reviewed_etf_display_names$;
