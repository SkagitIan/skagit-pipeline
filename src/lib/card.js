// buildCard merges all four files into one denormalized record.
// Field names are the raw PSV column headers from AssessorData.txt / Land.txt.

export function buildCard(id, assessor, land, improvements, sales, date) {
  const a = assessor ?? {};
  const l = land ?? {};

  // absentee_owner: out-of-state mailing address is a motivated-seller signal
  const ownerState = (a['Owner State'] ?? '').trim();
  const absentee_owner = ownerState && ownerState !== 'WA' ? 1 : 0;

  // days_since_last_sale: use assessor Sale Date (most recent transaction on record)
  let days_since_last_sale = null;
  const saleDateStr = (a['Sale Date'] ?? '').trim();
  if (saleDateStr) {
    const saleDate = new Date(saleDateStr);
    if (!isNaN(saleDate.getTime())) {
      days_since_last_sale = Math.floor((Date.now() - saleDate.getTime()) / 86_400_000);
    }
  }

  // land_value = improved land + unimproved land
  const imprLand  = num(a['Impr Land Value'])  ?? 0;
  const unimprLand = num(a['Unimpr Land Value']) ?? 0;
  const land_value = imprLand + unimprLand || null;

  return {
    parcel_id:            id,
    updated_date:         date,
    assessed_value:       num(a['Assessed Value'] ?? a['Total Market Value']),
    land_value,
    improvement_value:    num(a['Building Value']),
    year_built:           num(a['Year Built']),
    sq_ft:                num(a['Living Area']),
    bedrooms:             num(a['Number of Bedrooms']),
    bathrooms:            null,                               // not in source PSV
    land_use_code:        (a['Land Use'] ?? '').trim() || null,
    zoning:               null,                               // not in source PSV
    acres:                num(a['Acres']) ?? num(l['size_acres']),
    improvements:         JSON.stringify(improvements),
    sales_history:        JSON.stringify(sales),
    latitude:             null,   // filled by geo worker
    longitude:            null,
    geometry:             null,
    absentee_owner,
    days_since_last_sale,
    raw_json:             JSON.stringify({ assessor: a, land: l, improvements, sales }),
  };
}

// Returns values in the same column order as the INSERT statement in ingest.js
export function cardToRow(c) {
  return [
    c.parcel_id, c.updated_date,
    c.assessed_value, c.land_value, c.improvement_value,
    c.year_built, c.sq_ft, c.bedrooms, c.bathrooms,
    c.land_use_code, c.zoning, c.acres,
    c.improvements, c.sales_history,
    c.latitude, c.longitude, c.geometry,
    c.absentee_owner, c.days_since_last_sale,
    c.raw_json,
  ];
}

const num = v => (v != null && v !== '') ? +v || null : null;
