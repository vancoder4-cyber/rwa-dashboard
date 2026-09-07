-- Forward correction for migration 0013 on databases where PostgreSQL's
-- data-modifying CTE snapshot caused the outer current-row guard to suppress
-- the replacement insert. Restore only exact instruments whose last verified
-- online version has trusted present membership and no confirmed delisting.

WITH latest_closed AS (
  SELECT DISTINCT ON (instrument_version.instrument_id)
    instrument_version.instrument_id,
    instrument_version.source_id,
    instrument_version.instrument_version_id,
    instrument_version.official_venue_symbol,
    instrument_version.normalized_venue_symbol,
    instrument_version.instrument_type,
    instrument_version.quote_currency,
    instrument_version.contract_multiplier,
    instrument_version.official_status,
    instrument_version.identity_status,
    bound_asset_version.asset_id,
    source.source_key,
    instrument.official_product_key
  FROM identity.instrument_version AS instrument_version
  JOIN identity.instrument AS instrument
    ON instrument.instrument_id = instrument_version.instrument_id
   AND instrument.source_id = instrument_version.source_id
  JOIN identity.source AS source ON source.source_id = instrument_version.source_id
  JOIN identity.asset_version AS bound_asset_version
    ON bound_asset_version.asset_version_id = instrument_version.asset_version_id
  WHERE instrument_version.valid_to IS NOT NULL
    AND instrument_version.identity_status = 'verified'
    AND instrument_version.official_status = 'online'
    AND NOT EXISTS (
      SELECT 1
      FROM identity.instrument_version AS current_instrument
      WHERE current_instrument.instrument_id = instrument_version.instrument_id
        AND current_instrument.valid_to IS NULL
    )
  ORDER BY instrument_version.instrument_id,
    instrument_version.valid_from DESC,
    instrument_version.instrument_version_id DESC
), repairable AS (
  SELECT latest_closed.*, current_asset_version.asset_version_id,
    current_asset_version.identity_fingerprint AS asset_fingerprint,
    clock_timestamp() AS observed_at
  FROM latest_closed
  JOIN identity.asset_version AS current_asset_version
    ON current_asset_version.asset_id = latest_closed.asset_id
   AND current_asset_version.valid_to IS NULL
   AND current_asset_version.identity_status = 'verified'
  WHERE EXISTS (
    SELECT 1
    FROM ingest.catalog_membership AS membership
    WHERE membership.instrument_version_id = latest_closed.instrument_version_id
      AND membership.source_id = latest_closed.source_id
      AND membership.presence_status = 'present'
      AND NOT EXISTS (
        SELECT 1
        FROM analytics.catalog_change_event AS delisting
        WHERE delisting.instrument_version_id = latest_closed.instrument_version_id
          AND delisting.source_id = latest_closed.source_id
          AND delisting.event_type = 'delisted'
          AND delisting.status = 'confirmed'
          AND delisting.observed_at >= membership.observed_at
      )
  )
)
INSERT INTO identity.instrument_version
  (instrument_id, source_id, asset_version_id, official_venue_symbol,
   normalized_venue_symbol, instrument_type, quote_currency,
   contract_multiplier, official_status, identity_status,
   identity_fingerprint, valid_from)
SELECT repairable.instrument_id, repairable.source_id,
  repairable.asset_version_id, repairable.official_venue_symbol,
  repairable.normalized_venue_symbol, repairable.instrument_type,
  repairable.quote_currency, repairable.contract_multiplier,
  repairable.official_status, repairable.identity_status,
  encode(digest(convert_to(concat(
    '[',
    to_json(repairable.source_key)::text, ',',
    to_json(repairable.official_product_key)::text, ',',
    to_json(repairable.official_venue_symbol)::text, ',',
    to_json(repairable.instrument_type)::text, ',',
    to_json(btrim(repairable.asset_fingerprint::text))::text, ',',
    to_json(repairable.official_status)::text, ',',
    to_json(repairable.identity_status)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex'),
  repairable.observed_at
FROM repairable;

DO $live_instrument_binding_repair$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM identity.instrument AS instrument
    JOIN LATERAL (
      SELECT instrument_version.*
      FROM identity.instrument_version AS instrument_version
      WHERE instrument_version.instrument_id = instrument.instrument_id
      ORDER BY instrument_version.valid_from DESC,
        instrument_version.instrument_version_id DESC
      LIMIT 1
    ) AS latest ON true
    JOIN identity.asset_version AS bound_asset_version
      ON bound_asset_version.asset_version_id = latest.asset_version_id
    WHERE latest.valid_to IS NOT NULL
      AND latest.identity_status = 'verified'
      AND latest.official_status = 'online'
      AND NOT EXISTS (
        SELECT 1 FROM identity.instrument_version AS current_instrument
        WHERE current_instrument.instrument_id = instrument.instrument_id
          AND current_instrument.valid_to IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM identity.asset_version AS current_asset_version
        WHERE current_asset_version.asset_id = bound_asset_version.asset_id
          AND current_asset_version.valid_to IS NULL
          AND current_asset_version.identity_status = 'verified'
      )
      AND EXISTS (
        SELECT 1 FROM ingest.catalog_membership AS membership
        WHERE membership.instrument_version_id = latest.instrument_version_id
          AND membership.source_id = latest.source_id
          AND membership.presence_status = 'present'
          AND NOT EXISTS (
            SELECT 1 FROM analytics.catalog_change_event AS delisting
            WHERE delisting.instrument_version_id = latest.instrument_version_id
              AND delisting.source_id = latest.source_id
              AND delisting.event_type = 'delisted'
              AND delisting.status = 'confirmed'
              AND delisting.observed_at >= membership.observed_at
          )
      )
  ) THEN
    RAISE EXCEPTION 'trusted present instrument identity is missing its current asset binding';
  END IF;
END
$live_instrument_binding_repair$;

COMMENT ON COLUMN identity.instrument_version.asset_version_id IS
  'Current verified instruments with trusted present membership must reference the current verified asset version for the same stable asset identity.';
