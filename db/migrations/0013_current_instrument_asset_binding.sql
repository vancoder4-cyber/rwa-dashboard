-- Forward repair for current instrument versions left on an expired asset
-- version when another venue advances the shared reviewed asset identity while
-- this instrument's source is preserving its last-good catalog. Exact venue
-- identity and status are copied; no catalog membership or lifecycle event is
-- inferred by this repair.

WITH repair_time AS (
  SELECT clock_timestamp() AS observed_at
), carried_instrument_versions AS (
  UPDATE identity.instrument_version AS current
  SET valid_to = repair_time.observed_at
  FROM identity.asset_version AS prior_asset_version,
    identity.asset_version AS current_asset_version,
    identity.instrument AS instrument,
    identity.source AS source,
    repair_time
  WHERE prior_asset_version.asset_version_id = current.asset_version_id
    AND prior_asset_version.valid_to IS NOT NULL
    AND current_asset_version.asset_id = prior_asset_version.asset_id
    AND current_asset_version.valid_to IS NULL
    AND current_asset_version.identity_status = 'verified'
    AND instrument.instrument_id = current.instrument_id
    AND instrument.source_id = current.source_id
    AND source.source_id = current.source_id
    AND current.valid_to IS NULL
    AND current.identity_status = 'verified'
    AND current.valid_from < repair_time.observed_at
  RETURNING current.instrument_id, current.source_id,
    current.official_venue_symbol, current.normalized_venue_symbol,
    current.instrument_type, current.quote_currency,
    current.contract_multiplier, current.official_status,
    current.identity_status, current_asset_version.asset_version_id,
    current_asset_version.identity_fingerprint AS asset_fingerprint,
    source.source_key, instrument.official_product_key,
    repair_time.observed_at
)
INSERT INTO identity.instrument_version
  (instrument_id, source_id, asset_version_id, official_venue_symbol,
   normalized_venue_symbol, instrument_type, quote_currency,
   contract_multiplier, official_status, identity_status,
   identity_fingerprint, valid_from)
SELECT current.instrument_id, current.source_id,
  current.asset_version_id, current.official_venue_symbol,
  current.normalized_venue_symbol, current.instrument_type,
  current.quote_currency, current.contract_multiplier,
  current.official_status, current.identity_status,
  encode(digest(convert_to(concat(
    '[',
    to_json(current.source_key)::text, ',',
    to_json(current.official_product_key)::text, ',',
    to_json(current.official_venue_symbol)::text, ',',
    to_json(current.instrument_type)::text, ',',
    to_json(btrim(current.asset_fingerprint::text))::text, ',',
    to_json(current.official_status)::text, ',',
    to_json(current.identity_status)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex'),
  current.observed_at
FROM carried_instrument_versions AS current
WHERE NOT EXISTS (
  SELECT 1
  FROM identity.instrument_version AS existing
  WHERE existing.instrument_id = current.instrument_id
    AND existing.valid_to IS NULL
);

DO $current_instrument_asset_binding$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM identity.instrument_version AS instrument_version
    JOIN identity.asset_version AS bound_asset_version
      ON bound_asset_version.asset_version_id = instrument_version.asset_version_id
    WHERE instrument_version.valid_to IS NULL
      AND instrument_version.identity_status = 'verified'
      AND NOT EXISTS (
        SELECT 1
        FROM identity.asset_version AS current_asset_version
        WHERE current_asset_version.asset_id = bound_asset_version.asset_id
          AND current_asset_version.asset_version_id = instrument_version.asset_version_id
          AND current_asset_version.valid_to IS NULL
          AND current_asset_version.identity_status = 'verified'
      )
  ) THEN
    RAISE EXCEPTION 'current verified instrument versions are not bound to current verified asset versions';
  END IF;
END
$current_instrument_asset_binding$;

COMMENT ON COLUMN identity.instrument_version.asset_version_id IS
  'Current verified instrument versions must reference the current verified asset version for the same stable asset identity.';
