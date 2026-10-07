import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

const projectRoot = resolve(import.meta.dirname, "..");
const corePath = resolve(projectRoot, "source/agropredict-core-v26-beta.js");
const source = await readFile(corePath, "utf8");
const moduleShim = { exports: {} };
const context = vm.createContext({
  module: moduleShim,
  exports: moduleShim.exports,
  console,
  URL,
  AbortController,
  setTimeout,
  clearTimeout,
});
vm.runInContext(source, context, { filename: corePath });

const {
  CROP_CLIMATE_REFERENCE_LIBRARY,
  COUNTRY_CROP_CATALOG,
  validateCropReferenceRecord,
  compareSoilPhToCropReference,
  buildPrimaryCropCheckResult,
  calculateReferenceMatchScore,
  calculateConditionMatchScore,
  calculateHistoricalRainfallFit,
  calculateEvidenceCompleteness,
} = moduleShim.exports;

const expectedPhRanges = {
  commonWheat: [6, 7, 5.5, 8.5],
  maize: [5, 7, 4.5, 8.5],
  sunflower: [6, 7.5, 5.5, 8],
  barley: [6.5, 7.5, 6, 8],
  soybean: [5.5, 6.5, 4.5, 8.4],
};

for (const [cropKey, expected] of Object.entries(expectedPhRanges)) {
  const record = CROP_CLIMATE_REFERENCE_LIBRARY[cropKey];
  assert.ok(record, `${cropKey} reference must exist`);
  assert.deepEqual(
    [record.soilPh.optimalMin, record.soilPh.optimalMax, record.soilPh.absoluteMin, record.soilPh.absoluteMax],
    expected,
    `${cropKey} pH ranges must remain pinned to the verified record`,
  );
  assert.equal(record.soilPh.comparable, true);
}

const addedCropRanges = {
  potato: [500, 800, 5, 6.2],
  rapeseed: [500, 1000, 6.5, 7.6],
  rye: [600, 1000, 5.5, 6],
  oats: [600, 1000, 5, 6],
  sugarBeet: [600, 800, 6, 7],
  grapevine: [700, 850, 5.5, 7.5],
  olive: [400, 700, 6, 7],
  tomato: [600, 1300, 5.5, 6.8],
  rice: [1500, 2000, 5.5, 7],
  buckwheat: [700, 1000, 5, 6.5],
  peas: [800, 1200, 5.5, 7],
  sorghum: [400, 600, 5.5, 7.5],
};

for (const [cropKey, expected] of Object.entries(addedCropRanges)) {
  const record = CROP_CLIMATE_REFERENCE_LIBRARY[cropKey];
  assert.ok(record, `${cropKey} reference must exist`);
  assert.equal(validateCropReferenceRecord(record).valid, true, `${cropKey} reference must validate`);
  assert.deepEqual(
    [record.rainfallAnnual.optimalMin, record.rainfallAnnual.optimalMax, record.soilPh.optimalMin, record.soilPh.optimalMax],
    expected,
  );
}

assert.equal(Object.keys(CROP_CLIMATE_REFERENCE_LIBRARY).length, 17);
for (const countryKey of ['ukraine', 'slovakia', 'portugal']) {
  assert.ok(Array.isArray(COUNTRY_CROP_CATALOG[countryKey]));
  assert.ok(COUNTRY_CROP_CATALOG[countryKey].length >= 11);
  for (const cropKey of COUNTRY_CROP_CATALOG[countryKey]) assert.ok(CROP_CLIMATE_REFERENCE_LIBRARY[cropKey]);
}

const wheatPh = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat.soilPh;
assert.equal(compareSoilPhToCropReference(6.5, wheatPh).status, "within-optimal");
assert.equal(compareSoilPhToCropReference(8, wheatPh).status, "within-absolute");
assert.equal(compareSoilPhToCropReference(4, wheatPh).status, "outside-absolute");
assert.equal(compareSoilPhToCropReference(0, wheatPh).status, "unavailable");
assert.equal(compareSoilPhToCropReference(14.1, wheatPh).status, "unavailable");
assert.equal(compareSoilPhToCropReference(Number.NaN, wheatPh).status, "unavailable");

const status = (value) => ({ status: value });

let result = buildPrimaryCropCheckResult(status("within-optimal"), status("within-optimal"));
assert.equal(result.code, "broad-match");

result = buildPrimaryCropCheckResult(status("within-optimal"), status("within-absolute"));
assert.equal(result.code, "conditional-match");

result = buildPrimaryCropCheckResult(status("outside-absolute"), status("within-optimal"));
assert.equal(result.code, "attention");

result = buildPrimaryCropCheckResult(status("within-optimal"), status("unavailable"));
assert.equal(result.code, "partial-data");

result = buildPrimaryCropCheckResult(status("unavailable"), status("unavailable"));
assert.equal(result.code, "insufficient-data");
assert.equal(result.hasScore, false);
assert.equal(result.percentageProbability, undefined);
assert.equal(result.totalComparableFactors, 2);

const wheatRain = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat.rainfallAnnual;
assert.equal(calculateReferenceMatchScore(800, wheatRain).score, 100);
assert.equal(calculateReferenceMatchScore(6.5, wheatPh).score, 100);
assert.equal(calculateReferenceMatchScore(8, wheatPh).score, 60);
assert.equal(calculateReferenceMatchScore(Number.NaN, wheatPh).score, null);

const match = calculateConditionMatchScore(800, wheatRain, 6.5, wheatPh);
assert.equal(match.status, "ok");
assert.equal(match.score, 100);
assert.equal(match.factors.length, 2);
assert.equal(match.factors[0].weight, 55);
assert.equal(match.factors[1].weight, 45);

const incompleteMatch = calculateConditionMatchScore(800, wheatRain, null, wheatPh);
assert.equal(incompleteMatch.status, "unavailable");
assert.equal(incompleteMatch.score, null);

const historyFit = calculateHistoricalRainfallFit([700, 800, 200], wheatRain);
assert.equal(historyFit.status, "ok");
assert.equal(historyFit.totalCount, 3);
assert.equal(historyFit.withinAbsoluteCount, 2);
assert.equal(historyFit.fitPercent, 67);

assert.equal(calculateEvidenceCompleteness({
  locationMode: "region",
  qualifyingYears: 30,
  soilAvailable: true,
  labPhUsed: false,
  hasSeason: false,
}).score, 49);
assert.equal(calculateEvidenceCompleteness({
  locationMode: "coordinates",
  qualifyingYears: 30,
  soilAvailable: true,
  labPhUsed: true,
  hasSeason: true,
  seasonCoverage: 1,
}).score, 100);

console.log("Primary Crop Check tests passed");
