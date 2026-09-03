'use strict';

/* =====================================================================
   AgroPredict Core v20 — pure functions and async services.
   v20 over v19:
   A. Documentation corrections:
   • Header comment no longer references earlier-version error phrases.
   • Article 134 wording updated to "integral constituent part" per the
     official English text of the Constitution of Ukraine (28 June 1996).
   B. New analytical functions (Climate Extremes & Risk Flags):
   • calculateHistoricalReference — now also returns qualifyingValues
     (array of per-window aggregates that passed the coverage threshold),
     for both status:'ok' and status:'insufficient-windows'. Ordering
     corresponds to qualifyingYears. No existing return properties changed.
   • calculateEmpiricalPercentileRank(currentValue, historicalValues)
     — midrank empirical-percentile formula; returns structured result.
   • classifyClimatePercentile(parameter, percentileResult)
     — maps a percentile to a neutral display category for 'temperature'
     or 'precipitation'.
   • buildClimateExtremesResult({...})
     — orchestrates both parameters independently; no combined score.
   All v19 functionality is fully preserved.
   Works in both browser (via <script src>) and Node.js (via require).
   ===================================================================== */

// ── Constants ─────────────────────────────────────────────────────────
const HIST_REF_START_YEAR            = 1991;
const HIST_REF_END_YEAR              = 2020;
const HIST_MIN_QUALIFYING_WINDOWS    = 24;
const HIST_COVERAGE_THRESHOLD_T2M    = 0.90;
const HIST_COVERAGE_THRESHOLD_PRECIP = 1.00;
const HISTORICAL_METHOD_VERSION      = 'v2';

// ── Validation helpers ────────────────────────────────────────────────
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isValidDateKey(s) {
  if (typeof s !== 'string' || !/^\d{8}$/.test(s)) return false;
  const mo = parseInt(s.slice(4, 6), 10);
  const dy = parseInt(s.slice(6, 8), 10);
  if (mo < 1 || mo > 12 || dy < 1) return false;
  const yr     = parseInt(s.slice(0, 4), 10);
  const maxDay = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
  return dy <= maxDay;
}

function isValidValue(v) {
  return typeof v === 'number' && Number.isFinite(v) && v !== -999;
}

// ── Coordinate validation ─────────────────────────────────────────────
function validateCoordinates(latInput, lonInput) {
  function parseStrict(raw) {
    if (typeof raw !== 'string') return NaN;
    const t = raw.trim();
    if (t === '') return NaN;
    return Number(t);
  }
  const latRaw = (latInput == null) ? '' : String(latInput);
  const lonRaw = (lonInput == null) ? '' : String(lonInput);
  if (latRaw.trim() === '') return { valid: false, field: 'lat', message: 'Enter a latitude.' };
  const lat = parseStrict(latRaw);
  if (!Number.isFinite(lat)) return { valid: false, field: 'lat', message: 'Latitude must be a number between −90 and 90.' };
  if (lat < -90 || lat > 90)  return { valid: false, field: 'lat', message: 'Latitude must be a number between −90 and 90.' };
  if (lonRaw.trim() === '') return { valid: false, field: 'lon', message: 'Enter a longitude.' };
  const lon = parseStrict(lonRaw);
  if (!Number.isFinite(lon)) return { valid: false, field: 'lon', message: 'Longitude must be a number between −180 and 180.' };
  if (lon < -180 || lon > 180) return { valid: false, field: 'lon', message: 'Longitude must be a number between −180 and 180.' };
  return { valid: true, lat, lon };
}

// ── Date helpers ──────────────────────────────────────────────────────
function subtractUtcMonthsClamped(date, numberOfMonths) {
  const y         = date.getUTCFullYear();
  const m         = date.getUTCMonth();
  const d         = date.getUTCDate();
  const targetRaw  = m - numberOfMonths;
  const targetYear = y + Math.floor(targetRaw / 12);
  const targetMon  = ((targetRaw % 12) + 12) % 12;
  const lastDay    = new Date(Date.UTC(targetYear, targetMon + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMon, Math.min(d, lastDay)));
}

