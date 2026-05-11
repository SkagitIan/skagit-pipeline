CREATE TABLE IF NOT EXISTS parcel_cards (
  parcel_id             TEXT PRIMARY KEY,
  updated_date          TEXT,

  -- Assessor
  assessed_value        INTEGER,
  land_value            INTEGER,
  improvement_value     INTEGER,
  year_built            INTEGER,
  sq_ft                 INTEGER,
  bedrooms              INTEGER,
  bathrooms             REAL,

  -- Land
  land_use_code         TEXT,
  zoning                TEXT,
  acres                 REAL,

  -- 1:many as JSON arrays
  improvements          TEXT,
  sales_history         TEXT,

  -- Geo
  latitude              REAL,
  longitude             REAL,
  geometry              TEXT,

  -- Derived (investor signals)
  absentee_owner        INTEGER,   -- 1 if mailing address is out of state
  days_since_last_sale  INTEGER,   -- null if no sales history

  -- Full raw snapshot
  raw_json              TEXT
);

CREATE INDEX IF NOT EXISTS idx_updated        ON parcel_cards(updated_date);
CREATE INDEX IF NOT EXISTS idx_zoning         ON parcel_cards(zoning);
CREATE INDEX IF NOT EXISTS idx_land_use       ON parcel_cards(land_use_code);
CREATE INDEX IF NOT EXISTS idx_value          ON parcel_cards(assessed_value);
CREATE INDEX IF NOT EXISTS idx_yearbuilt      ON parcel_cards(year_built);
CREATE INDEX IF NOT EXISTS idx_absentee       ON parcel_cards(absentee_owner);
CREATE INDEX IF NOT EXISTS idx_days_since_sale ON parcel_cards(days_since_last_sale);
CREATE INDEX IF NOT EXISTS idx_latlon         ON parcel_cards(latitude, longitude);
