-- Forward identity-name repair for Bitget's exact SOFTBANKUSDT RWA perpetual.
--
-- Bitget's 2026-09-07 live USDT-FUTURES catalog identifies the exact product
-- as baseCoin=SOFTBANK, isRwa=YES, symbolType=stock and status=online.
-- SoftBank Group and JPX records identify Tokyo code 9984 as SoftBank Group
-- Corp. This migration only corrects an identity already admitted by the
-- authenticated Listing Audit. It does not create an asset, instrument,
-- membership or catalog lifecycle event; a not-yet-observed product remains
-- the Listing Audit writer's responsibility.

UPDATE identity.asset_version AS asset_version
SET display_name = 'SoftBank Group Corp.',
  identity_fingerprint = encode(digest(convert_to(concat(
    '[',
    to_json(asset.asset_key)::text, ',',
    to_json(asset_version.category)::text, ',',
    to_json(asset_version.canonical_underlying)::text, ',',
    to_json('SoftBank Group Corp.'::text)::text, ',',
    to_json(asset_version.market_origin)::text, ',',
    to_json(asset_version.identity_status)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex')
FROM identity.asset AS asset
WHERE asset.asset_id = asset_version.asset_id
  AND asset.asset_key = 'equity:SOFTBANK'
  AND asset_version.valid_to IS NULL
  AND asset_version.category = 'equity'
  AND asset_version.canonical_underlying = 'SOFTBANK'
  AND asset_version.identity_status = 'verified'
  AND asset_version.display_name IS DISTINCT FROM 'SoftBank Group Corp.';

-- Keep every already-bound exact instrument fingerprint aligned with the
-- corrected current asset version. This does not imply a fresh catalog run.
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
  AND asset.asset_key = 'equity:SOFTBANK'
  AND asset_version.valid_to IS NULL
  AND asset_version.category = 'equity'
  AND asset_version.canonical_underlying = 'SOFTBANK'
  AND asset_version.display_name = 'SoftBank Group Corp.'
  AND asset_version.identity_status = 'verified'
  AND source.source_id = instrument_version.source_id
  AND instrument.instrument_id = instrument_version.instrument_id
  AND instrument.source_id = instrument_version.source_id;

DO $reviewed_bitget_softbank_identity$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM identity.asset AS asset
    JOIN identity.asset_version AS current
      ON current.asset_id = asset.asset_id
     AND current.valid_to IS NULL
    WHERE asset.asset_key = 'equity:SOFTBANK'
      AND (
        current.category <> 'equity'
        OR current.canonical_underlying <> 'SOFTBANK'
        OR current.display_name <> 'SoftBank Group Corp.'
        OR current.identity_status <> 'verified'
      )
  ) THEN
    RAISE EXCEPTION 'reviewed SoftBank Group identity remains inconsistent';
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
    JOIN identity.asset AS asset ON asset.asset_id = asset_version.asset_id
    WHERE source.source_key = 'perp:bitget'
      AND instrument.official_product_key = 'SOFTBANKUSDT'
      AND (
        current.official_venue_symbol <> 'SOFTBANKUSDT'
        OR current.normalized_venue_symbol <> 'SOFTBANKUSDT'
        OR current.instrument_type <> 'perpetual'
        OR current.official_status <> 'online'
        OR current.identity_status <> 'verified'
        OR asset.asset_key <> 'equity:SOFTBANK'
        OR asset_version.valid_to IS NOT NULL
        OR asset_version.category <> 'equity'
        OR asset_version.canonical_underlying <> 'SOFTBANK'
        OR asset_version.display_name <> 'SoftBank Group Corp.'
        OR asset_version.identity_status <> 'verified'
      )
  ) THEN
    RAISE EXCEPTION 'Bitget SOFTBANKUSDT is not bound to the reviewed SoftBank Group identity';
  END IF;
END
$reviewed_bitget_softbank_identity$;