// ── Request builders ──────────────────────────────────────────────────
function buildPowerRequest(lat, lon, periodMonths) {
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  if (![3, 6, 12].includes(periodMonths)) return null;
  const now      = new Date();
  const endDate  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const startDate = subtractUtcMonthsClamped(endDate, periodMonths);
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const startStr = fmt(startDate);
  const endStr   = fmt(endDate);
  const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M,PRECTOTCORR,RH2M&community=AG&longitude=${lon}&latitude=${lat}&start=${startStr}&end=${endStr}&format=JSON`;
  return { url, startDate, endDate, startStr, endStr, coords: { lat, lon } };
}

function buildHistoricalWindowDefinitions(startStr, endStr) {
  const csM = parseInt(startStr.slice(4, 6), 10) - 1;
  const csD = parseInt(startStr.slice(6, 8), 10);
  const ceM = parseInt(endStr.slice(4, 6), 10) - 1;
  const ceD = parseInt(endStr.slice(6, 8), 10);
  const yearCrossing = (ceM < csM) || (ceM === csM && ceD < csD);
  const windows = [];
  for (let year = HIST_REF_START_YEAR; year <= HIST_REF_END_YEAR; year++) {
    const winStartMs = yearCrossing ? Date.UTC(year - 1, csM, csD) : Date.UTC(year, csM, csD);
    const winEndMs   = Date.UTC(year, ceM, ceD);
    const winStart   = new Date(winStartMs);
    const winEnd     = new Date(winEndMs);
    let expectedDays = 0;
    for (let cur = winStartMs; cur <= winEndMs; cur += 86400000) {
      const d = new Date(cur);
      if (!(d.getUTCMonth() === 1 && d.getUTCDate() === 29)) expectedDays++;
    }
    windows.push({ year, startDate: winStart, endDate: winEnd, expectedDays });
  }
  return windows;
}

function buildHistoricalCacheKey(lat, lon, startStr, endStr) {
  return `${HISTORICAL_METHOD_VERSION}|hist|${lat}|${lon}|${startStr.slice(4, 8)}|${endStr.slice(4, 8)}|T2M,PRECTOTCORR|${HIST_REF_START_YEAR}-${HIST_REF_END_YEAR}`;
}

function buildHistoricalPowerRequest(lat, lon, startStr, endStr) {
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  const windows = buildHistoricalWindowDefinitions(startStr, endStr);
  if (!windows || windows.length === 0) return null;
  const histStart = windows[0].startDate;
  const histEnd   = windows[windows.length - 1].endDate;
  const fmtUtc = d => {
    const y   = String(d.getUTCFullYear());
    const mon = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${mon}${day}`;
  };
  const histStartStr = fmtUtc(histStart);
  const histEndStr   = fmtUtc(histEnd);
  const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M,PRECTOTCORR&community=AG&longitude=${lon}&latitude=${lat}&start=${histStartStr}&end=${histEndStr}&format=JSON`;
  return { url, windows, startStr: histStartStr, endStr: histEndStr };
}

/* ── buildAnnualPrecipPowerRequest ───────────────────────────────────
   Internal helper for annual precipitation screening.
   URL uses parameters=PRECTOTCORR ONLY — no T2M, no RH2M.
   Distinct from buildHistoricalPowerRequest which fetches T2M+PRECTOTCORR.
   ──────────────────────────────────────────────────────────────────── */
function buildAnnualPrecipPowerRequest(lat, lon) {
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  const windows = buildHistoricalWindowDefinitions('19910101', '20201231');
  if (!windows || windows.length === 0) return null;
  const histStart = windows[0].startDate;
  const histEnd   = windows[windows.length - 1].endDate;
  const fmtUtc = d => {
    const y   = String(d.getUTCFullYear());
    const mon = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${mon}${day}`;
  };
  const histStartStr = fmtUtc(histStart);
  const histEndStr   = fmtUtc(histEnd);
  const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR&community=AG&longitude=${lon}&latitude=${lat}&start=${histStartStr}&end=${histEndStr}&format=JSON`;
  return { url, windows, startStr: histStartStr, endStr: histEndStr };
}

// ── Grouping and coverage ─────────────────────────────────────────────
function groupDailyValuesByHistoricalWindow(dailyData, windows) {
  const result = windows.map(w => ({
    year: w.year, startDate: w.startDate, endDate: w.endDate,
    expectedDays: w.expectedDays, t2mByDate: {}, precipByDate: {}
  }));
  function assignToWindow(dateStr, value, targetKey) {
    if (!isValidDateKey(dateStr)) return;
    const yr = parseInt(dateStr.slice(0, 4), 10);
    const mo = parseInt(dateStr.slice(4, 6), 10) - 1;
    const dy = parseInt(dateStr.slice(6, 8), 10);
    if (mo === 1 && dy === 29) return;
    const dateMs = Date.UTC(yr, mo, dy);
    for (let i = 0; i < result.length; i++) {
      const w = result[i];
      if (dateMs >= w.startDate.getTime() && dateMs <= w.endDate.getTime()) {
        w[targetKey][dateStr] = value;
        break;
      }
    }
  }
  const t2m  = (dailyData && dailyData.T2M)        || {};
  const prec = (dailyData && dailyData.PRECTOTCORR) || {};
  Object.entries(t2m).forEach(([d, v])  => assignToWindow(d, v, 't2mByDate'));
  Object.entries(prec).forEach(([d, v]) => assignToWindow(d, v, 'precipByDate'));
  return result;
}

function calculateWindowCoverage(values, expectedDays) {
  function isV(v) { return typeof v === 'number' && Number.isFinite(v) && v !== -999; }
  if (!values || typeof values !== 'object' || expectedDays <= 0) {
    return { validCount: 0, expectedDays: expectedDays || 0, coverage: 0 };
  }
  const validCount = Object.values(values).filter(isV).length;
  return { validCount, expectedDays, coverage: validCount / expectedDays };
}

function calculateHistoricalReference(groupedWindows, paramKey, aggregator) {
  function isV(v) { return typeof v === 'number' && Number.isFinite(v) && v !== -999; }
  const qualifyingYears  = [];
  const qualifyingValues = [];
  const threshold = paramKey === 'precipByDate' ? HIST_COVERAGE_THRESHOLD_PRECIP : HIST_COVERAGE_THRESHOLD_T2M;
  for (const w of groupedWindows) {
    const values = w[paramKey] || {};
    const cov = calculateWindowCoverage(values, w.expectedDays);
    if (cov.coverage < threshold) continue;
    const valid = Object.values(values).filter(isV);
    if (valid.length === 0) continue;
    const wVal = aggregator === 'mean'
      ? valid.reduce((a, b) => a + b, 0) / valid.length
      : valid.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(wVal)) continue;
    qualifyingYears.push(w.year);
    qualifyingValues.push(wVal);
  }
  if (qualifyingYears.length < HIST_MIN_QUALIFYING_WINDOWS) {
    return {
      status: 'insufficient-windows',
      qualifyingCount: qualifyingYears.length,
      qualifyingYears,
      qualifyingValues,
      historicalMean: null,
      message: `Historical comparison unavailable: fewer than ${HIST_MIN_QUALIFYING_WINDOWS} valid annual windows remain after data-quality checks. (${qualifyingYears.length} of 30 qualify.) AgroPredict display rule: minimum ${HIST_MIN_QUALIFYING_WINDOWS} of 30 windows required. This is not a NASA or WMO threshold.`
    };
  }
  const historicalMean = qualifyingValues.reduce((a, b) => a + b, 0) / qualifyingValues.length;
  return { status: 'ok', qualifyingCount: qualifyingYears.length, qualifyingYears, qualifyingValues, historicalMean };
}

// ── Aggregation helpers ───────────────────────────────────────────────
function aggregateMeanStrict(obj) {
  const vals = Object.values(obj).filter(isValidValue);
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
function aggregateSumStrict(obj) {
  const vals = Object.values(obj).filter(isValidValue);
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
}
function countValidStrict(obj) {
  return Object.values(obj).filter(isValidValue).length;
}

// ── Current-period calculations ───────────────────────────────────────
function calculateCurrentPeriodCoverage(rawT2M, rawPrecip, startStr, endStr) {
  const startMs = Date.UTC(
    parseInt(startStr.slice(0, 4), 10), parseInt(startStr.slice(4, 6), 10) - 1, parseInt(startStr.slice(6, 8), 10)
  );
  const endMs = Date.UTC(
    parseInt(endStr.slice(0, 4), 10), parseInt(endStr.slice(4, 6), 10) - 1, parseInt(endStr.slice(6, 8), 10)
  );
  let expectedDays = 0;
  for (let cur = startMs; cur <= endMs; cur += 86400000) {
    const d = new Date(cur);
    if (!(d.getUTCMonth() === 1 && d.getUTCDate() === 29)) expectedDays++;
  }
  if (expectedDays <= 0) {
    return { t2mCoverage: 0, precipCoverage: 0, t2mValidCount: 0, precipValidCount: 0,
             expectedDays: 0, t2mQualifies: false, precipQualifies: false };
  }
  function isFeb29(s) {
    return typeof s === 'string' && s.length === 8 && s.slice(4, 6) === '02' && s.slice(6, 8) === '29';
  }
  const t2mEntries    = isPlainObject(rawT2M)    ? Object.entries(rawT2M)    : [];
  const precipEntries = isPlainObject(rawPrecip) ? Object.entries(rawPrecip) : [];
  const t2mValidCount = t2mEntries.filter(
    ([d, v]) => isValidDateKey(d) && d >= startStr && d <= endStr && !isFeb29(d) && isValidValue(v)
  ).length;
  const precipValidCount = precipEntries.filter(
    ([d, v]) => isValidDateKey(d) && d >= startStr && d <= endStr && !isFeb29(d) && isValidValue(v)
  ).length;
  const t2mCoverage    = Math.min(t2mValidCount    / expectedDays, 1);
  const precipCoverage = Math.min(precipValidCount / expectedDays, 1);
  return {
    t2mCoverage, precipCoverage, t2mValidCount, precipValidCount, expectedDays,
    t2mQualifies:    t2mCoverage    >= HIST_COVERAGE_THRESHOLD_T2M,
    precipQualifies: precipCoverage >= HIST_COVERAGE_THRESHOLD_PRECIP
  };
}

function calculateCurrentPeriodAnomalyValues(rawT2M, rawPrecip, startStr, endStr) {
  function isFeb29(dateStr) {
    return typeof dateStr === 'string' && dateStr.length === 8 &&
           dateStr.slice(4, 6) === '02' && dateStr.slice(6, 8) === '29';
  }
  const t2mEntries    = isPlainObject(rawT2M)    ? Object.entries(rawT2M)    : [];
  const precipEntries = isPlainObject(rawPrecip) ? Object.entries(rawPrecip) : [];
  const t2mVals = t2mEntries
    .filter(([d, v]) => isValidDateKey(d) && d >= startStr && d <= endStr && !isFeb29(d) && isValidValue(v))
    .map(([, v]) => v);
  const precVals = precipEntries
    .filter(([d, v]) => isValidDateKey(d) && d >= startStr && d <= endStr && !isFeb29(d) && isValidValue(v))
    .map(([, v]) => v);
  const meanT2M   = t2mVals.length  > 0 ? t2mVals.reduce((a, b)  => a + b, 0) / t2mVals.length : null;
  const totalPrec = precVals.length > 0 ? precVals.reduce((a, b) => a + b, 0) : null;
  return { meanT2M, totalPrecip: totalPrec };
}

// ── Anomaly calculations ──────────────────────────────────────────────
function calculateTemperatureAnomaly(currentMean, historicalMean) {
  if (typeof currentMean    !== 'number' || !Number.isFinite(currentMean))
    return { status: 'unavailable', reason: 'Current period mean temperature is not a finite number' };
  if (typeof historicalMean !== 'number' || !Number.isFinite(historicalMean))
    return { status: 'unavailable', reason: 'Historical reference mean is not a finite number' };
  const difference = currentMean - historicalMean;
  const rounded    = Math.round(difference * 10) / 10;
  if (rounded === 0) return { status: 'zero', difference, rounded, direction: 'zero' };
  return { status: 'ok', difference, rounded, direction: difference > 0 ? 'warmer' : 'cooler' };
}

function calculatePrecipitationAnomaly(currentTotal, historicalMean) {
  if (typeof currentTotal   !== 'number' || !Number.isFinite(currentTotal))
    return { status: 'unavailable', reason: 'Current period precipitation total is not a finite number' };
  if (typeof historicalMean !== 'number' || !Number.isFinite(historicalMean))
    return { status: 'unavailable', reason: 'Historical reference mean is not a finite number' };
  const differenceMm = currentTotal - historicalMean;
  const roundedMm    = Math.round(differenceMm * 10) / 10;
  const differencePercent = historicalMean > 0
    ? Math.round((differenceMm / historicalMean * 100) * 10) / 10
    : null;
  if (roundedMm === 0) return { status: 'zero', differenceMm, roundedMm, differencePercent, direction: 'zero' };
  return { status: 'ok', differenceMm, roundedMm, differencePercent,
           direction: differenceMm > 0 ? 'wetter' : 'drier' };
}

function formatHistoricalComparison(tempAnomaly, precipAnomaly) {
  function fmtTemp(a) {
    if (a.status === 'unavailable') return { text: 'Unavailable: ' + a.reason, direction: 'unavailable' };
    if (a.status === 'zero')        return { text: 'No material difference after rounding', direction: 'zero' };
    const abs = Math.abs(a.rounded).toFixed(1);
    return { text: `${abs} \xb0C ${a.direction} than the 1991–2020 reference`, direction: a.direction };
  }
  function fmtPrecip(a) {
    if (a.status === 'unavailable') return { text: 'Unavailable: ' + a.reason, direction: 'unavailable' };
    if (a.status === 'zero')        return { text: 'No material difference after rounding', direction: 'zero' };
    const absMm = Math.abs(a.roundedMm).toFixed(1);
    let text = `${absMm} mm ${a.direction} than the 1991–2020 reference`;
    if (a.differencePercent !== null) {
      const sign = a.differencePercent >= 0 ? '+' : '−';
      text += ` (${sign}${Math.abs(a.differencePercent).toFixed(1)}%)`;
    }
    return { text, direction: a.direction };
  }
  return { temp: fmtTemp(tempAnomaly), precip: fmtPrecip(precipAnomaly) };
}

function compareToReferenceRange(value, optimalMin, optimalMax, absoluteMin, absoluteMax) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return { status: 'unavailable', reason: 'Observed value is not a finite number' };
  const args = [optimalMin, optimalMax, absoluteMin, absoluteMax];
  if (args.some(v => typeof v !== 'number' || !Number.isFinite(v)))
    return { status: 'unavailable', reason: 'Reference range contains non-finite values' };
  if (optimalMin > optimalMax || absoluteMin > absoluteMax ||
      absoluteMin > optimalMin || optimalMax > absoluteMax)
    return { status: 'unavailable', reason: 'Reference range is invalid or reversed' };
  if (value >= optimalMin && value <= optimalMax)
    return { status: 'within-optimal', label: 'Within published optimal reference range' };
  if (value >= absoluteMin && value <= absoluteMax)
    return { status: 'within-absolute', label: 'Within published absolute range, outside optimal range' };
  return { status: 'outside-absolute', label: 'Outside published absolute reference range' };
}

/* =====================================================================
   ASYNC SERVICE: fetchHistoricalReference
   abortReasonRef: { value: null } — mutable ref shared with caller.
   The timeout callback sets abortReasonRef.value = 'timeout' before
   calling abort(), so the catch block can distinguish timeout from
   intentional cancellation (user-cancel / control-change / new-request).
   ===================================================================== */
async function fetchHistoricalReference({
  url,
  fetchImpl,
  abortController,
  timeoutMs = 90000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  abortReasonRef = null,
}) {
  const signal = abortController ? abortController.signal : undefined;
  let timeoutId;
  try {
    if (timeoutMs > 0) {
      timeoutId = setTimeoutImpl(() => {
        if (abortReasonRef) abortReasonRef.value = 'timeout';
        if (abortController) abortController.abort();
      }, timeoutMs);
    }
    const response = await fetchImpl(url, { signal, headers: { 'Accept': 'application/json' } });
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}: ${response.statusText}`);
      err.httpStatus = response.status;
      throw err;
    }
    const data = await response.json();
    if (!data.properties || !data.properties.parameter) {
      throw new Error('Unexpected historical API response structure — missing properties.parameter');
    }
    const hp = data.properties.parameter;
    if (!isPlainObject(hp.T2M) || !isPlainObject(hp.PRECTOTCORR)) {
      throw new Error('Historical API response: T2M or PRECTOTCORR is not a plain object');
    }
    return { parameterData: hp };
  } catch (err) {
    if (err.name === 'AbortError' && abortReasonRef) {
      err.abortReason = abortReasonRef.value || 'unknown';
    }
    throw err;
  } finally {
    if (timeoutId !== undefined) clearTimeoutImpl(timeoutId);
  }
}

/* =====================================================================
   ASYNC SERVICE: fetchAnnualPrecipitationReference
   Dedicated fetch for annual precipitation crop screening.
   Validates ONLY PRECTOTCORR — does NOT require T2M or RH2M.
   Injectable dependencies: fetchImpl, abortController, setTimeoutImpl,
   clearTimeoutImpl, abortReasonRef.
   abortReasonRef.value = 'timeout' set by timeout callback before abort,
   so caller can distinguish timeout from cancellation.
   ===================================================================== */
