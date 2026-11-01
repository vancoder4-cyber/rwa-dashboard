-- Forward-only durable identity repair for nine issuer- and exchange-reviewed
-- US ETFs that were previously persisted under a venue's broad Equity class.
-- The canonical underlying never changes. Existing instrument versions are
-- rebound to the reviewed ETF identity so their immutable lifecycle event IDs,
-- types, timestamps and evidence remain untouched. The event table is locked
-- and counted only to prove this migration is lifecycle-event neutral.

CREATE TEMP TABLE reviewed_us_etf_identity_correction (
  canonical_underlying text COLLATE "C" PRIMARY KEY,
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0)
) ON COMMIT DROP;

INSERT INTO reviewed_us_etf_identity_correction
  (canonical_underlying, display_name)
VALUES
  ('BITX', '2x Bitcoin ETF'),
  ('IJR', 'iShares Core S&P Small-Cap ETF'),
  ('JPST', 'JPMorgan Ultra-Short Income ETF'),
  ('NLR', 'VanEck Uranium and Nuclear ETF'),
  ('SCHF', 'Schwab International Equity ETF'),
  ('VGK', 'Vanguard FTSE Europe ETF'),
  ('VT', 'Vanguard Total World Stock ETF'),
  ('VUG', 'Vanguard Morningstar Growth ETF'),
  ('XOP', 'State Street SPDR S&P Oil & Gas Exploration & Production ETF');

-- Prevent a concurrent lifecycle writer from making the before/after count
-- ambiguous while this serializable migration transaction is in progress.
LOCK TABLE analytics.catalog_change_event IN SHARE MODE;

CREATE TEMP TABLE reviewed_us_etf_event_guard ON COMMIT DROP AS
SELECT count(*)::bigint AS event_count
FROM analytics.catalog_change_event;

INSERT INTO identity.asset (asset_key)
SELECT 'etf:' || correction.canonical_underlying
FROM reviewed_us_etf_identity_correction AS correction
ON CONFLICT (asset_key) DO NOTHING;

-- Create a current target only when one does not already exist. The initial
-- validity boundary preserves the earliest already-admitted legacy binding.
INSERT INTO identity.asset_version
  (asset_id, category, canonical_underlying, display_name, market_origin,
   identity_status, identity_fingerprint, valid_from)
