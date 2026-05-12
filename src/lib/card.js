// Builds normalized, query-friendly parcel records from Skagit source rows.

export const PARCEL_CARD_COLUMNS = [
  'parcel_id', 'account_number', 'updated_date',
  'legal_description', 'property_type',
  'situs_street_number', 'situs_street_name', 'situs_city', 'situs_state', 'situs_zip',
  'owner_name', 'owner_city', 'owner_state', 'owner_zip', 'absentee_owner',
  'land_use_code', 'land_use_description',
  'assessed_value', 'taxable_value', 'market_value', 'building_value', 'land_value',
  'impr_land_value', 'unimpr_land_value', 'improvement_value',
  'acres', 'sq_ft', 'bedrooms', 'bathrooms', 'garage_sq_ft', 'year_built', 'effective_year_built',
  'sale_date', 'sale_price', 'sale_type', 'sale_deed_type', 'days_since_last_sale',
  'last_valid_sale_date', 'last_valid_sale_price',
  'value_per_acre', 'improvement_ratio', 'is_vacant', 'is_sfr', 'is_recreational_land',
  'distressed_transfer_recent',
  'latitude', 'longitude', 'geometry', 'raw_r2_key',
];

export const SALE_COLUMNS = [
  'id', 'parcel_id', 'sale_id', 'sale_date', 'sale_price', 'sale_type', 'deed_type',
  'seller_name', 'buyer_name', 'recording_number', 'excise_number',
];

export const IMPROVEMENT_COLUMNS = [
  'id', 'parcel_id', 'improvement_id', 'segment_id', 'improvement_type', 'improvement_class',
  'condition_code', 'calc_area', 'value', 'actual_year_built', 'effective_year_built', 'sketch_url',
];

export const LAND_SEGMENT_COLUMNS = [
  'id', 'parcel_id', 'land_type', 'acres', 'square_feet', 'market_value',
];

export function buildCard(id, assessor, land, improvements, sales, date) {
  const a = assessor ?? {};
  const landRows = Array.isArray(land) ? land : (land ? [land] : []);
  const primaryLand = landRows[0] ?? {};
  const situs = parseCityStateZip(a['Situs City State Zip']);
  const landUse = parseLandUse(a['Land Use']);
  const ownerState = cleanText(a['Owner State']);

  const assessedValue = num(a['Assessed Value'] ?? a['Total Market Value']);
  const buildingValue = num(a['Building Value']);
  const imprLandValue = num(a['Impr Land Value']);
  const unimprLandValue = num(a['Unimpr Land Value']);
  const landValue = sumNullable(imprLandValue, unimprLandValue);
  const acres = num(a['Acres']) ?? num(primaryLand.size_acres);
  const saleDate = dateOnly(a['Sale Date']);
  const salePrice = num(a['Sale Price']);
  const lastValidSale = findLastValidSale(sales);
  const daysSinceLastSale = daysSince(saleDate);
  const saleType = cleanText(sales?.[0]?.['sale type'] ?? sales?.[0]?.['Sale Type']);
  const saleDeedType = cleanText(a['Sale Deed Type'] ?? sales?.[0]?.['Deed Type']);
  const improvementValue = buildingValue;

  return {
    parcel_id: id,
    account_number: cleanText(a['Account Number']),
    updated_date: date,
    legal_description: cleanText(a['Legal Description']),
    property_type: cleanText(a['PropType']),
    situs_street_number: cleanText(a['Situs Street Number']),
    situs_street_name: cleanText(a['Situs Street Name']),
    situs_city: situs.city,
    situs_state: situs.state,
    situs_zip: situs.zip,
    owner_name: cleanText(a['Owner Name']),
    owner_city: cleanText(a['Owner City']),
    owner_state: ownerState,
    owner_zip: cleanText(a['Owner Zip']),
    absentee_owner: ownerState && ownerState !== 'WA' ? 1 : 0,
    land_use_code: landUse.code,
    land_use_description: landUse.description,
    assessed_value: assessedValue,
    taxable_value: num(a['Taxable Value']),
    market_value: num(a['Total Market Value']),
    building_value: buildingValue,
    land_value: landValue,
    impr_land_value: imprLandValue,
    unimpr_land_value: unimprLandValue,
    improvement_value: improvementValue,
    acres,
    sq_ft: num(a['Living Area']),
    bedrooms: num(a['Number of Bedrooms']),
    bathrooms: parseBathrooms(a['Plumbing']),
    garage_sq_ft: num(a['GarageSqFt']),
    year_built: num(a['Year Built']),
    effective_year_built: num(a['Eff Year Built']),
    sale_date: saleDate,
    sale_price: salePrice,
    sale_type: saleType,
    sale_deed_type: saleDeedType,
    days_since_last_sale: daysSinceLastSale,
    last_valid_sale_date: lastValidSale?.sale_date ?? null,
    last_valid_sale_price: lastValidSale?.sale_price ?? null,
    value_per_acre: assessedValue != null && acres ? assessedValue / acres : null,
    improvement_ratio: assessedValue ? (improvementValue ?? 0) / assessedValue : null,
    is_vacant: !improvementValue || improvementValue <= 0 ? 1 : 0,
    is_sfr: landUse.code === '111' ? 1 : 0,
    is_recreational_land: landUse.code === '910' ? 1 : 0,
    distressed_transfer_recent: isDistressedTransfer(saleType, saleDeedType) ? 1 : 0,
    latitude: null,
    longitude: null,
    geometry: null,
    raw_r2_key: `raw/${date}/${id}.json`,
  };
}