async function fetchAnnualPrecipitationReference({
  url,
  fetchImpl,
  abortController,
  timeoutMs = 90000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  abortReasonRef = null,
}) {
  const signal = abortController ? abortController.signal : undefined;
  let timeoutId;
  try {
    if (timeoutMs > 0) {
      timeoutId = setTimeoutImpl(() => {
        if (abortReasonRef) abortReasonRef.value = 'timeout';
        if (abortController) abortController.abort();
      }, timeoutMs);
    }
    const response = await fetchImpl(url, { signal, headers: { 'Accept': 'application/json' } });
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}: ${response.statusText}`);
      err.httpStatus = response.status;
      throw err;
    }
    const data = await response.json();
    if (!data.properties || !data.properties.parameter) {
      throw new Error('Unexpected annual precipitation API response structure — missing properties.parameter');
    }
    const hp = data.properties.parameter;
    if (!isPlainObject(hp.PRECTOTCORR)) {
      throw new Error('Annual precipitation API response: PRECTOTCORR is not a plain object');
    }
    /* Only PRECTOTCORR is returned — T2M is not requested or validated */
    return { parameterData: { PRECTOTCORR: hp.PRECTOTCORR } };
  } catch (err) {
    if (err.name === 'AbortError' && abortReasonRef) {
      err.abortReason = abortReasonRef.value || 'unknown';
    }
    throw err;
  } finally {
    if (timeoutId !== undefined) clearTimeoutImpl(timeoutId);
  }
}

/* =====================================================================
   CACHE HELPER: getHistoricalReference
   ===================================================================== */
async function getHistoricalReference({ cache, cacheKey, fetcher, now = () => new Date() }) {
  const existing = cache.get(cacheKey);
  if (existing) {
    return { parameterData: existing.parameterData, fetchedAt: existing.fetchedAt, fromCache: true };
  }
  const result = await fetcher();
  const entry = {
    parameterData: result.parameterData,
    fetchedAt: now().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  };
  cache.set(cacheKey, entry);
  return { parameterData: entry.parameterData, fetchedAt: entry.fetchedAt, fromCache: false };
}

/* =====================================================================
   PRODUCTION LIFECYCLE: runHistoricalLifecycle
   Handles stale-response detection and abort-reason disambiguation.
   Used by BOTH AgroPredict(13).html (production) and the test suite.

   Loading-state ownership invariant:
     setLoading is NEVER called when the request is stale. The cancel
     function (cancelActiveHistRequest in the HTML) is responsible for
     hiding the loading indicator on explicit cancellation. This prevents
     a stale request A from hiding the loading indicator of a newer
     concurrent request B.

   Abort-reason model:
     'timeout'        → onTimeout() is called
     'unknown'        → onError() called with neutral interruption message
     'user-cancel'    → silent drop (histId stale; stale check fires first)
     'control-change' → silent drop (both IDs stale; stale check fires first)
     'new-request'    → silent drop (mainId stale; stale check fires first)

   Invariant: neither onSuccess, onError, onTimeout, nor setLoading is
   ever called when coordinator.isEitherStale(mainRequestId, histRequestId)
   is true.
   ===================================================================== */
async function runHistoricalLifecycle({
  mainRequestId,
  histRequestId,
  coordinator,
  fetcher,
  abortReasonRef,
  onSuccess,
  onError,
  onTimeout,
  setLoading,
}) {
  if (coordinator.isEitherStale(mainRequestId, histRequestId)) {
    return;
  }

  let result;
  try {
    result = await fetcher();
  } catch (err) {
    if (coordinator.isEitherStale(mainRequestId, histRequestId)) {
      return;
    }

    setLoading(false);

    if (err.name === 'AbortError') {
      const reason = err.abortReason || (abortReasonRef && abortReasonRef.value) || 'unknown';
      if (reason === 'timeout') {
        onTimeout();
      } else if (reason === 'unknown') {
        onError('Historical data request was interrupted before completion.');
      }
      return;
    }

    onError(err.message || 'Unknown error');
    return;
  }

  if (coordinator.isEitherStale(mainRequestId, histRequestId)) {
    return;
  }

  setLoading(false);
  onSuccess(result);
}

/* =====================================================================
   XSS-SAFE ERROR RENDERER HELPER
   Uses injectable DOM factory so tests can verify textContent path
   without requiring a real browser document.
   domFactory: { createElement(tag): Element, createTextNode(text): Text }
   ===================================================================== */
function appendSafeHistoricalError(container, message, domFactory) {
  const { createElement, createTextNode } = domFactory;
  const errDiv = createElement('div');
  errDiv.style.cssText = 'margin-top:1.25rem;padding:.85rem 1rem;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:var(--radius-sm);font-size:.8rem;color:#991B1B';
  const strong = createElement('strong');
  strong.textContent = 'Historical reference unavailable: ';
  errDiv.appendChild(strong);
  errDiv.appendChild(createTextNode(message));
  container.innerHTML = '';
  container.appendChild(errDiv);
}

/* =====================================================================
   CLASS: HistoricalRequestCoordinator
   Single source of truth for main and historical request identities.
   invalidateMainOnly  — use when cancelling only the main request
   invalidateHistOnly  — use when the hist toggle is turned off
   invalidateAll       — use on location/period/mode changes
   ===================================================================== */
class HistoricalRequestCoordinator {
  constructor() { this._mainId = 0; this._histId = 0; }
  startMainRequest()  { return ++this._mainId; }
  startHistRequest()  { return ++this._histId; }
  invalidateMainOnly() { this._mainId++; }
  invalidateHistOnly() { this._histId++; }
  invalidateAll()     { this._mainId++; this._histId++; }
  isMainStale(id)     { return id !== this._mainId; }
  isHistStale(id)     { return id !== this._histId; }
  isEitherStale(mainId, histId) {
    return mainId !== this._mainId || histId !== this._histId;
  }
  get mainId() { return this._mainId; }
  get histId() { return this._histId; }
}

/* =====================================================================
   FARM ECONOMICS CALCULATOR — pure functions, no DOM access.

   User supplies every assumption. No market prices, benchmark yields,
   production costs, or regional averages are inserted automatically.
   Climate indicators do not alter financial results.

   Terminology:
     Gross margin     = revenue − variable costs
     Operating result = revenue − variable costs − fixed costs entered
   ===================================================================== */

/* ── Strict parsers ──────────────────────────────────────────────────
   All parsers operate on trimmed strings and Number().
   Partial strings ("12abc") produce a non-finite number → error.
   Arrays, objects, booleans → coerce to non-finite or wrong type → error.
   Do NOT use parseFloat(); Number() on a partial string is NaN.
   ──────────────────────────────────────────────────────────────────── */
function parseStrictPositiveNumber(raw, fieldName) {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
    return { error: true, message: `${fieldName} is required.` };
  }
  if (typeof raw !== 'string') return { error: true, message: `${fieldName} must be a number.` };
  const t = raw.trim();
  const n = Number(t);
  if (!Number.isFinite(n)) return { error: true, message: `${fieldName} must be a valid finite number.` };
  if (n <= 0) return { error: true, message: `${fieldName} must be greater than 0.` };
  return { value: n };
}

function parseOptionalNonNegativeNumber(raw, fieldName) {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return { value: 0 };
  if (typeof raw !== 'string') return { error: true, message: `${fieldName} must be a number.` };
  const t = raw.trim();
  const n = Number(t);
  if (!Number.isFinite(n)) return { error: true, message: `${fieldName} must be a valid finite number.` };
  if (n < 0) return { error: true, message: `${fieldName} must be 0 or greater.` };
  return { value: n };
}

/* ── validateFarmEconomicsInput ──────────────────────────────────────
   rawInput: object with string values from form fields.
   Returns { valid: true, parsed: {...} } or { valid: false, errors: [...] }.
   ──────────────────────────────────────────────────────────────────── */
function validateFarmEconomicsInput(rawInput) {
  const errors = [];
  const parsed = {};

  function req(key, label, outKey) {
    const r = parseStrictPositiveNumber(rawInput[key], label);
    if (r.error) errors.push({ field: key, message: r.message });
    else parsed[outKey || key] = r.value;
  }
  function opt(key, outKey) {
    const r = parseOptionalNonNegativeNumber(rawInput[key], key);
    if (r.error) errors.push({ field: key, message: r.message });
    else parsed[outKey || key] = r.value;
  }

  req('area',       'Area',              'areaHectares');
  req('yieldPerHa', 'Expected yield',    'expectedYieldTonnesPerHectare');
  req('salePrice',  'Sale price',        'salePricePerTonne');
  opt('seeds',          'seedsPerHa');
  opt('fertiliser',     'fertiliserPerHa');
  opt('cropProtection', 'cropProtectionPerHa');
  opt('fuelMachinery',  'fuelMachineryPerHa');
  opt('labour',         'labourPerHa');
  opt('irrigation',     'irrigationPerHa');
  opt('insurance',      'insurancePerHa');
  opt('landRent',       'landRentPerHa');
  opt('otherVariable',  'otherVariablePerHa');
  opt('otherFixed',     'otherFixedCosts');

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, parsed };
}

/* ── calculateFarmEconomics ──────────────────────────────────────────
   parsedInput: fully-validated numbers from validateFarmEconomicsInput.
   No rounding at this stage — caller rounds for display only.
   Guards all divisions; returns null for any undefined quotient.
   ──────────────────────────────────────────────────────────────────── */
function calculateFarmEconomics(parsedInput) {
  const {
    areaHectares, expectedYieldTonnesPerHectare, salePricePerTonne,
    seedsPerHa, fertiliserPerHa, cropProtectionPerHa, fuelMachineryPerHa,
    labourPerHa, irrigationPerHa, insurancePerHa, landRentPerHa,
    otherVariablePerHa, otherFixedCosts,
  } = parsedInput;

  const totalProductionTonnes = areaHectares * expectedYieldTonnesPerHectare;
  const totalRevenue          = totalProductionTonnes * salePricePerTonne;

  const variableCostPerHectare =
    seedsPerHa + fertiliserPerHa + cropProtectionPerHa + fuelMachineryPerHa
    + labourPerHa + irrigationPerHa + insurancePerHa + landRentPerHa
    + otherVariablePerHa;

  const totalVariableCosts   = variableCostPerHectare * areaHectares;
  const totalScenarioCosts   = totalVariableCosts + otherFixedCosts;

  const grossMargin           = totalRevenue - totalVariableCosts;
  const grossMarginPerHectare = areaHectares > 0 ? grossMargin / areaHectares : null;

  const operatingResult           = totalRevenue - totalScenarioCosts;
  const operatingResultPerHectare = areaHectares > 0 ? operatingResult / areaHectares : null;

  const operatingMarginPercent = totalRevenue > 0
    ? (operatingResult / totalRevenue) * 100 : null;

  const breakEvenYieldTonnesPerHectare =
    (areaHectares > 0 && salePricePerTonne > 0)
      ? totalScenarioCosts / (areaHectares * salePricePerTonne) : null;

  const breakEvenPricePerTonne =
    totalProductionTonnes > 0 ? totalScenarioCosts / totalProductionTonnes : null;

  const costPerTonne =
    totalProductionTonnes > 0 ? totalScenarioCosts / totalProductionTonnes : null;

  return {
    totalProductionTonnes,
    totalRevenue,
    variableCostPerHectare,
    totalVariableCosts,
    totalScenarioCosts,
    grossMargin,
    grossMarginPerHectare,
    operatingResult,
    operatingResultPerHectare,
    operatingMarginPercent,
    breakEvenYieldTonnesPerHectare,
    breakEvenPricePerTonne,
    costPerTonne,
  };
}

/* ── validateSensitivityInput ────────────────────────────────────────
   rawYieldStep, rawPriceStep: strings from input fields.
   Must be finite, > 0, < 100.
   Blank → invalid (sensitivity table is omitted, main calc is unaffected).
   ──────────────────────────────────────────────────────────────────── */
function validateSensitivityInput(rawYieldStep, rawPriceStep) {
  function parseSensStep(raw, label) {
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
      return { error: true, message: `${label} is required for sensitivity analysis.` };
    }
    if (typeof raw !== 'string') return { error: true, message: `${label} must be a number.` };
    const t = raw.trim();
    const n = Number(t);
    if (!Number.isFinite(n)) return { error: true, message: `${label} must be a valid finite number.` };
    if (n <= 0)   return { error: true, message: `${label} must be greater than 0.` };
    if (n >= 100) return { error: true, message: `${label} must be less than 100.` };
    return { value: n };
  }
  const yr = parseSensStep(rawYieldStep, 'Yield step');
  const pr = parseSensStep(rawPriceStep, 'Price step');
  const errors = [];
  if (yr.error) errors.push({ field: 'yieldStep', message: yr.message });
  if (pr.error) errors.push({ field: 'priceStep', message: pr.message });
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, yieldStep: yr.value, priceStep: pr.value };
}

/* ── calculateSensitivityMatrix ──────────────────────────────────────
   baseParams: { areaHectares, expectedYieldTonnesPerHectare,
                 salePricePerTonne, totalScenarioCosts }
   sensitivityInput: { yieldStep, priceStep } (validated percentages)
   Costs held constant; only yield and price vary.
   Returns 3-element array of rows (yield−step, base, yield+step);
   each row is 3-element array (price−step, base, price+step).
   ──────────────────────────────────────────────────────────────────── */
function calculateSensitivityMatrix(baseParams, sensitivityInput) {
  const { areaHectares, expectedYieldTonnesPerHectare, salePricePerTonne, totalScenarioCosts } = baseParams;
  const { yieldStep, priceStep } = sensitivityInput;
  const yieldChanges = [-yieldStep, 0, yieldStep];
  const priceChanges = [-priceStep, 0, priceStep];
  return yieldChanges.map(yc => {
    const scenarioYield = expectedYieldTonnesPerHectare * (1 + yc / 100);
    return priceChanges.map(pc => {
      const scenarioPrice           = salePricePerTonne * (1 + pc / 100);
      const scenarioRevenue         = areaHectares * scenarioYield * scenarioPrice;
      const scenarioOperatingResult = scenarioRevenue - totalScenarioCosts;
      return { yieldChangePercent: yc, priceChangePercent: pc,
               scenarioYield, scenarioPrice, scenarioRevenue, scenarioOperatingResult };
    });
  });
}

/* ── formatCurrencyValue ─────────────────────────────────────────────
   Display helper — does NOT convert between currencies.
   currency: 'UAH' | 'EUR' | 'USD'
   Returns a string with locale-aware number and explicit currency label.
   ──────────────────────────────────────────────────────────────────── */
function formatCurrencyValue(value, currency) {
  if (!Number.isFinite(value)) return 'N/A';
  const abs    = Math.abs(value);
  const sign   = value < 0 ? '−' : '';
  const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${formatted} ${currency}`;
}

/* =====================================================================
   FARM ECONOMICS FIELD MAP
   Single authoritative mapping: validation field key → DOM element IDs.
   Used by production HTML and shared with the test suite so both
   exercise the same mapping without duplication.
   ===================================================================== */
