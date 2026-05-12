DROP TABLE IF EXISTS parcel_cards;
DROP TABLE IF EXISTS parcel_sales;
DROP TABLE IF EXISTS parcel_improvements;
DROP TABLE IF EXISTS parcel_land_segments;

CREATE TABLE parcel_cards (
  parcel_id                 TEXT PRIMARY KEY,
  account_number            TEXT,
  updated_date              TEXT,

  legal_description         TEXT,
  property_type             TEXT,

  situs_street_number       TEXT,
  situs_street_name         TEXT,
  situs_city                TEXT,
  situs_state               TEXT,
  situs_zip                 TEXT,

  owner_name                TEXT,
  owner_city                TEXT,
  owner_state               TEXT,
  owner_zip                 TEXT,
  absentee_owner            INTEGER,

  land_use_code             TEXT,
  land_use_description      TEXT,

  assessed_value            INTEGER,
  taxable_value             INTEGER,
  market_value              INTEGER,
  building_value            INTEGER,
  land_value                INTEGER,
  impr_land_value           INTEGER,
  unimpr_land_value         INTEGER,
  improvement_value         INTEGER,

  acres                     REAL,
  sq_ft                     INTEGER,
  bedrooms                  INTEGER,
  bathrooms                 REAL,
  garage_sq_ft              INTEGER,
  year_built                INTEGER,
  effective_year_built      INTEGER,

  sale_date                 TEXT,
  sale_price                INTEGER,
  sale_type                 TEXT,
  sale_deed_type            TEXT,
  days_since_last_sale      INTEGER,

  last_valid_sale_date      TEXT,
  last_valid_sale_price     INTEGER,
  value_per_acre            REAL,
  improvement_ratio         REAL,
  is_vacant                 INTEGER,
  is_sfr                    INTEGER,
  is_recreational_land      INTEGER,
  distressed_transfer_recent INTEGER,

  latitude                  REAL,
  longitude                 REAL,
  geometry                  TEXT,
  raw_r2_key                TEXT
);

CREATE TABLE parcel_sales (
  id                TEXT PRIMARY KEY,
  parcel_id         TEXT NOT NULL,
  sale_id           TEXT,
  sale_date         TEXT,
  sale_price        INTEGER,
  sale_type         TEXT,
  deed_type         TEXT,
  seller_name       TEXT,
  buyer_name        TEXT,
  recording_number  TEXT,
  excise_number     TEXT
);

CREATE TABLE parcel_improvements (
  id                   TEXT PRIMARY KEY,
  parcel_id            TEXT NOT NULL,
  improvement_id       TEXT,
  segment_id           TEXT,
  improvement_type     TEXT,
  improvement_class    TEXT,
  condition_code       TEXT,
  calc_area            REAL,
  value                INTEGER,
  actual_year_built    INTEGER,
  effective_year_built INTEGER,
  sketch_url           TEXT
);

CREATE TABLE parcel_land_segments (
  id           TEXT PRIMARY KEY,
  parcel_id    TEXT NOT NULL,
  land_type    TEXT,
  acres        REAL,
  square_feet  REAL,
  market_value INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cards_updated        ON parcel_cards(updated_date);
CREATE INDEX IF NOT EXISTS idx_cards_land_use       ON parcel_cards(land_use_code);
CREATE INDEX IF NOT EXISTS idx_cards_value          ON parcel_cards(assessed_value);
CREATE INDEX IF NOT EXISTS idx_cards_yearbuilt      ON parcel_cards(year_built);
CREATE INDEX IF NOT EXISTS idx_cards_absentee       ON parcel_cards(absentee_owner);
CREATE INDEX IF NOT EXISTS idx_cards_days_sale      ON parcel_cards(days_since_last_sale);
CREATE INDEX IF NOT EXISTS idx_cards_city           ON parcel_cards(situs_city);
CREATE INDEX IF NOT EXISTS idx_cards_street         ON parcel_cards(situs_street_name);
CREATE INDEX IF NOT EXISTS idx_cards_owner_state    ON parcel_cards(owner_state);
CREATE INDEX IF NOT EXISTS idx_cards_latlon         ON parcel_cards(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_sales_parcel         ON parcel_sales(parcel_id);
CREATE INDEX IF NOT EXISTS idx_sales_date           ON parcel_sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_improvements_parcel  ON parcel_improvements(parcel_id);
CREATE INDEX IF NOT EXISTS idx_land_segments_parcel ON parcel_land_segments(parcel_id);

CREATE TABLE IF NOT EXISTS parcel_geo_layers (
  parcel_id     TEXT PRIMARY KEY,
  enriched_date TEXT,
  layers        TEXT
);

CREATE INDEX IF NOT EXISTS idx_geo_enriched ON parcel_geo_layers(enriched_date);

CREATE TABLE IF NOT EXISTS ingest_manifests (
  name          TEXT PRIMARY KEY,
  updated_date  TEXT,
  manifest_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  run_date     TEXT PRIMARY KEY,
  summary_json TEXT NOT NULL
);