SELECT target_asset.asset_id, 'etf', correction.canonical_underlying,
  correction.display_name, 'unknown', 'verified',
  encode(digest(convert_to(concat(
    '[',
    to_json(target_asset.asset_key)::text, ',',
    to_json('etf'::text)::text, ',',
    to_json(correction.canonical_underlying)::text, ',',
    to_json(correction.display_name)::text, ',',
    to_json('unknown'::text)::text, ',',
    to_json('verified'::text)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex'),
  COALESCE((
    SELECT min(instrument_version.valid_from)
    FROM identity.instrument_version AS instrument_version
    JOIN identity.asset_version AS old_asset_version
      ON old_asset_version.asset_version_id = instrument_version.asset_version_id
    JOIN identity.asset AS old_asset
      ON old_asset.asset_id = old_asset_version.asset_id
    WHERE old_asset.asset_key = 'equity:' || correction.canonical_underlying
      AND old_asset_version.category = 'equity'
      AND old_asset_version.canonical_underlying = correction.canonical_underlying
  ), clock_timestamp())
FROM reviewed_us_etf_identity_correction AS correction
JOIN identity.asset AS target_asset
  ON target_asset.asset_key = 'etf:' || correction.canonical_underlying
WHERE NOT EXISTS (
  SELECT 1
  FROM identity.asset_version AS current
  WHERE current.asset_id = target_asset.asset_id
    AND current.valid_to IS NULL
);

-- Existing target versions keep their established market metadata and validity
-- range; only the reviewed official display name and its derived fingerprint
-- are repaired. The fingerprint comparison makes a second run a no-op.
UPDATE identity.asset_version AS target_asset_version
SET display_name = correction.display_name,
  identity_fingerprint = encode(digest(convert_to(concat(
    '[',
    to_json(target_asset.asset_key)::text, ',',
    to_json(target_asset_version.category)::text, ',',
    to_json(target_asset_version.canonical_underlying)::text, ',',
    to_json(correction.display_name)::text, ',',
    to_json(target_asset_version.market_origin)::text, ',',
    to_json(target_asset_version.identity_status)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex')
FROM reviewed_us_etf_identity_correction AS correction,
  identity.asset AS target_asset
WHERE target_asset.asset_id = target_asset_version.asset_id
  AND target_asset.asset_key = 'etf:' || correction.canonical_underlying
  AND target_asset_version.valid_to IS NULL
  AND target_asset_version.category = 'etf'
  AND target_asset_version.canonical_underlying = correction.canonical_underlying
  AND target_asset_version.identity_status = 'verified'
  AND (
    target_asset_version.display_name IS DISTINCT FROM correction.display_name
    OR btrim(target_asset_version.identity_fingerprint::text) IS DISTINCT FROM encode(digest(convert_to(concat(
      '[',
      to_json(target_asset.asset_key)::text, ',',
      to_json(target_asset_version.category)::text, ',',
      to_json(target_asset_version.canonical_underlying)::text, ',',
      to_json(correction.display_name)::text, ',',
      to_json(target_asset_version.market_origin)::text, ',',
      to_json(target_asset_version.identity_status)::text,
      ']'
    ), 'UTF8'), 'sha256'), 'hex')
  );

-- Rebind every historical and current instrument version that is attached to
-- the exact legacy equity asset. The instrument_version_id is preserved, so
-- existing lifecycle-event foreign keys continue to identify the same fact.
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
FROM reviewed_us_etf_identity_correction AS correction,
  identity.asset_version AS old_asset_version,
  identity.asset AS old_asset,
  identity.asset AS target_asset,
  identity.asset_version AS target_asset_version,
  identity.source AS source,
  identity.instrument AS instrument
WHERE old_asset_version.asset_version_id = instrument_version.asset_version_id
  AND old_asset.asset_id = old_asset_version.asset_id
  AND old_asset.asset_key = 'equity:' || correction.canonical_underlying
  AND old_asset_version.category = 'equity'
  AND old_asset_version.canonical_underlying = correction.canonical_underlying
  AND target_asset.asset_key = 'etf:' || correction.canonical_underlying
  AND target_asset_version.asset_id = target_asset.asset_id
  AND target_asset_version.valid_to IS NULL
  AND target_asset_version.category = 'etf'
  AND target_asset_version.canonical_underlying = correction.canonical_underlying
  AND target_asset_version.identity_status = 'verified'
  AND source.source_id = instrument_version.source_id
  AND instrument.instrument_id = instrument_version.instrument_id
  AND instrument.source_id = instrument_version.source_id;

-- A target display-name repair changes the asset fingerprint. Recompute every
-- instrument version already bound to that target, including versions that did
-- not need the equity-to-ETF rebind above.
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
FROM reviewed_us_etf_identity_correction AS correction,
  identity.asset AS target_asset,
  identity.asset_version AS target_asset_version,
  identity.source AS source,
  identity.instrument AS instrument
WHERE target_asset.asset_key = 'etf:' || correction.canonical_underlying
  AND target_asset_version.asset_id = target_asset.asset_id
  AND target_asset_version.valid_to IS NULL
  AND target_asset_version.category = 'etf'
  AND target_asset_version.canonical_underlying = correction.canonical_underlying
  AND target_asset_version.identity_status = 'verified'
  AND instrument_version.asset_version_id = target_asset_version.asset_version_id
  AND source.source_id = instrument_version.source_id
  AND instrument.instrument_id = instrument_version.instrument_id
  AND instrument.source_id = instrument_version.source_id
  AND btrim(instrument_version.identity_fingerprint::text) IS DISTINCT FROM encode(digest(convert_to(concat(
    '[',
    to_json(source.source_key)::text, ',',
    to_json(instrument.official_product_key)::text, ',',
    to_json(instrument_version.official_venue_symbol)::text, ',',
    to_json(instrument_version.instrument_type)::text, ',',
    to_json(btrim(target_asset_version.identity_fingerprint::text))::text, ',',
    to_json(instrument_version.official_status)::text, ',',
    to_json(instrument_version.identity_status)::text,
    ']'
  ), 'UTF8'), 'sha256'), 'hex');

-- Retire a legacy current version only after all of its instrument bindings
-- have moved. Nothing is deleted, preserving the forward-only audit trail.
UPDATE identity.asset_version AS old_asset_version
SET valid_to = clock_timestamp()
FROM reviewed_us_etf_identity_correction AS correction,
  identity.asset AS old_asset
WHERE old_asset.asset_id = old_asset_version.asset_id
  AND old_asset.asset_key = 'equity:' || correction.canonical_underlying
  AND old_asset_version.category = 'equity'
  AND old_asset_version.canonical_underlying = correction.canonical_underlying
  AND old_asset_version.valid_to IS NULL
  AND old_asset_version.valid_from < clock_timestamp()
  AND NOT EXISTS (
    SELECT 1
    FROM identity.instrument_version AS instrument_version
    WHERE instrument_version.asset_version_id = old_asset_version.asset_version_id
  );

DO $reviewed_us_etf_identity_corrections$
BEGIN
  IF (SELECT count(*) FROM reviewed_us_etf_identity_correction) <> 9 THEN
    RAISE EXCEPTION 'reviewed US ETF correction set is not exactly nine identities';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM reviewed_us_etf_identity_correction AS expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM identity.asset AS target_asset
      JOIN identity.asset_version AS current
        ON current.asset_id = target_asset.asset_id
       AND current.valid_to IS NULL
      WHERE target_asset.asset_key = 'etf:' || expected.canonical_underlying
        AND current.category = 'etf'
        AND current.canonical_underlying = expected.canonical_underlying
        AND current.display_name = expected.display_name
        AND current.identity_status = 'verified'
        AND btrim(current.identity_fingerprint::text) = encode(digest(convert_to(concat(
          '[',
          to_json(target_asset.asset_key)::text, ',',
          to_json(current.category)::text, ',',
          to_json(current.canonical_underlying)::text, ',',
          to_json(current.display_name)::text, ',',
          to_json(current.market_origin)::text, ',',
          to_json(current.identity_status)::text,
          ']'
        ), 'UTF8'), 'sha256'), 'hex')
    )
  ) THEN
    RAISE EXCEPTION 'reviewed US ETF target identity or asset fingerprint is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM identity.instrument_version AS instrument_version
    JOIN identity.asset_version AS legacy_asset_version
      ON legacy_asset_version.asset_version_id = instrument_version.asset_version_id
    JOIN reviewed_us_etf_identity_correction AS expected
      ON expected.canonical_underlying = legacy_asset_version.canonical_underlying
    WHERE legacy_asset_version.category = 'equity'
  ) THEN
    RAISE EXCEPTION 'an instrument version remains bound to a reviewed legacy Equity identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM reviewed_us_etf_identity_correction AS expected
    JOIN identity.asset AS target_asset
      ON target_asset.asset_key = 'etf:' || expected.canonical_underlying
    JOIN identity.asset_version AS target_asset_version
      ON target_asset_version.asset_id = target_asset.asset_id
     AND target_asset_version.valid_to IS NULL
     AND target_asset_version.category = 'etf'
     AND target_asset_version.canonical_underlying = expected.canonical_underlying
     AND target_asset_version.identity_status = 'verified'
    JOIN identity.instrument_version AS instrument_version
      ON instrument_version.asset_version_id = target_asset_version.asset_version_id
    JOIN identity.source AS source
      ON source.source_id = instrument_version.source_id
    JOIN identity.instrument AS instrument
      ON instrument.instrument_id = instrument_version.instrument_id
     AND instrument.source_id = instrument_version.source_id
    WHERE btrim(instrument_version.identity_fingerprint::text) IS DISTINCT FROM encode(digest(convert_to(concat(
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
  ) THEN
    RAISE EXCEPTION 'a reviewed US ETF instrument fingerprint is stale';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM reviewed_us_etf_identity_correction AS expected
    JOIN identity.asset AS target_asset
      ON target_asset.asset_key = 'etf:' || expected.canonical_underlying
    JOIN identity.asset_version AS target_asset_version
      ON target_asset_version.asset_id = target_asset.asset_id
     AND target_asset_version.valid_to IS NULL
     AND target_asset_version.category = 'etf'
     AND target_asset_version.canonical_underlying = expected.canonical_underlying
     AND target_asset_version.identity_status = 'verified'
    JOIN identity.instrument_version AS instrument_version
      ON instrument_version.asset_version_id = target_asset_version.asset_version_id
    WHERE instrument_version.valid_from < target_asset_version.valid_from
  ) THEN
    RAISE EXCEPTION 'a reviewed US ETF instrument predates its target asset version';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM identity.asset_version AS legacy_current
    JOIN reviewed_us_etf_identity_correction AS expected
      ON expected.canonical_underlying = legacy_current.canonical_underlying
    WHERE legacy_current.category = 'equity'
      AND legacy_current.valid_to IS NULL
  ) THEN
    RAISE EXCEPTION 'a reviewed legacy Equity asset version remains current';
  END IF;

  IF (SELECT count(*)::bigint FROM analytics.catalog_change_event)
      IS DISTINCT FROM
     (SELECT event_count FROM reviewed_us_etf_event_guard) THEN
    RAISE EXCEPTION 'reviewed US ETF migration changed catalog lifecycle event count';
  END IF;
END
$reviewed_us_etf_identity_corrections$;