const FARM_FIELD_MAP = {
  area:           { inputId: 'fecon-area',           errorId: 'err-area' },
  yieldPerHa:     { inputId: 'fecon-yield',           errorId: 'err-yield' },
  salePrice:      { inputId: 'fecon-price',           errorId: 'err-price' },
  seeds:          { inputId: 'fecon-seeds',           errorId: 'err-seeds' },
  fertiliser:     { inputId: 'fecon-fertiliser',      errorId: 'err-fertiliser' },
  cropProtection: { inputId: 'fecon-crop-protection', errorId: 'err-cropProtection' },
  fuelMachinery:  { inputId: 'fecon-fuel',            errorId: 'err-fuelMachinery' },
  labour:         { inputId: 'fecon-labour',          errorId: 'err-labour' },
  irrigation:     { inputId: 'fecon-irrigation',      errorId: 'err-irrigation' },
  insurance:      { inputId: 'fecon-insurance',       errorId: 'err-insurance' },
  landRent:       { inputId: 'fecon-rent',            errorId: 'err-landRent' },
  otherVariable:  { inputId: 'fecon-other-var',       errorId: 'err-otherVariable' },
  otherFixed:     { inputId: 'fecon-fixed',           errorId: 'err-otherFixed' },
};

/* ── DOM helper: clearAllFarmValidationErrors ────────────────────────
   Clears every field-error element and removes aria-invalid from every
   input in fieldMap. docLike must have getElementById(id).
   ──────────────────────────────────────────────────────────────────── */
function clearAllFarmValidationErrors(fieldMap, docLike) {
  Object.values(fieldMap).forEach(function (mapping) {
    var errEl   = docLike.getElementById(mapping.errorId);
    var inputEl = docLike.getElementById(mapping.inputId);
    if (errEl)   errEl.textContent = '';
    if (inputEl) inputEl.removeAttribute('aria-invalid');
  });
}

/* ── DOM helper: clearFarmValidationError ────────────────────────────
   Clears the error element and removes aria-invalid for one field only.
   Other fields are left untouched, preserving their current error state.
   ──────────────────────────────────────────────────────────────────── */
function clearFarmValidationError(field, fieldMap, docLike) {
  var mapping = fieldMap[field];
  if (!mapping) return;
  var errEl   = docLike.getElementById(mapping.errorId);
  var inputEl = docLike.getElementById(mapping.inputId);
  if (errEl)   errEl.textContent = '';
  if (inputEl) inputEl.removeAttribute('aria-invalid');
}

/* ── DOM helper: applyFarmValidationErrors ───────────────────────────
   1. Clears all previous field errors.
   2. Sets textContent on each error element and aria-invalid on each
      input identified in the errors array.
   3. Focuses the first invalid input (in errors-array order).
   docLike must have getElementById(id).
   ──────────────────────────────────────────────────────────────────── */
function applyFarmValidationErrors(errors, fieldMap, docLike) {
  clearAllFarmValidationErrors(fieldMap, docLike);
  var firstInvalidEl = null;
  errors.forEach(function (e) {
    var mapping = fieldMap[e.field];
    if (!mapping) return;
    var errEl   = docLike.getElementById(mapping.errorId);
    var inputEl = docLike.getElementById(mapping.inputId);
    if (errEl)   errEl.textContent = e.message;
    if (inputEl) {
      inputEl.setAttribute('aria-invalid', 'true');
      if (!firstInvalidEl) firstInvalidEl = inputEl;
    }
  });
  if (firstInvalidEl && typeof firstInvalidEl.focus === 'function') {
    firstInvalidEl.focus();
  }
}

/* =====================================================================
   CROP CLIMATE SUITABILITY SCREENING — v17
   All numerical values sourced from FAO EcoCrop
   (https://ecocrop.apps.fao.org), accessed 2026-09-02.
   Temperature label "Temperat. requir." in EcoCrop does not carry an
   explicit temporal basis (annual mean, growing-season mean, etc.),
   so temperature comparison is reference-only for all crops.
   ===================================================================== */

/* ── Verified crop climate reference library ─────────────────────────
   Fields present only where authoritative values exist.
   Absent thresholds use null; no values are inferred from prose.
   ──────────────────────────────────────────────────────────────────── */
const CROP_CLIMATE_REFERENCE_LIBRARY = {

  commonWheat: {
    commonName:     'Common wheat',
    scientificName: 'Triticum aestivum',
    source: {
      id:          'FAO-ECOCROP-2114',
      institution: 'Food and Agriculture Organization of the United Nations (FAO)',
      dataset:     'EcoCrop Database',
      recordId:    '2114',
      url:         'https://ecocrop.apps.fao.org/ecocrop/srv/en/dataSheet?id=2114',
      accessed:    '2026-09-02',
      notes:       'Species-level record. Temperature label is "Temperat. requir." without explicit temporal basis; temperature comparison is reference-only.',
    },
    rainfallAnnual: {
      optimalMin:    750,
      optimalMax:    900,
      absoluteMin:   300,
      absoluteMax:   1600,
      unit:          'mm/year',
      sourceLabel:   'Rainfall (annual)',
      temporalBasis: 'annual',
      comparable:    true,
    },
    temperature: {
      optimalMin:       15,
      optimalMax:       23,
      absoluteMin:      5,
      absoluteMax:      27,
      unit:             '\xb0C',
      sourceLabel:      'Temperat. requir.',
      temporalBasis:    null,
      comparable:       false,
      nonComparisonReason: 'Direct comparison not calculated because the temporal definition of the published temperature range is not sufficiently specific for comparison with the selected NASA POWER indicator.',
    },
  },

  maize: {
    commonName:     'Maize',
    scientificName: 'Zea mays',
    source: {
      id:          'FAO-ECOCROP-2175',
      institution: 'Food and Agriculture Organization of the United Nations (FAO)',
      dataset:     'EcoCrop Database',
      recordId:    '2175',
      url:         'https://ecocrop.apps.fao.org/ecocrop/srv/en/dataSheet?id=2175',
      accessed:    '2026-09-02',
      notes:       'Species-level record (Zea mays). Temperature label has no explicit temporal basis; comparison is reference-only.',
    },
    rainfallAnnual: {
      optimalMin:    600,
      optimalMax:    1200,
      absoluteMin:   400,
      absoluteMax:   1800,
      unit:          'mm/year',
      sourceLabel:   'Rainfall (annual)',
      temporalBasis: 'annual',
      comparable:    true,
    },
    temperature: {
      optimalMin:       18,
      optimalMax:       33,
      absoluteMin:      10,
      absoluteMax:      47,
      unit:             '\xb0C',
      sourceLabel:      'Temperat. requir.',
      temporalBasis:    null,
      comparable:       false,
      nonComparisonReason: 'Direct comparison not calculated because the temporal definition of the published temperature range is not sufficiently specific for comparison with the selected NASA POWER indicator.',
    },
  },

  sunflower: {
    commonName:     'Sunflower',
    scientificName: 'Helianthus annuus',
    source: {
      id:          'FAO-ECOCROP-1191',
      institution: 'Food and Agriculture Organization of the United Nations (FAO)',
      dataset:     'EcoCrop Database',
      recordId:    '1191',
      url:         'https://ecocrop.apps.fao.org/ecocrop/srv/en/dataSheet?id=1191',
      accessed:    '2026-09-02',
      notes:       'Species-level record. Temperature label has no explicit temporal basis; comparison is reference-only.',
    },
    rainfallAnnual: {
      optimalMin:    600,
      optimalMax:    1000,
      absoluteMin:   300,
      absoluteMax:   1600,
      unit:          'mm/year',
      sourceLabel:   'Rainfall (annual)',
      temporalBasis: 'annual',
      comparable:    true,
    },
    temperature: {
      optimalMin:       17,
      optimalMax:       34,
      absoluteMin:      5,
      absoluteMax:      45,
      unit:             '\xb0C',
      sourceLabel:      'Temperat. requir.',
      temporalBasis:    null,
      comparable:       false,
      nonComparisonReason: 'Direct comparison not calculated because the temporal definition of the published temperature range is not sufficiently specific for comparison with the selected NASA POWER indicator.',
    },
  },

  barley: {
    commonName:     'Barley',
    scientificName: 'Hordeum vulgare',
    source: {
      id:          'FAO-ECOCROP-1232',
      institution: 'Food and Agriculture Organization of the United Nations (FAO)',
      dataset:     'EcoCrop Database',
      recordId:    '1232',
      url:         'https://ecocrop.apps.fao.org/ecocrop/srv/en/dataSheet?id=1232',
      accessed:    '2026-09-02',
      notes:       'Species-level record. Temperature label has no explicit temporal basis; comparison is reference-only.',
    },
    rainfallAnnual: {
      optimalMin:    500,
      optimalMax:    1000,
      absoluteMin:   200,
      absoluteMax:   2000,
      unit:          'mm/year',
      sourceLabel:   'Rainfall (annual)',
      temporalBasis: 'annual',
      comparable:    true,
    },
    temperature: {
      optimalMin:       15,
      optimalMax:       20,
      absoluteMin:      2,
      absoluteMax:      40,
      unit:             '\xb0C',
      sourceLabel:      'Temperat. requir.',
      temporalBasis:    null,
      comparable:       false,
      nonComparisonReason: 'Direct comparison not calculated because the temporal definition of the published temperature range is not sufficiently specific for comparison with the selected NASA POWER indicator.',
    },
  },

  soybean: {
    commonName:     'Soybean',
    scientificName: 'Glycine max',
    source: {
      id:          'FAO-ECOCROP-1150',
      institution: 'Food and Agriculture Organization of the United Nations (FAO)',
      dataset:     'EcoCrop Database',
      recordId:    '1150',
      url:         'https://ecocrop.apps.fao.org/ecocrop/srv/en/dataSheet?id=1150',
      accessed:    '2026-09-02',
      notes:       'Species-level record. Temperature label has no explicit temporal basis; comparison is reference-only.',
    },
    rainfallAnnual: {
      optimalMin:    600,
      optimalMax:    1500,
      absoluteMin:   450,
      absoluteMax:   1800,
      unit:          'mm/year',
      sourceLabel:   'Rainfall (annual)',
      temporalBasis: 'annual',
      comparable:    true,
    },
    temperature: {
      optimalMin:       20,
      optimalMax:       33,
      absoluteMin:      10,
      absoluteMax:      38,
      unit:             '\xb0C',
      sourceLabel:      'Temperat. requir.',
      temporalBasis:    null,
      comparable:       false,
      nonComparisonReason: 'Direct comparison not calculated because the temporal definition of the published temperature range is not sufficiently specific for comparison with the selected NASA POWER indicator.',
    },
  },

  /* Architecture placeholder — olive and grapevine can be added here
     when an authoritative EcoCrop or equivalent record is verified.
     No numerical values are stored until verified. */
};

/* ── validateCropReferenceRecord ─────────────────────────────────────
   Returns { valid: true } or { valid: false, errors: [...] }.
   A record must have: commonName, scientificName, source.url,
   source.recordId, finite rainfallAnnual values with optMin ≤ optMax
   within absMin ≤ absMax. Temperature is optional (may be reference-only).
   ──────────────────────────────────────────────────────────────────── */
function validateCropReferenceRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object') {
    return { valid: false, errors: ['Record is not an object'] };
  }
  if (!record.commonName || typeof record.commonName !== 'string' || record.commonName.trim() === '') {
    errors.push('Missing or blank commonName');
  }
  if (!record.scientificName || typeof record.scientificName !== 'string' || record.scientificName.trim() === '') {
    errors.push('Missing or blank scientificName');
  }
  if (!record.source || typeof record.source !== 'object') {
    errors.push('Missing source object');
  } else {
    if (!record.source.url    || typeof record.source.url    !== 'string' || record.source.url.trim() === '') {
      errors.push('Missing source.url');
    }
    if (!record.source.recordId || typeof record.source.recordId !== 'string' || record.source.recordId.trim() === '') {
      errors.push('Missing source.recordId');
    }
  }
  const rf = record.rainfallAnnual;
  if (!rf || typeof rf !== 'object') {
    errors.push('Missing rainfallAnnual object');
  } else {
    const fields = ['optimalMin', 'optimalMax', 'absoluteMin', 'absoluteMax'];
    for (const f of fields) {
      if (rf[f] !== null && (typeof rf[f] !== 'number' || !Number.isFinite(rf[f]))) {
        errors.push(`rainfallAnnual.${f} is not finite (use null for unavailable)`);
      }
    }
    const allFinite = fields.every(f => typeof rf[f] === 'number' && Number.isFinite(rf[f]));
    if (allFinite) {
      if (rf.optimalMin  > rf.optimalMax)   errors.push('rainfallAnnual optimal range is reversed (min > max)');
      if (rf.absoluteMin > rf.absoluteMax)  errors.push('rainfallAnnual absolute range is reversed (min > max)');
      if (rf.optimalMin  < rf.absoluteMin)  errors.push('rainfallAnnual optimal range is outside absolute range');
      if (rf.optimalMax  > rf.absoluteMax)  errors.push('rainfallAnnual optimal range is outside absolute range');
    }
  }
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/* ── getAvailableCropReferences ──────────────────────────────────────
   Returns an array of { key, commonName, scientificName } for all
   records that pass validateCropReferenceRecord.
   Unverified or invalid records are silently excluded.
   ──────────────────────────────────────────────────────────────────── */
function getAvailableCropReferences() {
  return Object.entries(CROP_CLIMATE_REFERENCE_LIBRARY)
    .filter(function(entry) {
      return validateCropReferenceRecord(entry[1]).valid;
    })
    .map(function(entry) {
      return { key: entry[0], commonName: entry[1].commonName, scientificName: entry[1].scientificName };
    });
}

/* ── buildAnnualPrecipScreeningRequest ───────────────────────────────
   Wraps buildAnnualPrecipPowerRequest for calendar-year (Jan 1–Dec 31)
   windows across the 1991–2020 reference period.
   URL uses parameters=PRECTOTCORR ONLY — no T2M, no RH2M.
   Returns the same structure as buildHistoricalPowerRequest, or null on
   invalid coordinates.
   ──────────────────────────────────────────────────────────────────── */
function buildAnnualPrecipScreeningRequest(lat, lon) {
  return buildAnnualPrecipPowerRequest(lat, lon);
}

/* ── buildAnnualPrecipCacheKey ───────────────────────────────────────
   Returns a unique cache key for annual precipitation screening.
   Includes: method version, 'annualprecip' segment (distinct from
   'hist' used by buildHistoricalCacheKey), PRECTOTCORR parameter
   literal, exact coordinates (not rounded), reference period, and
   coverage rule version (cov1.0 = 100% daily coverage required).
   Does NOT share prefix with buildHistoricalCacheKey.
   ──────────────────────────────────────────────────────────────────── */
function buildAnnualPrecipCacheKey(lat, lon) {
  return `${HISTORICAL_METHOD_VERSION}|annualprecip|PRECTOTCORR|${lat}|${lon}|19910101-20201231|cov1.0`;
}

/* ── compareAnnualRainfallToCropReference ────────────────────────────
   Compares a mean-annual-precipitation value (mm) to the crop's
   published rainfallAnnual range using the existing compareToReferenceRange.
   Returns the same status codes: 'within-optimal', 'within-absolute',
   'outside-absolute', 'unavailable'.
   ──────────────────────────────────────────────────────────────────── */
function compareAnnualRainfallToCropReference(annualMeanMm, rainfallRef) {
  if (typeof annualMeanMm !== 'number' || !Number.isFinite(annualMeanMm)) {
    return { status: 'unavailable', reason: 'Annual mean precipitation is not a finite number' };
  }
  if (!rainfallRef || !rainfallRef.comparable) {
    return { status: 'unavailable', reason: 'Rainfall reference is not marked comparable' };
  }
  return compareToReferenceRange(
    annualMeanMm,
    rainfallRef.optimalMin, rainfallRef.optimalMax,
    rainfallRef.absoluteMin, rainfallRef.absoluteMax
  );
}

/* ── buildCropFactorResults ──────────────────────────────────────────
   Builds the factor-level result table for one crop–location combination.
   annualPrecipMean: number (mm) or null — mean of qualifying annual totals.
   qualifyingYears:  number — count of qualifying annual windows.
   cropRef:          a record from CROP_CLIMATE_REFERENCE_LIBRARY.
   Returns an object with rainfall, temperature, humidity, soil factors.
   ──────────────────────────────────────────────────────────────────── */
function buildCropFactorResults(annualPrecipMean, qualifyingYears, cropRef) {
  /* ── Rainfall factor ── */
  var rainfallComparison = compareAnnualRainfallToCropReference(
    annualPrecipMean, cropRef.rainfallAnnual
  );
  var rainfallStatusLabel;
  if (rainfallComparison.status === 'within-optimal') {
    rainfallStatusLabel = 'Within published optimal ecological range';
  } else if (rainfallComparison.status === 'within-absolute') {
    rainfallStatusLabel = 'Within published absolute ecological range, outside optimal';
  } else if (rainfallComparison.status === 'outside-absolute') {
    rainfallStatusLabel = 'Outside published absolute ecological range';
  } else {
    rainfallStatusLabel = 'Insufficient data';
  }

  /* ── Temperature factor (always reference-only for all current crops) ── */
  var tempFactor = {
    status: 'reference-only',
    statusLabel: 'Reference displayed — direct comparison unavailable',
    publishedRange: cropRef.temperature || null,
    reason: (cropRef.temperature && cropRef.temperature.nonComparisonReason) ||
      'Direct comparison not calculated because the temporal definition of the published temperature range is not sufficiently specific for comparison with the selected NASA POWER indicator.',
  };

  return {
    rainfall: {
      status:           rainfallComparison.status,
      statusLabel:      rainfallStatusLabel,
      locationValueMm:  annualPrecipMean,
      qualifyingYears:  qualifyingYears,
      reference:        cropRef.rainfallAnnual,
      periodDescription: '1991–2020 NASA POWER annual PRECTOTCORR (mean of qualifying calendar-year totals; Feb 29 excluded from coverage and totals per established AgroPredict method)',
    },
    temperature: tempFactor,
    humidity: {
      status:      'not-assessed',
      statusLabel: 'Not assessed',
      reason:      'No compatible crop-specific RH2M reference integrated.',
    },
    soil: {
      status:      'not-assessed',
      statusLabel: 'Not assessed',
      reason:      'Soil data not integrated.',
    },
    /* Guard: no overall score is produced */
    overallScore:            undefined,
    percentageSuitability:   undefined,
  };
}

/* ── buildCropScreeningSummary ───────────────────────────────────────
   Generates a neutral, deterministic factual summary from factor results.
   No recommendation language. No probability claims. No overall score.
   ──────────────────────────────────────────────────────────────────── */
function buildCropScreeningSummary(factorResults) {
  var parts = [];
  var rf = factorResults.rainfall;

  if (rf.status === 'within-optimal') {
    parts.push(
      'Annual precipitation (' + (rf.locationValueMm !== null ? rf.locationValueMm.toFixed(0) : '—') + ' mm, mean of ' + rf.qualifyingYears + ' qualifying years, 1991–2020) is within the crop’s published optimal ecological range.'
    );
  } else if (rf.status === 'within-absolute') {
    parts.push(
      'Annual precipitation (' + (rf.locationValueMm !== null ? rf.locationValueMm.toFixed(0) : '—') + ' mm, mean of ' + rf.qualifyingYears + ' qualifying years, 1991–2020) is within the crop’s published absolute ecological range but outside its published optimal range.'
    );
  } else if (rf.status === 'outside-absolute') {
    parts.push(
      'Annual precipitation (' + (rf.locationValueMm !== null ? rf.locationValueMm.toFixed(0) : '—') + ' mm, mean of ' + rf.qualifyingYears + ' qualifying years, 1991–2020) is outside the crop’s published absolute ecological range.'
    );
  } else {
    parts.push(
      'Annual precipitation comparison is unavailable because fewer than ' + HIST_MIN_QUALIFYING_WINDOWS + ' qualifying annual windows were found in the 1991–2020 reference.'
    );
  }

  parts.push(
    'Temperature is shown as reference-only because the source temporal basis is not sufficiently specific for comparison with the selected NASA POWER indicator.'
  );
  parts.push('Soil and humidity requirements are not assessed.');

  return parts.join(' ');
}

/* ── validateCropScreeningInput ─────────────────────────────────────
   Validates the crop key and coordinates before initiating a screening.
   Returns { valid: true, cropKey, lat, lon } or { valid: false, errors }.
   ──────────────────────────────────────────────────────────────────── */
function validateCropScreeningInput(cropKey, lat, lon) {
  var errors = [];
  var available = getAvailableCropReferences().map(function(c) { return c.key; });

  if (!cropKey || typeof cropKey !== 'string' || cropKey.trim() === '') {
    errors.push({ field: 'crop', message: 'Select a crop before running screening.' });
  } else if (!available.includes(cropKey)) {
    errors.push({ field: 'crop', message: 'Selected crop is not in the verified reference library.' });
  }

  var coordCheck = validateCoordinates(
    (lat === null || lat === undefined) ? '' : String(lat),
    (lon === null || lon === undefined) ? '' : String(lon)
  );
  if (!coordCheck.valid) {
    errors.push({ field: coordCheck.field, message: coordCheck.message });
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, cropKey: cropKey.trim(), lat: coordCheck.lat, lon: coordCheck.lon };
}


// ═════════════════════════════════════════════════════════════════════
// v18 ADDITIONS
// ═════════════════════════════════════════════════════════════════════

// ── validateAnalyzedLocation ──────────────────────────────────────────
function validateAnalyzedLocation(location) {
  if (location === null || location === undefined || typeof location !== 'object' || Array.isArray(location)) {
    return { valid: false, error: 'location must be a non-null plain object' };
  }
  var lat   = location.lat;
  var lon   = location.lon;
  var label = location.label;
  if (typeof lat !== 'number') return { valid: false, error: 'location.lat must be a number' };
  if (!Number.isFinite(lat))  return { valid: false, error: 'location.lat must be finite (not NaN or Infinity)' };
  if (lat < -90 || lat > 90)  return { valid: false, error: 'location.lat must be in the range -90 to 90' };
  if (typeof lon !== 'number') return { valid: false, error: 'location.lon must be a number' };
  if (!Number.isFinite(lon))  return { valid: false, error: 'location.lon must be finite (not NaN or Infinity)' };
  if (lon < -180 || lon > 180) return { valid: false, error: 'location.lon must be in the range -180 to 180' };
  if (typeof label !== 'string') return { valid: false, error: 'location.label must be a string' };
  if (label.trim() === '')       return { valid: false, error: 'location.label must not be blank or whitespace-only' };
  if (label.length > 200)        return { valid: false, error: 'location.label must not exceed 200 characters' };
  return { valid: true };
}