export function buildSalesRows(parcelId, sales = []) {
  const seen = new Set();
  const rows = [];
  for (const sale of sales) {
    const saleId = cleanText(sale.SaleID);
    const id = `${parcelId}:${saleId || rows.length}:${cleanText(sale['Recording Number'])}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      parcel_id: parcelId,
      sale_id: saleId,
      sale_date: dateOnly(sale['sale date']),
      sale_price: num(sale['sale price']),
      sale_type: cleanText(sale['sale type']),
      deed_type: cleanText(sale['Deed Type']),
      seller_name: cleanText(sale['seller name']),
      buyer_name: cleanText(sale['buyer name']),
      recording_number: cleanText(sale['Recording Number']),
      excise_number: cleanText(sale['Excise Number']),
    });
  }
  return rows;
}

export function buildImprovementRows(parcelId, improvements = []) {
  return improvements.map((imp, index) => ({
    id: `${parcelId}:${cleanText(imp.segment_id) || index}`,
    parcel_id: parcelId,
    improvement_id: cleanText(imp.imprv_id),
    segment_id: cleanText(imp.segment_id),
    improvement_type: cleanText(imp.imprv_det_type_cd),
    improvement_class: cleanText(imp.imprv_det_class_cd),
    condition_code: cleanText(imp.condition_cd),
    calc_area: num(imp.calc_area),
    value: num(imp.imprv_det_val),
    actual_year_built: num(imp.actual_year_built),
    effective_year_built: num(imp.effective_yr_blt),
    sketch_url: cleanText(imp.sketchpath),
  }));
}

export function buildLandSegmentRows(parcelId, landRows = []) {
  return landRows.map((land, index) => ({
    id: `${parcelId}:${cleanText(land.land_seg_id) || index}`,
    parcel_id: parcelId,
    land_type: cleanText(land.land_type),
    acres: num(land.size_acres),
    square_feet: num(land.size_square_feet),
    market_value: num(land.market_value),
  }));
}

export function rowFromObject(obj, columns) {
  return columns.map(column => obj[column] ?? null);
}

export function cardToRow(c) {
  return rowFromObject(c, PARCEL_CARD_COLUMNS);
}

function cleanText(value) {
  const v = String(value ?? '').trim().replace(/\s+/g, ' ');
  return v || null;
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function sumNullable(...values) {
  const nums = values.filter(value => value != null);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) : null;
}

function parseLandUse(value) {
  const text = cleanText(value);
  if (!text) return { code: null, description: null };
  const match = text.match(/^\((\d+)\)\s*(.*)$/);
  return match
    ? { code: match[1], description: cleanText(match[2]) }
    : { code: null, description: text };
}

function parseCityStateZip(value) {
  const text = cleanText(value);
  if (!text) return { city: null, state: null, zip: null };
  const match = text.match(/^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  return match
    ? { city: cleanText(match[1]), state: match[2], zip: match[3] }
    : { city: text, state: null, zip: null };
}

function dateOnly(value) {
  const text = cleanText(value);
  if (!text) return null;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : text;
}

function daysSince(date) {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.floor((Date.now() - parsed.getTime()) / 86_400_000);
}

function parseBathrooms(plumbing) {
  const text = cleanText(plumbing);
  if (!text) return null;
  let total = 0;
  if (/\bFULL BATH\b|\bFB\b/.test(text)) total += 1;
  if (/\b3\/4 BATH\b|\b3QB\b/.test(text)) total += 0.75;
  if (/\b1\/2 BATH\b|\bHB\b/.test(text)) total += 0.5;
  return total || null;
}

function findLastValidSale(sales = []) {
  return buildSalesRows('', sales)
    .filter(sale => sale.sale_price && sale.sale_price > 0 && sale.sale_date && sale.sale_type === 'VALID SALE')
    .sort((a, b) => b.sale_date.localeCompare(a.sale_date))[0] ?? null;
}

function isDistressedTransfer(saleType, deedType) {
  const text = `${saleType ?? ''} ${deedType ?? ''}`.toUpperCase();
  return /\b(ESTATE|AFFIDAVIT|QUITCLAIM|QUIT CLAIM|FAMILY|TRUSTEE|SHERIFF|FORECLOSURE)\b/.test(text);
}
