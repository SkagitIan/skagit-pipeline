// buildCard merges all four files into one denormalized record.
// Add cleaning/derivation logic here in the future.

export function buildCard(id, assessor, land, improvements, sales, date) {
  const a = assessor ?? {};
  const l = land ?? {};
  return {
    parcel_id:         id,
    updated_date:      date,
    assessed_value:    num(a['Total Value'] ?? a['TotalValue']),
    land_value:        num(a['Land Value']  ?? a['LandValue']),
    improvement_value: num(a['Impr Value']  ?? a['ImprValue']),
    year_built:        num(a['Year Built']  ?? a['YearBuilt']),
    sq_ft:             num(a['Sq Ft Lot']   ?? a['SqFtLot'] ?? a['SquareFeet']),
    bedrooms:          num(a['Bedrooms']),
    bathrooms:         num(a['Bathrooms']),
    land_use_code:     l['Land Use Code']   ?? l['LandUseCode']   ?? null,
    zoning:            l['Zoning']          ?? null,
    acres:             num(l['Acres']),
    improvements:      JSON.stringify(improvements),
    sales_history:     JSON.stringify(sales),
    latitude:          null,   // filled by geo worker
    longitude:         null,
    geometry:          null,
    raw_json:          JSON.stringify({ assessor: a, land: l, improvements, sales }),
  };
}

// Returns values in exact column order matching schema.sql INSERT
export function cardToRow(c) {
  return [
    c.parcel_id, c.updated_date,
    c.assessed_value, c.land_value, c.improvement_value,
    c.year_built, c.sq_ft, c.bedrooms, c.bathrooms,
    c.land_use_code, c.zoning, c.acres,
    c.improvements, c.sales_history,
    c.latitude, c.longitude, c.geometry,
    c.raw_json,
  ];
}

const num = v => v != null && v !== '' ? +v || null : null;