// ── COUNTRY_REGION_REFERENCE_DATA ─────────────────────────────────────
// Single authoritative geographic dataset for all supported countries.
// referencePointLabel       : name of the city/town used as representative point.
// referencePointBasis       : why this point was chosen (administrative capital).
// coordinateSource          : geographic data source used to verify coordinates.
// coordinateSourceFeatureId : numeric GeoNames feature ID.
// coordinateSourceUrl       : direct GeoNames feature page URL.
// The regional list for Ukraine follows the internationally recognized
// administrative territory of Ukraine. Location labels do not describe
// current territorial control. Climate values are NASA POWER modelled
// grid-cell data for the selected representative point.
// Administrative-region scope follows Articles 133 and 134 of the
// Constitution of Ukraine, adopted on 28 June 1996. The agricultural
// selector includes 24 oblasts and the Autonomous Republic of Crimea.
// Kyiv and Sevastopol are excluded because they are special-status
// cities rather than agricultural oblast-level selector entries.
const COUNTRY_REGION_REFERENCE_DATA = {
  ukraine: {
    label: '\u{1F1FA}\u{1F1E6} Ukraine',
    flag:  '\u{1F1FA}\u{1F1E6}',
    phase: 'Pilot',
    phaseBg:    'var(--h-green-bg)',
    phaseColor: 'var(--h-green-text)',
    description: "Ukraine is the founder's home country and the primary research focus. Agriculture is a central part of the national economy.",
    whyIncluded: "Founder's home country. Initial motivation for the project came from observing limited accessible tools for data-driven crop planning.",
    agriContext: 'Key agricultural country in Eastern Europe. Agricultural context details (soil types, export figures, production statistics) are not yet sourced from a verified primary dataset — see SRC-003 and SRC-007.',
    dataStatus:  'Climate data: NASA POWER (live). Soil data: not yet integrated. Yield data: not yet integrated.',
    methodologyNote: 'The regional list follows the internationally recognized administrative territory of Ukraine. Location labels do not describe current territorial control. Climate values are NASA POWER modelled grid-cell data for the selected representative point.',
    regions: [
      { name: 'Vinnytsia Oblast',           lat: 49.232228,   lon: 28.46871,    referencePointLabel: 'Vinnytsia',        referencePointBasis: 'City centre of the regional administrative capital (Vinnytsia)',                            coordinateSource: 'GeoNames', coordinateSourceFeatureId: 689558,  coordinateSourceUrl: 'https://www.geonames.org/689558/vinnytsya.html' },
      { name: 'Volyn Oblast',               lat: 50.7578433,  lon: 25.3502386,  referencePointLabel: 'Lutsk',            referencePointBasis: 'City centre of the regional administrative capital (Lutsk)',                                coordinateSource: 'GeoNames', coordinateSourceFeatureId: 702569,  coordinateSourceUrl: 'https://www.geonames.org/702569/lutsk.html' },
      { name: 'Dnipropetrovsk Oblast',      lat: 48.4666435,  lon: 35.04066,    referencePointLabel: 'Dnipro',           referencePointBasis: 'City centre of the regional administrative capital (Dnipro)',                               coordinateSource: 'GeoNames', coordinateSourceFeatureId: 709930,  coordinateSourceUrl: 'https://www.geonames.org/709930/dnipro.html' },
      { name: 'Donetsk Oblast',             lat: 48.0229983,  lon: 37.80223846, referencePointLabel: 'Donetsk',          referencePointBasis: 'City centre of the formally designated regional administrative capital (Donetsk)',            coordinateSource: 'GeoNames', coordinateSourceFeatureId: 709717,  coordinateSourceUrl: 'https://www.geonames.org/709717/donetsk.html' },
      { name: 'Zhytomyr Oblast',            lat: 50.2623458,  lon: 28.6791321,  referencePointLabel: 'Zhytomyr',         referencePointBasis: 'City centre of the regional administrative capital (Zhytomyr)',                             coordinateSource: 'GeoNames', coordinateSourceFeatureId: 686967,  coordinateSourceUrl: 'https://www.geonames.org/686967/zhytomyr.html' },
      { name: 'Zakarpattia Oblast',         lat: 48.624222,   lon: 22.2947,     referencePointLabel: 'Uzhhorod',         referencePointBasis: 'City centre of the regional administrative capital (Uzhhorod)',                             coordinateSource: 'GeoNames', coordinateSourceFeatureId: 690548,  coordinateSourceUrl: 'https://www.geonames.org/690548/uzhhorod.html' },
      { name: 'Zaporizhzhia Oblast',        lat: 47.851673,   lon: 35.117140,   referencePointLabel: 'Zaporizhzhia',     referencePointBasis: 'City centre of the regional administrative capital (Zaporizhzhia)',                          coordinateSource: 'GeoNames', coordinateSourceFeatureId: 687700,  coordinateSourceUrl: 'https://www.geonames.org/687700/zaporizhzhya.html' },
      { name: 'Ivano-Frankivsk Oblast',     lat: 48.9231,     lon: 24.7125,     referencePointLabel: 'Ivano-Frankivsk',  referencePointBasis: 'City centre of the regional administrative capital (Ivano-Frankivsk)',                       coordinateSource: 'GeoNames', coordinateSourceFeatureId: 707471,  coordinateSourceUrl: 'https://www.geonames.org/707471/ivano-frankivsk.html' },
      { name: 'Kyiv Oblast',                lat: 50.454662,   lon: 30.523796,   referencePointLabel: 'Kyiv',             referencePointBasis: 'City centre of Kyiv, designated administrative centre for Kyiv Oblast',                      coordinateSource: 'GeoNames', coordinateSourceFeatureId: 703448,  coordinateSourceUrl: 'https://www.geonames.org/703448/kyiv.html' },
      { name: 'Kirovohrad Oblast',          lat: 48.5083,     lon: 32.2662,     referencePointLabel: 'Kropyvnytskyi',    referencePointBasis: 'City centre of the regional administrative capital (Kropyvnytskyi)',                         coordinateSource: 'GeoNames', coordinateSourceFeatureId: 705812,  coordinateSourceUrl: 'https://www.geonames.org/705812/kropyvnytskyi.html' },
      { name: 'Luhansk Oblast',             lat: 48.5681405,  lon: 39.3055335,  referencePointLabel: 'Luhansk',          referencePointBasis: 'City centre of the formally designated regional administrative capital (Luhansk)',            coordinateSource: 'GeoNames', coordinateSourceFeatureId: 702658,  coordinateSourceUrl: 'https://www.geonames.org/702658/luhansk.html' },
      { name: 'Lviv Oblast',                lat: 49.8382592,  lon: 24.0232372,  referencePointLabel: 'Lviv',             referencePointBasis: 'City centre of the regional administrative capital (Lviv)',                                  coordinateSource: 'GeoNames', coordinateSourceFeatureId: 702550,  coordinateSourceUrl: 'https://www.geonames.org/702550/lviv.html' },
      { name: 'Mykolaiv Oblast',            lat: 46.9762531,  lon: 31.99296,    referencePointLabel: 'Mykolaiv',         referencePointBasis: 'City centre of the regional administrative capital (Mykolaiv)',                              coordinateSource: 'GeoNames', coordinateSourceFeatureId: 700569,  coordinateSourceUrl: 'https://www.geonames.org/700569/mykolayiv.html' },
      { name: 'Odesa Oblast',               lat: 46.485723,   lon: 30.74383,    referencePointLabel: 'Odesa',            referencePointBasis: 'City centre of the regional administrative capital (Odesa)',                                 coordinateSource: 'GeoNames', coordinateSourceFeatureId: 698740,  coordinateSourceUrl: 'https://www.geonames.org/698740/odesa.html' },
      { name: 'Poltava Oblast',             lat: 49.5892534,  lon: 34.55367,    referencePointLabel: 'Poltava',          referencePointBasis: 'City centre of the regional administrative capital (Poltava)',                               coordinateSource: 'GeoNames', coordinateSourceFeatureId: 696643,  coordinateSourceUrl: 'https://www.geonames.org/696643/poltava.html' },
      { name: 'Rivne Oblast',               lat: 50.6203613,  lon: 26.2369545,  referencePointLabel: 'Rivne',            referencePointBasis: 'City centre of the regional administrative capital (Rivne)',                                 coordinateSource: 'GeoNames', coordinateSourceFeatureId: 695594,  coordinateSourceUrl: 'https://www.geonames.org/695594/rivne.html' },
      { name: 'Sumy Oblast',                lat: 50.9174059,  lon: 34.7990649,  referencePointLabel: 'Sumy',             referencePointBasis: 'City centre of the regional administrative capital (Sumy)',                                  coordinateSource: 'GeoNames', coordinateSourceFeatureId: 692194,  coordinateSourceUrl: 'https://www.geonames.org/692194/sumy.html' },
      { name: 'Ternopil Oblast',            lat: 49.554042,   lon: 25.590670,   referencePointLabel: 'Ternopil',         referencePointBasis: 'City centre of the regional administrative capital (Ternopil)',                              coordinateSource: 'GeoNames', coordinateSourceFeatureId: 691650,  coordinateSourceUrl: 'https://www.geonames.org/691650/ternopil.html' },
      { name: 'Kharkiv Oblast',             lat: 49.9817735,  lon: 36.2547480,  referencePointLabel: 'Kharkiv',          referencePointBasis: 'City centre of the regional administrative capital (Kharkiv)',                               coordinateSource: 'GeoNames', coordinateSourceFeatureId: 706483,  coordinateSourceUrl: 'https://www.geonames.org/706483/kharkiv.html' },
      { name: 'Kherson Oblast',             lat: 46.6369,     lon: 32.6145,     referencePointLabel: 'Kherson',          referencePointBasis: 'City centre of the regional administrative capital (Kherson)',                               coordinateSource: 'GeoNames', coordinateSourceFeatureId: 706448,  coordinateSourceUrl: 'https://www.geonames.org/706448/kherson.html' },
      { name: 'Khmelnytskyi Oblast',        lat: 49.4183,     lon: 26.9794,     referencePointLabel: 'Khmelnytskyi',     referencePointBasis: 'City centre of the regional administrative capital (Khmelnytskyi)',                          coordinateSource: 'GeoNames', coordinateSourceFeatureId: 706369,  coordinateSourceUrl: 'https://www.geonames.org/706369/khmelnytskyi.html' },
      { name: 'Cherkasy Oblast',            lat: 49.4445,     lon: 32.0574,     referencePointLabel: 'Cherkasy',         referencePointBasis: 'City centre of the regional administrative capital (Cherkasy)',                              coordinateSource: 'GeoNames', coordinateSourceFeatureId: 710791,  coordinateSourceUrl: 'https://www.geonames.org/710791/cherkasy.html' },
      { name: 'Chernivtsi Oblast',          lat: 48.290452,   lon: 25.93241,    referencePointLabel: 'Chernivtsi',       referencePointBasis: 'City centre of the regional administrative capital (Chernivtsi)',                            coordinateSource: 'GeoNames', coordinateSourceFeatureId: 710719,  coordinateSourceUrl: 'https://www.geonames.org/710719/chernivtsi.html' },
      { name: 'Chernihiv Oblast',           lat: 51.5054,     lon: 31.2866,     referencePointLabel: 'Chernihiv',        referencePointBasis: 'City centre of the regional administrative capital (Chernihiv)',                             coordinateSource: 'GeoNames', coordinateSourceFeatureId: 710735,  coordinateSourceUrl: 'https://www.geonames.org/710735/chernihiv.html' },
      { name: 'Autonomous Republic of Crimea · Ukraine', lat: 44.957186, lon: 34.110787, referencePointLabel: 'Simferopol', referencePointBasis: 'City centre of the formally designated administrative capital of the Autonomous Republic of Crimea (Simferopol)', coordinateSource: 'GeoNames', coordinateSourceFeatureId: 693805, coordinateSourceUrl: 'https://www.geonames.org/693805/simferopol.html' },
    ],
  },
  slovakia: {
    label: '\u{1F1F8}\u{1F1F0} Slovakia',
    flag:  '\u{1F1F8}\u{1F1F0}',
    phase: 'Validation target',
    phaseBg:    'var(--h-mod-bg)',
    phaseColor: 'var(--h-mod-text)',
    description: "Slovakia is included because the founder studied at university there for three years. Central European farming under EU agricultural policy.",
    whyIncluded: "Founder studied at university in Slovakia for three years. EU data environment shared with Portugal.",
    agriContext: 'EU member state subject to the Common Agricultural Policy. Detailed agricultural statistics (land use, farm counts, crop mix) not yet extracted from verified sources — see SRC-004 and SRC-006.',
    dataStatus:  'Climate data: NASA POWER (live). Soil data (VÚPOP/NPPC): not yet integrated. Eurostat farm census: not yet extracted.',
    regions: [
      { name: 'Prešov Region',          lat: 48.9992326,  lon: 21.2355044, referencePointLabel: 'Prešov',          referencePointBasis: 'City centre of the regional administrative capital (Prešov)',          coordinateSource: 'GeoNames', coordinateSourceFeatureId: 723819,  coordinateSourceUrl: 'https://www.geonames.org/723819/presov.html' },
      { name: 'Košice Region',          lat: 48.7144,     lon: 21.2580,    referencePointLabel: 'Košice',          referencePointBasis: 'City centre of the regional administrative capital (Košice)',          coordinateSource: 'GeoNames', coordinateSourceFeatureId: 724443,  coordinateSourceUrl: 'https://www.geonames.org/724443/kosice.html' },
      { name: 'Nitra Region',           lat: 48.307632,   lon: 18.0845,    referencePointLabel: 'Nitra',           referencePointBasis: 'City centre of the regional administrative capital (Nitra)',           coordinateSource: 'GeoNames', coordinateSourceFeatureId: 3058531, coordinateSourceUrl: 'https://www.geonames.org/3058531/nitra.html' },
      { name: 'Trnava Region',          lat: 48.37773,    lon: 17.58603,   referencePointLabel: 'Trnava',          referencePointBasis: 'City centre of the regional administrative capital (Trnava)',          coordinateSource: 'GeoNames', coordinateSourceFeatureId: 3057124, coordinateSourceUrl: 'https://www.geonames.org/3057124/trnava.html' },
      { name: 'Banská Bystrica Region', lat: 48.7394719,  lon: 19.14932,   referencePointLabel: 'Banská Bystrica', referencePointBasis: 'City centre of the regional administrative capital (Banská Bystrica)', coordinateSource: 'GeoNames', coordinateSourceFeatureId: 3061186, coordinateSourceUrl: 'https://www.geonames.org/3061186/banska-bystrica.html' },
    ],
  },
  portugal: {
    label: '\u{1F1F5}\u{1F1F9} Portugal',
    flag:  '\u{1F1F5}\u{1F1F9}',
    phase: 'Validation target',
    phaseBg:    'var(--h-mod-bg)',
    phaseColor: 'var(--h-mod-text)',
    description: "Portugal is included through the founder's exchange semester and participation in agricultural entrepreneurship research and volunteering.",
    whyIncluded: "Founder studied in Portugal during an exchange semester and participated in research and volunteer experiences connected with agricultural entrepreneurship.",
    agriContext: 'EU member state. Detailed agricultural statistics (land use, farm counts, dominant crops by region) not yet extracted from verified sources — see SRC-005 and SRC-006.',
    dataStatus:  'Climate data: NASA POWER (live). Soil data (SNISolos/DGADR): not yet integrated. Eurostat farm census: not yet extracted.',
    regions: [
      { name: 'Norte',                lat: 41.55140373, lon:  -8.4231119, referencePointLabel: 'Braga',    referencePointBasis: 'City centre of Braga, principal administrative city of the Norte region', coordinateSource: 'GeoNames', coordinateSourceFeatureId: 2742032, coordinateSourceUrl: 'https://www.geonames.org/2742032/braga.html' },
      { name: 'Centro',               lat: 40.2068639,  lon:  -8.4199593, referencePointLabel: 'Coimbra',  referencePointBasis: 'City centre of Coimbra, principal administrative city of the Centro region', coordinateSource: 'GeoNames', coordinateSourceFeatureId: 2740637, coordinateSourceUrl: 'https://www.geonames.org/2740637/coimbra.html' },
      { name: 'Lisboa e Vale do Tejo', lat: 38.72508933, lon:  -9.14979803, referencePointLabel: 'Lisboa',   referencePointBasis: 'City centre of Lisbon, administrative capital of the region', coordinateSource: 'GeoNames', coordinateSourceFeatureId: 2267057, coordinateSourceUrl: 'https://www.geonames.org/2267057/lisbon.html' },
      { name: 'Alentejo',             lat: 38.56587127, lon:  -7.90405049, referencePointLabel: 'Évora',    referencePointBasis: 'City centre of Évora, administrative centre of the Alentejo region', coordinateSource: 'GeoNames', coordinateSourceFeatureId: 2268406, coordinateSourceUrl: 'https://www.geonames.org/2268406/evora.html' },
      { name: 'Algarve',              lat: 37.01869,     lon:  -7.92716,    referencePointLabel: 'Faro',     referencePointBasis: 'City centre of Faro, administrative capital of the Algarve region', coordinateSource: 'GeoNames', coordinateSourceFeatureId: 2268339, coordinateSourceUrl: 'https://www.geonames.org/2268339/faro.html' },
    ],
  },
};

// ── validateRegionReferenceRecord ─────────────────────────────────────
function validateRegionReferenceRecord(record) {
  var errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, errors: ['record must be a non-null plain object'] };
  }
  if (typeof record.name !== 'string' || record.name.trim() === '') {
    errors.push('missing or blank name');
  }
  if (typeof record.lat !== 'number') {
    errors.push('lat must be a number');
  } else if (!Number.isFinite(record.lat)) {
    errors.push('lat must be finite (not NaN or Infinity)');
  } else if (record.lat < -90 || record.lat > 90) {
    errors.push('lat out of range (-90 to 90)');
  }
  if (typeof record.lon !== 'number') {
    errors.push('lon must be a number');
  } else if (!Number.isFinite(record.lon)) {
    errors.push('lon must be finite (not NaN or Infinity)');
  } else if (record.lon < -180 || record.lon > 180) {
    errors.push('lon out of range (-180 to 180)');
  }
  if (typeof record.referencePointLabel !== 'string' || record.referencePointLabel.trim() === '') {
    errors.push('missing or blank referencePointLabel');
  }
  if (typeof record.referencePointBasis !== 'string' || record.referencePointBasis.trim() === '') {
    errors.push('missing or blank referencePointBasis');
  }
  if (typeof record.coordinateSource !== 'string' || record.coordinateSource.trim() === '') {
    errors.push('missing or blank coordinateSource');
  }
  if (typeof record.coordinateSourceFeatureId !== 'number' ||
      !Number.isFinite(record.coordinateSourceFeatureId) ||
      !Number.isInteger(record.coordinateSourceFeatureId) ||
      record.coordinateSourceFeatureId <= 0) {
    errors.push('coordinateSourceFeatureId must be a positive integer');
  }
  if (typeof record.coordinateSourceUrl !== 'string' ||
      !record.coordinateSourceUrl.startsWith('https://')) {
    errors.push('coordinateSourceUrl must be a valid HTTPS URL string');
  } else if (
    typeof record.coordinateSourceFeatureId === 'number' &&
    Number.isFinite(record.coordinateSourceFeatureId) &&
    !record.coordinateSourceUrl.includes(String(record.coordinateSourceFeatureId))
  ) {
    errors.push('coordinateSourceUrl must contain the coordinateSourceFeatureId');
  }
  return { valid: errors.length === 0, errors };
}

// ── validateCountryRegionCoverage ─────────────────────────────────────
function validateCountryRegionCoverage(countryKey, expectedNames) {
  var errors = [];
  var country = COUNTRY_REGION_REFERENCE_DATA[countryKey];
  if (!country) return { valid: false, errors: ['country key not found: ' + countryKey] };
  var regions = country.regions;
  if (!Array.isArray(regions)) return { valid: false, errors: ['regions must be an array'] };

  var actualNames = regions.map(function(r) { return r.name; });

  // Duplicate check
  var nameCount = {};
  actualNames.forEach(function(n) { nameCount[n] = (nameCount[n] || 0) + 1; });
  Object.keys(nameCount).forEach(function(n) {
    if (nameCount[n] > 1) errors.push('duplicate region name: ' + n);
  });

  // Missing expected
  var actualSet = {};
  actualNames.forEach(function(n) { actualSet[n] = true; });
  expectedNames.forEach(function(n) {
    if (!actualSet[n]) errors.push('missing expected region: ' + n);
  });

  // Unexpected extra
  var expectedSet = {};
  expectedNames.forEach(function(n) { expectedSet[n] = true; });
  actualNames.forEach(function(n) {
    if (!expectedSet[n]) errors.push('unexpected extra region: ' + n);
  });

  // Record-level validation
  regions.forEach(function(r) {
    var result = validateRegionReferenceRecord(r);
    if (!result.valid) {
      result.errors.forEach(function(e) {
        errors.push('region "' + (r && r.name ? r.name : '(unnamed)') + '": ' + e);
      });
    }
  });

  return { valid: errors.length === 0, errors };
}

// ── CropScreeningRequestCoordinator ──────────────────────────────────
class CropScreeningRequestCoordinator {
  constructor() {
    this._requestId        = 0;   // monotonically increasing; never reset to zero
    this._activeGeneration = -1;
    this._activeLat        = null;
    this._activeLon        = null;
    this._activeCropKey    = null;
    this._activeController = null;
    this._activeAbortRef   = null;
  }

  // Abort previous in-flight request (if any), allocate a new ID, capture state.
  // Returns { requestId, controller, abortRef } for the caller to use.
  startRequest(generation, lat, lon, cropKey) {
    if (this._activeController) {
      if (this._activeAbortRef) this._activeAbortRef.value = 'new-request';
      this._activeController.abort();
    }
    const id         = ++this._requestId;   // monotonically increasing
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const abortRef   = { value: null };
    this._activeGeneration = generation;
    this._activeLat        = lat;
    this._activeLon        = lon;
    this._activeCropKey    = cropKey;
    this._activeController = controller;
    this._activeAbortRef   = abortRef;
    return { requestId: id, controller, abortRef };
  }

  // Invalidate by crop change: abort controller, clear refs, increment ID
  // so any in-flight request sees itself as stale on next isStale() check.
  invalidateByCropChange(reason) {
    if (this._activeController) {
      if (this._activeAbortRef) this._activeAbortRef.value = reason || 'crop-change';
      this._activeController.abort();
    }
    this._activeController = null;
    this._activeAbortRef   = null;
    ++this._requestId;    // stale any pending request; still monotonically increasing
  }

  // Returns true if this request is no longer the current one.
  isStale(requestId, generation, lat, lon, cropKey) {
    return requestId   !== this._requestId        ||
           generation  !== this._activeGeneration  ||
           lat         !== this._activeLat         ||
           lon         !== this._activeLon         ||
           cropKey     !== this._activeCropKey;
  }

  // Called in finally by the owning request to clear its own controller refs.
  // Identity check prevents a stale request from clearing refs that belong
  // to a newer request.
  clearOwner(requestId) {
    if (requestId === this._requestId) {
      this._activeController = null;
      this._activeAbortRef   = null;
    }
  }
}

// ── runCropScreeningLifecycle ─────────────────────────────────────────
// Injectable-dependency async lifecycle for crop climate screening.
// Does not access the DOM directly. All UI side-effects are delivered
// through callbacks (onLoadingChange, onSuccess, onTimeout, onError).
async function runCropScreeningLifecycle({
  coordinator,       // CropScreeningRequestCoordinator
  locationGeneration, // number — current location generation counter
  lat,               // number — exact latitude
  lon,               // number — exact longitude
  cropKey,           // string — key into CROP_CLIMATE_REFERENCE_LIBRARY
  annualPrecipCache, // Map — shared cache; not cleared here on crop change
  fetchImpl,         // injectable fetch(url, {signal}) → Response
  timeoutMs,         // number — ms before aborting; 0 = no timeout
  setTimeoutImpl,    // injectable setTimeout (default: global setTimeout)
  clearTimeoutImpl,  // injectable clearTimeout (default: global clearTimeout)
  onLoadingChange,   // (isLoading: boolean) => void
  onSuccess,         // ({ factorResults, summaryText, cropRef, cacheKey }) => void
  onTimeout,         // () => void
  onError,           // (message: string) => void
}) {
  const { requestId, controller, abortRef } =
    coordinator.startRequest(locationGeneration, lat, lon, cropKey);

  function isStale() {
    return coordinator.isStale(requestId, locationGeneration, lat, lon, cropKey);
  }

  onLoadingChange(true);

  try {
    const cacheKey = buildAnnualPrecipCacheKey(lat, lon);
    let paramData  = annualPrecipCache.get(cacheKey) || null;

    if (!paramData) {
      const req = buildAnnualPrecipScreeningRequest(lat, lon);
      if (!req) throw new Error('Could not build NASA POWER request for the given coordinates.');

      const fetchResult = await fetchAnnualPrecipitationReference({
        url:              req.url,
        fetchImpl,
        abortController:  controller,
        timeoutMs:        timeoutMs != null ? timeoutMs : 90000,
        abortReasonRef:   abortRef,
        setTimeoutImpl:   setTimeoutImpl   || (typeof setTimeout   !== 'undefined' ? setTimeout   : undefined),
        clearTimeoutImpl: clearTimeoutImpl || (typeof clearTimeout !== 'undefined' ? clearTimeout : undefined),
      });

      if (isStale()) return;
      // Only the non-stale owner populates the cache
      annualPrecipCache.set(cacheKey, fetchResult.parameterData);
      paramData = fetchResult.parameterData;
    }

    if (isStale()) return;

    const windows      = buildHistoricalWindowDefinitions('19910101', '20201231');
    const grouped      = groupDailyValuesByHistoricalWindow(paramData, windows);
    const precipRef    = calculateHistoricalReference(grouped, 'precipByDate', 'sum');
    const annualMean   = precipRef.status === 'ok' ? precipRef.historicalMean : null;
    const qualifyingCount = precipRef.qualifyingCount;

    const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY[cropKey];
    if (!cropRef) throw new Error('Crop not found in reference library: ' + cropKey);

    if (isStale()) return;

    const factorResults = buildCropFactorResults(annualMean, qualifyingCount, cropRef);
    const summaryText   = buildCropScreeningSummary(factorResults);

    if (isStale()) return;

    onSuccess({ factorResults, summaryText, cropRef, cacheKey });

  } catch (err) {
    if (isStale()) return;          // stale catch — must not render anything
    if (err.name === 'AbortError') {
      const reason = (abortRef && abortRef.value) || 'unknown';
      if (reason === 'timeout') {
        onTimeout();
        return;
      }
      return;                        // non-timeout abort — silent return
    }
    onError(err.message || 'Unknown error');
  } finally {
    // Only the owning (non-stale) request resets loading state.
    if (!isStale()) {
      coordinator.clearOwner(requestId);
      onLoadingChange(false);
    }
  }
}

// ── resetCropScreeningUiAfterInvalidation ─────────────────────────────
// Shared helper used by BOTH crop-change and location-change paths.
// Invalidates the active request via the coordinator, resets button state,
// hides stale results, clears the "Use this crop" dataset key and
// transfer disclosure, and clears stale API error messages.
// Does NOT auto-start a new request. All elements are injectable for
// testability — pass null for any element that is not present.
function resetCropScreeningUiAfterInvalidation({
  coordinator,   // CropScreeningRequestCoordinator
  abortReason,   // 'crop-change' or 'location-change'
  screenBtn,     // button element (injectable)
  resultsEl,     // results container element
  useBtnEl,      // "Use this crop" button element
  useDiscEl,     // transfer disclosure element
  errorsEl,      // API errors container element
}) {
  coordinator.invalidateByCropChange(abortReason);
  if (resultsEl)  resultsEl.style.display = 'none';
  if (useBtnEl)   useBtnEl.dataset.cropKey = '';
  if (useDiscEl)  { useDiscEl.style.display = 'none'; useDiscEl.textContent = ''; }
  if (errorsEl)   errorsEl.innerHTML = '';
  if (screenBtn)  { screenBtn.disabled = false; screenBtn.textContent = 'Screen crop'; }
}

// ═════════════════════════════════════════════════════════════════════
// v20 ADDITIONS — Climate Extremes & Risk Flags
// ═════════════════════════════════════════════════════════════════════

/* ── calculateEmpiricalPercentileRank ────────────────────────────────
   Midrank empirical-percentile formula:
     percentile = 100 × (below + 0.5 × equal) / n
   where n = count of valid historical values.
   Valid historical values: finite numbers that are not -999.
   Returns a structured result; does not mutate the input array.
   ──────────────────────────────────────────────────────────────────── */
function calculateEmpiricalPercentileRank(currentValue, historicalValues) {
  if (typeof currentValue !== 'number' || !Number.isFinite(currentValue)) {
    return {
      status: 'unavailable',
      reason: 'currentValue must be a finite number',
      validHistoricalCount: 0,
    };
  }
  if (!Array.isArray(historicalValues)) {
    return {
      status: 'unavailable',
      reason: 'historicalValues must be an array',
      validHistoricalCount: 0,
    };
  }
  const valid = historicalValues.filter(
    v => typeof v === 'number' && Number.isFinite(v) && v !== -999
  );
  if (valid.length === 0) {
    return {
      status: 'unavailable',
      reason: 'No valid historical values remain after filtering',
      validHistoricalCount: 0,
    };
  }
  const n          = valid.length;
  const belowCount = valid.filter(v => v < currentValue).length;
  const equalCount = valid.filter(v => v === currentValue).length;
  const raw        = 100 * (belowCount + 0.5 * equalCount) / n;
  const percentileRaw     = Math.min(100, Math.max(0, raw));
  const percentileRounded = Math.round(percentileRaw * 10) / 10;
  return {
    status: 'ok',
    percentileRaw,
    percentileRounded,
    validHistoricalCount: n,
    belowCount,
    equalCount,
  };
}

/* ── classifyClimatePercentile ───────────────────────────────────────
   Maps a percentile result to a neutral display category.
   Boundaries (AgroPredict display rules — not NASA/WMO/FAO thresholds):
     0 ≤ p ≤ 10  → unusually-low
     10 < p < 25 → below-central
     25 ≤ p ≤ 75 → central
     75 < p < 90 → above-central
     90 ≤ p ≤ 100 → unusually-high
   ──────────────────────────────────────────────────────────────────── */
function classifyClimatePercentile(parameter, percentileResult) {
  if (parameter !== 'temperature' && parameter !== 'precipitation') {
    return { code: 'unavailable', label: 'Invalid parameter: must be "temperature" or "precipitation"' };
  }
  if (!percentileResult || percentileResult.status !== 'ok') {
    return { code: 'unavailable', label: 'Percentile result unavailable' };
  }
  const p = percentileResult.percentileRaw;
  if (typeof p !== 'number' || !Number.isFinite(p)) {
    return { code: 'unavailable', label: 'Percentile value is not finite' };
  }
  if (p < 0 || p > 100) {
    return { code: 'unavailable', label: 'Percentile value out of range 0–100' };
  }

  let code;
  if      (p <= 10) code = 'unusually-low';
  else if (p <  25) code = 'below-central';
  else if (p <= 75) code = 'central';
  else if (p <  90) code = 'above-central';
  else              code = 'unusually-high';

  const labels = {
    temperature: {
      'unusually-low':  'Unusually cool relative to history',
      'below-central':  'Cooler than most historical windows',
      'central':        'Within the central historical range',
      'above-central':  'Warmer than most historical windows',
      'unusually-high': 'Unusually warm relative to history',
    },
    precipitation: {
      'unusually-low':  'Unusually dry relative to history',
      'below-central':  'Drier than most historical windows',
      'central':        'Within the central historical range',
      'above-central':  'Wetter than most historical windows',
      'unusually-high': 'Unusually wet relative to history',
    },
  };
  return { code, label: labels[parameter][code] };
}

/* ── buildClimateExtremesResult ──────────────────────────────────────
   Orchestrates empirical-percentile calculation independently for
   temperature and precipitation. No combined score is produced.
   currentTemperatureQualifies / currentPrecipitationQualifies:
     boolean — whether the current period meets the coverage threshold
     for that parameter (caller applies the ≥90% / 100% rules).
   historicalTemperatureValues / historicalPrecipitationValues:
     array of per-window aggregates from calculateHistoricalReference.
   minimumHistoricalWindows: minimum valid historical values required
     (falls back to HIST_MIN_QUALIFYING_WINDOWS if omitted/invalid).
   ──────────────────────────────────────────────────────────────────── */
function buildClimateExtremesResult({
  currentTemperature,
  historicalTemperatureValues,
  currentTemperatureQualifies,
  currentPrecipitation,
  historicalPrecipitationValues,
  currentPrecipitationQualifies,
  minimumHistoricalWindows,
}) {
  const minWindows = (typeof minimumHistoricalWindows === 'number' &&
                      Number.isFinite(minimumHistoricalWindows) &&
                      minimumHistoricalWindows > 0)
    ? minimumHistoricalWindows
    : HIST_MIN_QUALIFYING_WINDOWS;

  function computeParam(currentVal, historicalVals, qualifies, paramName) {
    if (!qualifies) {
      return {
        status: 'unavailable',
        reason: `Current-period ${paramName} coverage does not qualify`,
        currentValue: currentVal,
        percentile: {
          status: 'unavailable',
          reason: `Current-period ${paramName} coverage does not qualify`,
          validHistoricalCount: 0,
        },
        classification: { code: 'unavailable', label: 'Unavailable — current coverage insufficient' },
      };
    }
    if (!Array.isArray(historicalVals)) {
      return {
        status: 'unavailable',
        reason: `historicalValues for ${paramName} must be an array`,
        currentValue: currentVal,
        percentile: {
          status: 'unavailable',
          reason: `historicalValues for ${paramName} must be an array`,
          validHistoricalCount: 0,
        },
        classification: { code: 'unavailable', label: 'Unavailable — historical data not an array' },
      };
    }
    const validHistorical = historicalVals.filter(
      v => typeof v === 'number' && Number.isFinite(v) && v !== -999
    );
    if (validHistorical.length < minWindows) {
      return {
        status: 'unavailable',
        reason: `Fewer than ${minWindows} valid historical ${paramName} windows (${validHistorical.length} remain)`,
        currentValue: currentVal,
        percentile: {
          status: 'unavailable',
          reason: `Fewer than ${minWindows} valid historical ${paramName} windows`,
          validHistoricalCount: validHistorical.length,
        },
        classification: { code: 'unavailable', label: 'Unavailable — insufficient historical windows' },
      };
    }
    const percentile     = calculateEmpiricalPercentileRank(currentVal, historicalVals);
    const classification = classifyClimatePercentile(paramName, percentile);
    return {
      status:         percentile.status === 'ok' ? 'ok' : 'unavailable',
      currentValue:   currentVal,
      percentile,
      classification,
    };
  }

  const temperature   = computeParam(
    currentTemperature,   historicalTemperatureValues,   currentTemperatureQualifies,   'temperature'
  );
  const precipitation = computeParam(
    currentPrecipitation, historicalPrecipitationValues, currentPrecipitationQualifies, 'precipitation'
  );

  return { temperature, precipitation };
}

// ── Module export (Node.js) ───────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    HIST_REF_START_YEAR,
    HIST_REF_END_YEAR,
    HIST_MIN_QUALIFYING_WINDOWS,
    HIST_COVERAGE_THRESHOLD_T2M,
    HIST_COVERAGE_THRESHOLD_PRECIP,
    HISTORICAL_METHOD_VERSION,
    isPlainObject,
    isValidDateKey,
    isValidValue,
    validateCoordinates,
    subtractUtcMonthsClamped,
    buildPowerRequest,
    buildHistoricalWindowDefinitions,
    buildHistoricalCacheKey,
    buildHistoricalPowerRequest,
    groupDailyValuesByHistoricalWindow,
    calculateWindowCoverage,
    calculateHistoricalReference,
    aggregateMeanStrict,
    aggregateSumStrict,
    countValidStrict,
    calculateCurrentPeriodCoverage,
    calculateCurrentPeriodAnomalyValues,
    calculateTemperatureAnomaly,
    calculatePrecipitationAnomaly,
    formatHistoricalComparison,
    compareToReferenceRange,
    fetchHistoricalReference,
    fetchAnnualPrecipitationReference,
    getHistoricalReference,
    runHistoricalLifecycle,
    appendSafeHistoricalError,
    HistoricalRequestCoordinator,
    parseStrictPositiveNumber,
    parseOptionalNonNegativeNumber,
    validateFarmEconomicsInput,
    calculateFarmEconomics,
    validateSensitivityInput,
    calculateSensitivityMatrix,
    formatCurrencyValue,
    FARM_FIELD_MAP,
    clearAllFarmValidationErrors,
    clearFarmValidationError,
    applyFarmValidationErrors,
    /* v16/v17 crop screening */
    CROP_CLIMATE_REFERENCE_LIBRARY,
    validateCropReferenceRecord,
    getAvailableCropReferences,
    buildAnnualPrecipScreeningRequest,
    buildAnnualPrecipCacheKey,
    compareAnnualRainfallToCropReference,
    buildCropFactorResults,
    buildCropScreeningSummary,
    validateCropScreeningInput,
    /* v18 additions */
    validateAnalyzedLocation,
    COUNTRY_REGION_REFERENCE_DATA,
    validateRegionReferenceRecord,
    validateCountryRegionCoverage,
    CropScreeningRequestCoordinator,
    runCropScreeningLifecycle,
    /* v19 additions */
    resetCropScreeningUiAfterInvalidation,
    /* v20 additions */
    calculateEmpiricalPercentileRank,
    classifyClimatePercentile,
    buildClimateExtremesResult,
  };
}
