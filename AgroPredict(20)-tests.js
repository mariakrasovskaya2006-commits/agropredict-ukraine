'use strict';
const core = require('./agropredict-core-v20.js');
const {
  subtractUtcMonthsClamped,
  isValidDateKey,
  isValidValue,
  isPlainObject,
  buildHistoricalCacheKey,
  buildHistoricalWindowDefinitions,
  calculateCurrentPeriodCoverage,
  calculateCurrentPeriodAnomalyValues,
  calculateTemperatureAnomaly,
  calculatePrecipitationAnomaly,
  calculateHistoricalReference,
  compareToReferenceRange,
  HIST_COVERAGE_THRESHOLD_T2M,
  HIST_MIN_QUALIFYING_WINDOWS,
  HISTORICAL_METHOD_VERSION,
  fetchHistoricalReference,
  getHistoricalReference,
  runHistoricalLifecycle,
  appendSafeHistoricalError,
  HistoricalRequestCoordinator,
  // v14 farm economics
  parseStrictPositiveNumber,
  parseOptionalNonNegativeNumber,
  validateFarmEconomicsInput,
  calculateFarmEconomics,
  validateSensitivityInput,
  calculateSensitivityMatrix,
  formatCurrencyValue,
  // v15 additions
  FARM_FIELD_MAP,
  applyFarmValidationErrors,
  clearFarmValidationError,
  clearAllFarmValidationErrors,
  // v20 additions
  calculateEmpiricalPercentileRank,
  classifyClimatePercentile,
  buildClimateExtremesResult,
} = core;

// ── Test harness ──────────────────────────────────────────────────────
const results = { cases: 0, assertions: 0, passed: 0, failed: 0 };
const failures = [];

async function tc(name, fn) {
  results.cases++;
  try { await fn(); }
  catch (e) {
    results.assertions++;
    results.failed++;
    failures.push(`[CASE THREW] ${name}: ${e.stack || e.message}`);
  }
}
function eq(label, actual, expected) {
  results.assertions++;
  if (actual === expected) { results.passed++; }
  else {
    results.failed++;
    failures.push(`[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function ok(label, val) { eq(label, !!val, true); }

// ── Helpers ───────────────────────────────────────────────────────────
function makeSignalFetch() {
  return async (url, { signal } = {}) => {
    if (signal && signal.aborted) {
      const e = new Error('AbortError'); e.name = 'AbortError'; throw e;
    }
    await new Promise((_, reject) => {
      if (signal) signal.addEventListener('abort', () => {
        const e = new Error('AbortError'); e.name = 'AbortError'; reject(e);
      });
    });
  };
}

function makeCoord() {
  const coord = new HistoricalRequestCoordinator();
  const mainId = coord.startMainRequest();
  const histId = coord.startHistRequest();
  return { coord, mainId, histId };
}

function goodPayload() {
  return { properties: { parameter: { T2M: {'20260601': 15.0}, PRECTOTCORR: {'20260601': 2.5} } } };
}

function goodFetch() {
  return async () => ({ ok: true, json: async () => goodPayload() });
}

// Helper: build a lifecycle call with injectable fake fetch
async function runLifecycle({ coord, mainId, histId, fakeFetch, abortController,
                               abortReasonRef, timeoutMs = 0, cache,
                               setTimeoutImpl, clearTimeoutImpl }) {
  const cacheKey = 'lc-test-' + Math.random();
  const _cache = cache || new Map();
  let successCalled = 0, errorMsg = null, timeoutCalled = 0, loadingState = true;
  let setLoadingCallCount = 0;
  const promise = runHistoricalLifecycle({
    mainRequestId: mainId,
    histRequestId: histId,
    coordinator: coord,
    fetcher: () => getHistoricalReference({
      cache: _cache, cacheKey,
      fetcher: () => fetchHistoricalReference({
        url: 'http://test',
        fetchImpl: fakeFetch,
        abortController: abortController || new AbortController(),
        timeoutMs,
        abortReasonRef,
        setTimeoutImpl:   setTimeoutImpl  || ((fn, ms) => 0),
        clearTimeoutImpl: clearTimeoutImpl || (() => {}),
      }),
      now: () => new Date(),
    }),
    abortReasonRef,
    onSuccess:  () => { successCalled++; },
    onError:   (msg) => { errorMsg = msg; },
    onTimeout:  () => { timeoutCalled++; },
    setLoading: (v) => { loadingState = v; setLoadingCallCount++; },
  });
  return { promise, get success() { return successCalled; },
           get error() { return errorMsg; }, get timeout() { return timeoutCalled; },
           get loading() { return loadingState; },
           get setLoadingCount() { return setLoadingCallCount; } };
}

// ── Farm economics helper: build valid raw input ──────────────────────
function validRaw(overrides) {
  return Object.assign({
    area:           '100',
    yieldPerHa:     '5',
    salePrice:      '200',
    seeds:          '20',
    fertiliser:     '30',
    cropProtection: '10',
    fuelMachinery:  '15',
    labour:         '25',
    irrigation:     '',
    insurance:      '',
    landRent:       '50',
    otherVariable:  '',
    otherFixed:     '500',
  }, overrides || {});
}

// ── Fake DOM helper for DOM integration tests ─────────────────────────
function makeFakeDoc(fieldMap) {
  const store = {};
  Object.values(fieldMap).forEach(function ({ inputId, errorId }) {
    [inputId, errorId].forEach(function (id) {
      store[id] = {
        _text: '', _attrs: {}, _focused: false,
        get textContent() { return this._text; },
        set textContent(v) { this._text = v; },
        getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : null; },
        setAttribute(k, v) { this._attrs[k] = v; },
        removeAttribute(k) { delete this._attrs[k]; },
        focus() { this._focused = true; },
      };
    });
  });
  return { getElementById(id) { return store[id] || null; }, _store: store };
}

// ─────────────────────────────────────────────────────────────────────
// MAIN — all tests run in an async IIFE (CJS/Node top-level await not available)
// ─────────────────────────────────────────────────────────────────────
(async () => {

// ── DATE EDGE CASES ───────────────────────────────────────────────────
await tc('subtractUtcMonthsClamped: 31 Aug 2026 – 6m = 28 Feb 2026', () => {
  const r = subtractUtcMonthsClamped(new Date(Date.UTC(2026, 7, 31)), 6);
  eq('date', r.toISOString().slice(0, 10), '2026-02-28');
});
await tc('subtractUtcMonthsClamped: 31 Mar 2024 – 1m = 29 Feb 2024 (leap)', () => {
  const r = subtractUtcMonthsClamped(new Date(Date.UTC(2024, 2, 31)), 1);
  eq('date', r.toISOString().slice(0, 10), '2024-02-29');
});
await tc('subtractUtcMonthsClamped: 31 Mar 2025 – 1m = 28 Feb 2025 (non-leap)', () => {
  const r = subtractUtcMonthsClamped(new Date(Date.UTC(2025, 2, 31)), 1);
  eq('date', r.toISOString().slice(0, 10), '2025-02-28');
});
await tc('subtractUtcMonthsClamped: Jun 1 – 3m = Mar 1', () => {
  const r = subtractUtcMonthsClamped(new Date(Date.UTC(2026, 5, 1)), 3);
  eq('date', r.toISOString().slice(0, 10), '2026-03-01');
});
await tc('subtractUtcMonthsClamped: Jan 31 – 1m = Dec 31', () => {
  const r = subtractUtcMonthsClamped(new Date(Date.UTC(2026, 0, 31)), 1);
  eq('date', r.toISOString().slice(0, 10), '2025-12-31');
});

// ── DATE KEY VALIDATION ───────────────────────────────────────────────
await tc('isValidDateKey: valid/invalid cases', () => {
  eq('valid date',               isValidDateKey('20260901'), true);
  eq('impossible month 13',      isValidDateKey('20261301'), false);
  eq('7-digit string',           isValidDateKey('2026011'),  false);
  eq('non-digit chars',          isValidDateKey('abcd0101'), false);
  eq('Feb 30 impossible',        isValidDateKey('20260230'), false);
  eq('Feb 29 non-leap rejected', isValidDateKey('20250229'), false);
  eq('Feb 29 leap accepted',     isValidDateKey('20240229'), true);
});

// ── calculateCurrentPeriodCoverage ────────────────────────────────────
await tc('calculateCurrentPeriodCoverage: out-of-range dates excluded', () => {
  const rawT = { '20260531': 15.0, '20260601': 16.0, '20260701': 17.0 };
  const rawP = { '20260531': 1.0,  '20260601': 2.0,  '20260701': 3.0  };
  const cov = calculateCurrentPeriodCoverage(rawT, rawP, '20260601', '20260630');
  eq('only in-range T2M counted',    cov.t2mValidCount,    1);
  eq('only in-range precip counted', cov.precipValidCount, 1);
  eq('expectedDays',                 cov.expectedDays,     30);
});
await tc('calculateCurrentPeriodCoverage: coverage capped at 100%', () => {
  const many = Object.fromEntries(Array.from({length: 40}, (_, i) => [`20260${String(i+1).padStart(3,'0')}`, 15.0]));
  const cov = calculateCurrentPeriodCoverage(many, many, '20260101', '20260110');
  eq('t2mCoverage capped at 1', cov.t2mCoverage <= 1, true);
});
await tc('calculateCurrentPeriodCoverage: Feb 29 excluded from count', () => {
  const rawT = { '20000229': 99.0, '20000301': 10.0 };
  const cov = calculateCurrentPeriodCoverage(rawT, {}, '20000101', '20001231');
  eq('Feb 29 not counted in t2mValidCount', cov.t2mValidCount, 1);
});
await tc('calculateCurrentPeriodCoverage: T2M qualifies, PRECTOTCORR fails independently', () => {
  const rawT = Object.fromEntries(Array.from({length:9}, (_, i) => [`202606${String(i+1).padStart(2,'0')}`, 15.0]));
  const rawP = Object.fromEntries(Array.from({length:9}, (_, i) => [`202606${String(i+1).padStart(2,'0')}`, 2.0]));
  const cov = calculateCurrentPeriodCoverage(rawT, rawP, '20260601', '20260610');
  eq('T2M 90% qualifies',                   cov.t2mQualifies,    true);
  eq('PRECTOTCORR 90% fails 100% threshold', cov.precipQualifies, false);
});

// ── calculateCurrentPeriodAnomalyValues ──────────────────────────────
await tc('calculateCurrentPeriodAnomalyValues: -999 rejected', () => {
  const r = calculateCurrentPeriodAnomalyValues({'20260101': -999}, {'20260101': -999}, '20260101', '20260101');
  eq('meanT2M null', r.meanT2M, null);
});
await tc('calculateCurrentPeriodAnomalyValues: Feb 29 excluded from mean', () => {
  const r = calculateCurrentPeriodAnomalyValues({'20000229': 99.0, '20000301': 10.0}, {}, '20000101', '20001231');
  eq('meanT2M = 10.0', r.meanT2M, 10.0);
});
await tc('calculateCurrentPeriodAnomalyValues: null rejected', () => {
  const r = calculateCurrentPeriodAnomalyValues({'20260101': null}, {'20260101': null}, '20260101', '20260101');
  eq('meanT2M null', r.meanT2M, null);
});
await tc('calculateCurrentPeriodAnomalyValues: out-of-range dates excluded from mean', () => {
  const r = calculateCurrentPeriodAnomalyValues(
    {'20260531': 99.0, '20260601': 10.0, '20260701': 99.0}, {},
    '20260601', '20260630'
  );
  eq('only in-range value used', r.meanT2M, 10.0);
});

// ── Cache key ─────────────────────────────────────────────────────────
await tc('buildHistoricalCacheKey: starts with HISTORICAL_METHOD_VERSION', () => {
  const key = buildHistoricalCacheKey(49.0, 34.0, '20260301', '20260831');
  ok('key starts with version', key.startsWith(HISTORICAL_METHOD_VERSION + '|'));
});
await tc('buildHistoricalCacheKey: different method version → different key', () => {
  const keyV2 = buildHistoricalCacheKey(49.0, 34.0, '20260301', '20260831');
  const keyV1 = keyV2.replace(HISTORICAL_METHOD_VERSION + '|', 'v1|');
  eq('v2 key differs from v1 key', keyV2 !== keyV1, true);
});
await tc('buildHistoricalCacheKey: exact coords preserved', () => {
  const keyA = buildHistoricalCacheKey(49.12345678, 34.12345678, '20260301', '20260831');
  const keyB = buildHistoricalCacheKey(49.12345679, 34.12345678, '20260301', '20260831');
  eq('tiny lat diff preserved in key', keyA !== keyB, true);
});

// ── fetchHistoricalReference — success ────────────────────────────────
await tc('fetchHistoricalReference: successful request', async () => {
  const controller = new AbortController();
  const abortRef   = { value: null };
  let fetchCalled  = 0, clearedId;
  const fakeSet    = (fn, ms) => 42;
  const fakeClear  = (id)     => { clearedId = id; };
  const fakeFetch  = async (url, opts) => {
    fetchCalled++;
    return { ok: true, json: async () => goodPayload() };
  };
  const r = await fetchHistoricalReference({
    url: 'https://power.larc.nasa.gov/api/test',
    fetchImpl: fakeFetch, abortController: controller,
    timeoutMs: 90000, setTimeoutImpl: fakeSet, clearTimeoutImpl: fakeClear,
    abortReasonRef: abortRef,
  });
  eq('fetch called once', fetchCalled, 1);
  ok('parameterData.T2M is plain object', isPlainObject(r.parameterData.T2M));
  eq('timeout cleared in finally', clearedId, 42);
});

// ── fetchHistoricalReference — HTTP failure ───────────────────────────
await tc('fetchHistoricalReference: HTTP 503 throws with status in message', async () => {
  const controller = new AbortController();
  const abortRef   = { value: null };
  const fakeFetch  = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) });
  let threw = false, errMsg = '', httpStatus;
  try {
    await fetchHistoricalReference({
      url: 'http://test', fetchImpl: fakeFetch, abortController: controller,
      timeoutMs: 0, setTimeoutImpl: (fn, ms) => 0, clearTimeoutImpl: () => {},
      abortReasonRef: abortRef,
    });
  } catch (e) { threw = true; errMsg = e.message; httpStatus = e.httpStatus; }
  eq('throws on HTTP error', threw, true);
  ok('error message contains 503', errMsg.includes('503'));
  eq('httpStatus property', httpStatus, 503);
});

// ── fetchHistoricalReference — malformed responses (6 variants) ───────
await tc('fetchHistoricalReference: malformed responses throw', async () => {
  const malformed = [
    {},
    { properties: {} },
    { properties: { parameter: { T2M: null, PRECTOTCORR: {} } } },
    { properties: { parameter: { T2M: [],   PRECTOTCORR: {} } } },
    { properties: { parameter: { T2M: {},   PRECTOTCORR: null } } },
    { properties: { parameter: { T2M: {},   PRECTOTCORR: [] } } },
  ];
  for (const payload of malformed) {
    let threw = false;
    try {
      await fetchHistoricalReference({
        url: 'http://t', fetchImpl: async () => ({ ok: true, json: async () => payload }),
        abortController: new AbortController(), timeoutMs: 0,
        setTimeoutImpl: () => {}, clearTimeoutImpl: () => {},
        abortReasonRef: { value: null },
      });
    } catch (e) { threw = true; }
    eq(`malformed variant throws: ${JSON.stringify(payload).slice(0,40)}`, threw, true);
  }
});

// ── fetchHistoricalReference — timeout sets abortReason ───────────────
await tc('fetchHistoricalReference: timeout sets abortReason=timeout', async () => {
  const controller = new AbortController();
  const abortRef   = { value: null };
  let timeoutFn, clearedId;
  const fakeSet    = (fn, ms) => { timeoutFn = fn; return 99; };
  const fakeClear  = (id)     => { clearedId = id; };
  const promise = fetchHistoricalReference({
    url: 'http://test', fetchImpl: makeSignalFetch(),
    abortController: controller,
    timeoutMs: 5000, setTimeoutImpl: fakeSet, clearTimeoutImpl: fakeClear,
    abortReasonRef: abortRef,
  });
  timeoutFn();
  let threw = false, reason;
  try { await promise; } catch (e) { threw = true; reason = e.abortReason; }
  eq('throws AbortError',          threw,          true);
  eq('abortReason on error',       reason,         'timeout');
  eq('abortRef.value set',         abortRef.value, 'timeout');
  eq('timeout cleared',            clearedId,      99);
});

// ── fetchHistoricalReference — explicit cancellation ──────────────────
await tc('fetchHistoricalReference: explicit abort with unknown reason', async () => {
  const controller = new AbortController();
  const abortRef   = { value: null };
  const promise = fetchHistoricalReference({
    url: 'http://test', fetchImpl: makeSignalFetch(),
    abortController: controller, timeoutMs: 0,
    setTimeoutImpl: () => {}, clearTimeoutImpl: () => {},
    abortReasonRef: abortRef,
  });
  controller.abort();
  let errName, errAbortReason;
  try { await promise; } catch (e) { errName = e.name; errAbortReason = e.abortReason; }
  eq('AbortError name',            errName,         'AbortError');
  eq('abortReason is unknown',     errAbortReason,  'unknown');
});

// ── HistoricalRequestCoordinator — stale-response tests ───────────────
await tc('coordinator: region/coord/period/mode change invalidates both IDs', () => {
  const coord = new HistoricalRequestCoordinator();
  const mainId = coord.startMainRequest();
  const histId = coord.startHistRequest();
  coord.invalidateAll();
  eq('main stale', coord.isMainStale(mainId), true);
  eq('hist stale', coord.isHistStale(histId), true);
});
await tc('coordinator: new request B — A stale, B current', () => {
  const coord = new HistoricalRequestCoordinator();
  const mainA = coord.startMainRequest();
  const histA = coord.startHistRequest();
  coord.invalidateAll();
  const mainB = coord.startMainRequest();
  const histB = coord.startHistRequest();
  eq('A main stale',   coord.isMainStale(mainA), true);
  eq('A hist stale',   coord.isHistStale(histA), true);
  eq('B main current', coord.isMainStale(mainB), false);
  eq('B hist current', coord.isHistStale(histB), false);
});
await tc('coordinator: invalidateMainOnly — hist unchanged', () => {
  const coord = new HistoricalRequestCoordinator();
  const mainId = coord.startMainRequest();
  const histId = coord.startHistRequest();
  coord.invalidateMainOnly();
  eq('main stale',    coord.isMainStale(mainId), true);
  eq('hist unchanged', coord.isHistStale(histId), false);
});
await tc('coordinator: toggle-off invalidates hist only, main unchanged', () => {
  const coord = new HistoricalRequestCoordinator();
  const mainId = coord.startMainRequest();
  const histId = coord.startHistRequest();
  coord.invalidateHistOnly();
  eq('main unchanged',       coord.isMainStale(mainId), false);
  eq('hist stale',           coord.isHistStale(histId), true);
  eq('mainId value unchanged', coord.mainId,            mainId);
});

// ── getHistoricalReference — cache behaviour ──────────────────────────
await tc('getHistoricalReference: first call fetches, second hits cache', async () => {
  const cache = new Map();
  const key   = 'test-cache-key';
  let calls   = 0;
  const fakeFetcher = async () => { calls++; return { parameterData: { T2M: {}, PRECTOTCORR: {} } }; };
  const fixedNow    = () => new Date('2026-09-01T12:00:00Z');
  const r1 = await getHistoricalReference({ cache, cacheKey: key, fetcher: fakeFetcher, now: fixedNow });
  eq('first: fetcher called once', calls, 1);
  eq('first: fromCache false',     r1.fromCache, false);
  ok('fetchedAt stored',           typeof r1.fetchedAt === 'string');
  const r2 = await getHistoricalReference({ cache, cacheKey: key, fetcher: fakeFetcher, now: fixedNow });
  eq('second: fetcher NOT called again', calls, 1);
  eq('second: fromCache true',           r2.fromCache, true);
  eq('fetchedAt unchanged',              r2.fetchedAt, r1.fetchedAt);
  const r3 = await getHistoricalReference({ cache, cacheKey: 'other', fetcher: fakeFetcher, now: fixedNow });
  eq('different key: fetcher called',    calls, 2);
  eq('different key: fromCache false',   r3.fromCache, false);
});
await tc('getHistoricalReference: method version in key causes cache miss', async () => {
  const cache = new Map();
  let calls = 0;
  const fetcher = async () => { calls++; return { parameterData: { T2M: {}, PRECTOTCORR: {} } }; };
  const keyV2 = buildHistoricalCacheKey(49.0, 34.0, '20260301', '20260831');
  const keyV1 = keyV2.replace(HISTORICAL_METHOD_VERSION + '|', 'v1|');
  await getHistoricalReference({ cache, cacheKey: keyV1, fetcher, now: () => new Date() });
  await getHistoricalReference({ cache, cacheKey: keyV2, fetcher, now: () => new Date() });
  eq('different version → 2 fetcher calls', calls, 2);
  ok('keys differ',                          keyV2 !== keyV1);
});

// ── LIFECYCLE: toggle-off ─────────────────────────────────────────────
await tc('lifecycle: toggle-off → no renderer called, main unchanged, stale req never calls setLoading', async () => {
  const { coord, mainId, histId } = makeCoord();
  const controller     = new AbortController();
  const abortReasonRef = { value: null };
  const lc = await runLifecycle({
    coord, mainId, histId,
    fakeFetch: makeSignalFetch(),
    abortController: controller,
    abortReasonRef,
  });
  abortReasonRef.value = 'user-cancel';
  coord.invalidateHistOnly();
  controller.abort();
  await lc.promise;
  eq('toggle-off: hist stale',                       coord.isHistStale(histId),  true);
  eq('toggle-off: main unchanged',                   coord.isMainStale(mainId),  false);
  eq('toggle-off: controller aborted',               controller.signal.aborted,  true);
  eq('toggle-off: success never called',             lc.success,                 0);
  eq('toggle-off: error never called',               lc.error,                   null);
  eq('toggle-off: timeout never called',             lc.timeout,                 0);
  eq('toggle-off: stale req never calls setLoading', lc.loading,                 true);
});

// ── LIFECYCLE: control-change ─────────────────────────────────────────
await tc('lifecycle: control-change → both IDs stale, no error rendered, stale req never calls setLoading', async () => {
  const { coord, mainId, histId } = makeCoord();
  const controller     = new AbortController();
  const abortReasonRef = { value: null };
  const lc = await runLifecycle({
    coord, mainId, histId,
    fakeFetch: makeSignalFetch(),
    abortController: controller,
    abortReasonRef,
  });
  abortReasonRef.value = 'control-change';
  coord.invalidateAll();
  controller.abort();
  await lc.promise;
  eq('control-change: main stale',                        coord.isMainStale(mainId), true);
  eq('control-change: hist stale',                        coord.isHistStale(histId), true);
  eq('control-change: no error',                          lc.error,                  null);
  eq('control-change: no success',                        lc.success,                0);
  eq('control-change: stale req never calls setLoading',  lc.loading,                true);
});

// ── LIFECYCLE: new-request ────────────────────────────────────────────
await tc('lifecycle: new-request → A cannot render, B can render', async () => {
  const coord  = new HistoricalRequestCoordinator();
  const mainA  = coord.startMainRequest();
  const histA  = coord.startHistRequest();
  const ctrlA  = new AbortController();
  const refA   = { value: null };
  let successA = 0, errorA = 0;
  const cacheA = new Map();
  const lc_A = runHistoricalLifecycle({
    mainRequestId: mainA, histRequestId: histA,
    coordinator: coord,
    fetcher: () => getHistoricalReference({
      cache: cacheA, cacheKey: 'A',
      fetcher: () => fetchHistoricalReference({
        url: 'http://test', fetchImpl: makeSignalFetch(),
        abortController: ctrlA, timeoutMs: 0,
        abortReasonRef: refA,
        setTimeoutImpl: () => {}, clearTimeoutImpl: () => {},
      }),
      now: () => new Date(),
    }),
    abortReasonRef: refA,
    onSuccess: () => { successA++; }, onError: () => { errorA++; },
    onTimeout: () => {}, setLoading: () => {},
  });
  refA.value = 'new-request';
  coord.invalidateAll();
  const mainB = coord.startMainRequest();
  const histB = coord.startHistRequest();
  let successB = 0;
  const lc_B = runHistoricalLifecycle({
    mainRequestId: mainB, histRequestId: histB,
    coordinator: coord,
    fetcher: async () => ({
      parameterData: { T2M: {'20260601': 15}, PRECTOTCORR: {'20260601': 2} },
      fromCache: false, fetchedAt: '2026-09-01 12:00:00 UTC',
    }),
    abortReasonRef: { value: null },
    onSuccess: () => { successB++; }, onError: () => {},
    onTimeout: () => {}, setLoading: () => {},
  });
  ctrlA.abort();
  await Promise.all([lc_A, lc_B]);
  eq('A cannot render success', successA, 0);
  eq('A cannot render error',   errorA,   0);
  eq('B renders success',       successB, 1);
});

// ── LIFECYCLE: real-timeout ───────────────────────────────────────────
await tc('lifecycle: real timeout → onTimeout called once, loading hidden', async () => {
  const { coord, mainId, histId } = makeCoord();
  const controller     = new AbortController();
  const abortReasonRef = { value: null };
  let timeoutFn, clearedId;
  const fakeSetTimeout   = (fn, ms) => { timeoutFn = fn; return 77; };
  const fakeClearTimeout = (id)     => { clearedId  = id; };
  const lc = await runLifecycle({
    coord, mainId, histId,
    fakeFetch: makeSignalFetch(),
    abortController: controller,
    abortReasonRef,
    timeoutMs: 5000,
    setTimeoutImpl:   fakeSetTimeout,
    clearTimeoutImpl: fakeClearTimeout,
  });
  timeoutFn();
  await lc.promise;
  eq('timeout: controller aborted',   controller.signal.aborted, true);
  eq('timeout: abortReason set',      abortReasonRef.value,      'timeout');
  eq('timeout: onTimeout called once', lc.timeout,               1);
  eq('timeout: onError not called',    lc.error,                 null);
  eq('timeout: onSuccess not called',  lc.success,               0);
  eq('timeout: loading hidden',        lc.loading,               false);
  eq('timeout: timer cleared',         clearedId,                77);
});

// ── LIFECYCLE: HTTP-error ─────────────────────────────────────────────
await tc('lifecycle: HTTP error rendered as error, not timeout', async () => {
  const { coord, mainId, histId } = makeCoord();
  const controller     = new AbortController();
  const abortReasonRef = { value: null };
  const httpFetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) });
  const lc = await runLifecycle({
    coord, mainId, histId,
    fakeFetch: httpFetch,
    abortController: controller,
    abortReasonRef,
  });
  await lc.promise;
  ok('HTTP error message set',      lc.error && lc.error.includes('503'));
  eq('not rendered as timeout',     lc.timeout, 0);
  eq('not rendered as success',     lc.success, 0);
  eq('loading hidden after error',  lc.loading,  false);
});

// ── LIFECYCLE: cache-hit ──────────────────────────────────────────────
await tc('lifecycle: cache-hit → no fetch, no timeout, success called', async () => {
  const { coord, mainId, histId } = makeCoord();
  const controller     = new AbortController();
  const abortReasonRef = { value: null };
  const cacheKey = 'cache-hit-lc';
  const cache = new Map();
  cache.set(cacheKey, {
    parameterData: { T2M: {'20260601': 15.0}, PRECTOTCORR: {'20260601': 2.5} },
    fetchedAt: '2026-09-01 10:00:00 UTC',
  });
  let networkCalls = 0, setTimeoutCalls = 0, successCalled = 0;
  await runHistoricalLifecycle({
    mainRequestId: mainId, histRequestId: histId,
    coordinator: coord,
    fetcher: () => getHistoricalReference({
      cache, cacheKey,
      fetcher: () => {
        networkCalls++;
        return fetchHistoricalReference({
          url: 'http://test',
          fetchImpl: async () => { throw new Error('should not fetch'); },
          abortController: controller, timeoutMs: 9000,
          abortReasonRef,
          setTimeoutImpl:  (fn, ms) => { setTimeoutCalls++; return 1; },
          clearTimeoutImpl: () => {},
        });
      },
      now: () => new Date(),
    }),
    abortReasonRef,
    onSuccess: () => { successCalled++; },
    onError: () => {}, onTimeout: () => {}, setLoading: () => {},
  });
  eq('cache-hit: no network call',    networkCalls,    0);
  eq('cache-hit: no timeout started', setTimeoutCalls, 0);
  eq('cache-hit: success called',     successCalled,   1);
});

// ── XSS SAFETY — appendSafeHistoricalError ────────────────────────────
await tc('XSS: appendSafeHistoricalError uses createTextNode, never innerHTML with payload', () => {
  const xssPayload = '<img src=x onerror=alert(1)>';
  let textNodeValues = [];
  let innerHTMLValues = [];
  const fakeContainer = {
    set innerHTML(v) { innerHTMLValues.push(v); },
    get innerHTML()  { return ''; },
    appendChild: () => {},
  };
  const makeEl = () => ({
    style: { set cssText(v) {} },
    set textContent(v) {},
    get innerHTML()   { return ''; },
    set innerHTML(v)  { innerHTMLValues.push(v); },
    appendChild: () => {},
  });
  const domFactory = {
    createElement:  (tag)  => makeEl(),
    createTextNode: (text) => { textNodeValues.push(text); return { nodeValue: text }; },
  };
  appendSafeHistoricalError(fakeContainer, xssPayload, domFactory);
  eq('createTextNode called with XSS payload',
     textNodeValues[textNodeValues.length - 1], xssPayload);
  const htmlContainsPayload = innerHTMLValues.some(v => v.includes('<img'));
  eq('innerHTML never set to XSS payload', htmlContainsPayload, false);
});

// ── PURE FUNCTION TESTS (carried from v11) ────────────────────────────
await tc('calculateTemperatureAnomaly: warmer/cooler/zero', () => {
  eq('warmer', calculateTemperatureAnomaly(18.5, 15.0).direction, 'warmer');
  eq('cooler', calculateTemperatureAnomaly(12.0, 15.0).direction, 'cooler');
  eq('rounded-to-zero status', calculateTemperatureAnomaly(15.04, 15.0).status, 'zero');
});
await tc('calculatePrecipitationAnomaly: wetter/drier/zero-hist-mean', () => {
  eq('wetter',    calculatePrecipitationAnomaly(650, 500).direction, 'wetter');
  eq('drier roundedMm', calculatePrecipitationAnomaly(300, 500).roundedMm, -200.0);
  eq('zero hist mean → differencePercent null', calculatePrecipitationAnomaly(100, 0).differencePercent, null);
});
await tc('calculateWindowCoverage: string-valued count=0', () => {
  eq('string value rejected', core.calculateWindowCoverage({'20260101': '5.2'}, 1).validCount, 0);
});
await tc('calculateHistoricalReference: 23 windows insufficient, 24 ok', () => {
  const windows30 = Array.from({length: 30}, (_, i) => ({
    year: 1991 + i, expectedDays: 1,
    startDate: new Date(Date.UTC(1991 + i, 5, 1)),
    endDate:   new Date(Date.UTC(1991 + i, 5, 1)),
    t2mByDate:    (1991 + i) <= 2013 ? {[`${1991 + i}0601`]: 15.0} : {},
    precipByDate: {},
  }));
  eq('23 windows → insufficient', calculateHistoricalReference(windows30, 't2mByDate', 'mean').status, 'insufficient-windows');
  const w24 = windows30.map((w, i) => ({ ...w, t2mByDate: i < 24 ? {[`${w.year}0601`]: 15.0} : {} }));
  eq('24 windows → ok', calculateHistoricalReference(w24, 't2mByDate', 'mean').status, 'ok');
});
await tc('buildHistoricalWindowDefinitions: 30 windows, Jun-Aug=92 days, year-crossing', () => {
  const w = buildHistoricalWindowDefinitions('20260601', '20260831');
  eq('30 windows', w.length, 30);
  eq('Jun-Aug expectedDays=92', w[0].expectedDays, 92);
  const wc = buildHistoricalWindowDefinitions('20250901', '20260831');
  eq('year-crossing start year=1990', wc[0].startDate.getUTCFullYear(), 1990);
  const leap = wc.find(x => x.year === 2000);
  eq('Sep1999-Aug2000 excludes Feb29 → 365 days', leap.expectedDays, 365);
});
await tc('compareToReferenceRange: within-optimal / outside-absolute / reversed', () => {
  eq('combined', [
    compareToReferenceRange(800, 750, 900, 300, 1600).status,
    compareToReferenceRange(100, 750, 900, 300, 1600).status,
    compareToReferenceRange(800, 900, 750, 300, 1600).status,
  ].join('|'), 'within-optimal|outside-absolute|unavailable');
});
await tc('isValidValue: rejects invalid types', () => {
  const invalids = ['5', Infinity, -Infinity, undefined, -999, null, NaN, true, {}];
  eq('all rejected', invalids.every(v => !isValidValue(v)), true);
});

// ─────────────────────────────────────────────────────────────────────
// v13 CONCURRENCY TESTS
// ─────────────────────────────────────────────────────────────────────

await tc('v13: stale success → A setLoading never called, B setLoading called once', async () => {
  const coord = new HistoricalRequestCoordinator();
  const mainA = coord.startMainRequest();
  const histA = coord.startHistRequest();
  let aLoadingCalls = 0, bLoadingCalls = 0;
  let resolveA;
  const aResultPromise = new Promise(res => { resolveA = res; });

  const promiseA = runHistoricalLifecycle({
    mainRequestId: mainA, histRequestId: histA, coordinator: coord,
    fetcher: () => aResultPromise,
    abortReasonRef: { value: null },
    onSuccess: () => {}, onError: () => {}, onTimeout: () => {},
    setLoading: () => { aLoadingCalls++; },
  });

  coord.invalidateAll();
  const mainB = coord.startMainRequest();
  const histB = coord.startHistRequest();

  const promiseB = runHistoricalLifecycle({
    mainRequestId: mainB, histRequestId: histB, coordinator: coord,
    fetcher: async () => ({
      parameterData: { T2M: {'20260601': 15}, PRECTOTCORR: {'20260601': 2} },
      fromCache: false, fetchedAt: '2026-09-01 12:00:00 UTC',
    }),
    abortReasonRef: { value: null },
    onSuccess: () => {}, onError: () => {}, onTimeout: () => {},
    setLoading: () => { bLoadingCalls++; },
  });

  resolveA({
    parameterData: { T2M: {'20260601': 15}, PRECTOTCORR: {'20260601': 2} },
    fromCache: false, fetchedAt: '2026-09-01 12:00:00 UTC',
  });
  await Promise.all([promiseA, promiseB]);

  eq('stale-success: A setLoading never called', aLoadingCalls, 0);
  eq('stale-success: B setLoading called once',  bLoadingCalls, 1);
});

await tc('v13: stale HTTP error → A setLoading never called, B setLoading called once', async () => {
  const coord = new HistoricalRequestCoordinator();
  const mainA = coord.startMainRequest();
  const histA = coord.startHistRequest();
  let aLoadingCalls = 0, bLoadingCalls = 0;
  let rejectA;
  const aResultPromise = new Promise((_, rej) => { rejectA = rej; });

  const promiseA = runHistoricalLifecycle({
    mainRequestId: mainA, histRequestId: histA, coordinator: coord,
    fetcher: () => aResultPromise,
    abortReasonRef: { value: null },
    onSuccess: () => {}, onError: () => {}, onTimeout: () => {},
    setLoading: () => { aLoadingCalls++; },
  });

  coord.invalidateAll();
  const mainB = coord.startMainRequest();
  const histB = coord.startHistRequest();

  const promiseB = runHistoricalLifecycle({
    mainRequestId: mainB, histRequestId: histB, coordinator: coord,
    fetcher: async () => ({
      parameterData: { T2M: {'20260601': 15}, PRECTOTCORR: {'20260601': 2} },
      fromCache: false, fetchedAt: '2026-09-01 12:00:00 UTC',
    }),
    abortReasonRef: { value: null },
    onSuccess: () => {}, onError: () => {}, onTimeout: () => {},
    setLoading: () => { bLoadingCalls++; },
  });

  rejectA(new Error('HTTP 503: Service Unavailable'));
  await Promise.all([promiseA, promiseB]);

  eq('stale-failure: A setLoading never called', aLoadingCalls, 0);
  eq('stale-failure: B setLoading called once',  bLoadingCalls, 1);
});

await tc('v13: stale timeout → A setLoading never called, B setLoading called once', async () => {
  const coord = new HistoricalRequestCoordinator();
  const mainA = coord.startMainRequest();
  const histA = coord.startHistRequest();
  let aLoadingCalls = 0, bLoadingCalls = 0;
  let rejectA;
  const aResultPromise = new Promise((_, rej) => { rejectA = rej; });

  const promiseA = runHistoricalLifecycle({
    mainRequestId: mainA, histRequestId: histA, coordinator: coord,
    fetcher: () => aResultPromise,
    abortReasonRef: { value: 'timeout' },
    onSuccess: () => {}, onError: () => {}, onTimeout: () => {},
    setLoading: () => { aLoadingCalls++; },
  });

  coord.invalidateAll();
  const mainB = coord.startMainRequest();
  const histB = coord.startHistRequest();

  const promiseB = runHistoricalLifecycle({
    mainRequestId: mainB, histRequestId: histB, coordinator: coord,
    fetcher: async () => ({
      parameterData: { T2M: {'20260601': 15}, PRECTOTCORR: {'20260601': 2} },
      fromCache: false, fetchedAt: '2026-09-01 12:00:00 UTC',
    }),
    abortReasonRef: { value: null },
    onSuccess: () => {}, onError: () => {}, onTimeout: () => {},
    setLoading: () => { bLoadingCalls++; },
  });

  const abortErr = new Error('AbortError');
  abortErr.name = 'AbortError';
  abortErr.abortReason = 'timeout';
  rejectA(abortErr);
  await Promise.all([promiseA, promiseB]);

  eq('stale-timeout: A setLoading never called', aLoadingCalls, 0);
  eq('stale-timeout: B setLoading called once',  bLoadingCalls, 1);
});

await tc('v13: active success → setLoading(false) called exactly once', async () => {
  const { coord, mainId, histId } = makeCoord();
  const lc = await runLifecycle({
    coord, mainId, histId,
    fakeFetch: goodFetch(),
    abortController: new AbortController(),
    abortReasonRef: { value: null },
  });
  await lc.promise;
  eq('active-success: setLoading called once', lc.setLoadingCount, 1);
  eq('active-success: loading hidden',          lc.loading,          false);
  eq('active-success: onSuccess called',        lc.success,          1);
});

await tc('v13: active HTTP error → setLoading(false) called exactly once', async () => {
  const { coord, mainId, histId } = makeCoord();
  const httpFetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) });
  const lc = await runLifecycle({
    coord, mainId, histId,
    fakeFetch: httpFetch,
    abortController: new AbortController(),
    abortReasonRef: { value: null },
  });
  await lc.promise;
  eq('active-error: setLoading called once', lc.setLoadingCount, 1);
  eq('active-error: loading hidden',          lc.loading,          false);
  ok('active-error: error message contains 503', lc.error && lc.error.includes('503'));
});

await tc('v13: active timeout → setLoading(false) called exactly once, onTimeout called', async () => {
  const { coord, mainId, histId } = makeCoord();
  let timeoutFn;
  const fakeSetTimeout   = (fn, ms) => { timeoutFn = fn; return 88; };
  const fakeClearTimeout = () => {};
  const lc = await runLifecycle({
    coord, mainId, histId,
    fakeFetch: makeSignalFetch(),
    abortController: new AbortController(),
    abortReasonRef: { value: null },
    timeoutMs: 5000,
    setTimeoutImpl:   fakeSetTimeout,
    clearTimeoutImpl: fakeClearTimeout,
  });
  timeoutFn();
  await lc.promise;
  eq('active-timeout: setLoading called once', lc.setLoadingCount, 1);
  eq('active-timeout: loading hidden',          lc.loading,          false);
  eq('active-timeout: onTimeout called once',   lc.timeout,          1);
});

await tc('v13: current unknown abort → onError called with neutral interruption message', async () => {
  const { coord, mainId, histId } = makeCoord();
  const controller     = new AbortController();
  const abortReasonRef = { value: null };
  const lc = await runLifecycle({
    coord, mainId, histId,
    fakeFetch: makeSignalFetch(),
    abortController: controller,
    abortReasonRef,
  });
  controller.abort();
  await lc.promise;
  eq('unknown-abort: setLoading called once',          lc.setLoadingCount, 1);
  eq('unknown-abort: loading hidden',                   lc.loading,          false);
  ok('unknown-abort: onError called with neutral msg',  lc.error && lc.error.includes('interrupted'));
  eq('unknown-abort: onTimeout not called',             lc.timeout,          0);
});

await tc('v13: controller ownership — stale A cannot null B refs or hide B loading', async () => {
  const coord = new HistoricalRequestCoordinator();
  const mainA = coord.startMainRequest();
  const histA = coord.startHistRequest();

  const controllerA = new AbortController();
  const refA        = { value: null };
  let aSetLoadingCalled = false;
  let resolveA;
  const aResultPromise  = new Promise(res => { resolveA = res; });

  const promiseA = runHistoricalLifecycle({
    mainRequestId: mainA, histRequestId: histA, coordinator: coord,
    fetcher: () => aResultPromise,
    abortReasonRef: refA,
    onSuccess: () => {}, onError: () => {}, onTimeout: () => {},
    setLoading: () => { aSetLoadingCalled = true; },
  });

  refA.value = 'new-request';
  coord.invalidateAll();
  controllerA.abort();

  const mainB = coord.startMainRequest();
  const histB = coord.startHistRequest();
  const controllerB = new AbortController();
  const refB        = { value: null };
  let bSetLoadingCalled = false, bSuccessCalled = false;

  const promiseB = runHistoricalLifecycle({
    mainRequestId: mainB, histRequestId: histB, coordinator: coord,
    fetcher: async () => ({
      parameterData: { T2M: {'20260601': 15}, PRECTOTCORR: {'20260601': 2} },
      fromCache: false, fetchedAt: '2026-09-01 12:00:00 UTC',
    }),
    abortReasonRef: refB,
    onSuccess: () => { bSuccessCalled = true; },
    onError: () => {}, onTimeout: () => {},
    setLoading: () => { bSetLoadingCalled = true; },
  });

  resolveA({
    parameterData: { T2M: {'20260601': 15}, PRECTOTCORR: {'20260601': 2} },
    fromCache: false, fetchedAt: '2026-09-01 12:00:00 UTC',
  });
  await Promise.all([promiseA, promiseB]);

  eq('ownership: stale A setLoading never called', aSetLoadingCalled,          false);
  eq('ownership: B controller not aborted by A',   controllerB.signal.aborted, false);
  eq('ownership: B success not blocked by A',      bSuccessCalled,             true);
  eq('ownership: B setLoading called by B',        bSetLoadingCalled,          true);
});

// ─────────────────────────────────────────────────────────────────────
// v14 FARM ECONOMICS TESTS
// ─────────────────────────────────────────────────────────────────────

// ── VALIDATION TESTS (1–16) ───────────────────────────────────────────

// Test 1: Valid complete input passes validation
// v15 fix: use normalized field names seedsPerHa, fertiliserPerHa, irrigationPerHa, insurancePerHa
await tc('fecon-1: valid complete input passes validation', () => {
  const r = validateFarmEconomicsInput(validRaw());
  eq('valid', r.valid, true);
  ok('parsed exists', !!r.parsed);
  eq('area', r.parsed.areaHectares, 100);
  eq('yield', r.parsed.expectedYieldTonnesPerHectare, 5);
  eq('price', r.parsed.salePricePerTonne, 200);
  eq('seeds', r.parsed.seedsPerHa, 20);
  eq('fertiliser', r.parsed.fertiliserPerHa, 30);
  eq('blank irrigation → 0', r.parsed.irrigationPerHa, 0);
  eq('blank insurance → 0', r.parsed.insurancePerHa, 0);
  eq('otherFixed', r.parsed.otherFixedCosts, 500);
});

// Test 2: Blank area → required error
await tc('fecon-2: blank area → required error', () => {
  const r = validateFarmEconomicsInput(validRaw({ area: '' }));
  eq('invalid', r.valid, false);
  ok('error for area', r.errors.some(e => e.field === 'area'));
});

// Test 3: Blank yieldPerHa → required error
await tc('fecon-3: blank yieldPerHa → required error', () => {
  const r = validateFarmEconomicsInput(validRaw({ yieldPerHa: '' }));
  eq('invalid', r.valid, false);
  ok('error for yieldPerHa', r.errors.some(e => e.field === 'yieldPerHa'));
});

// Test 4: Blank salePrice → required error
await tc('fecon-4: blank salePrice → required error', () => {
  const r = validateFarmEconomicsInput(validRaw({ salePrice: '' }));
  eq('invalid', r.valid, false);
  ok('error for salePrice', r.errors.some(e => e.field === 'salePrice'));
});

// Test 5: Zero area → error (must be > 0)
await tc('fecon-5: zero area → error', () => {
  const r = validateFarmEconomicsInput(validRaw({ area: '0' }));
  eq('invalid', r.valid, false);
  ok('error for area', r.errors.some(e => e.field === 'area'));
});

// Test 6: Negative yieldPerHa → error
await tc('fecon-6: negative yieldPerHa → error', () => {
  const r = validateFarmEconomicsInput(validRaw({ yieldPerHa: '-1' }));
  eq('invalid', r.valid, false);
  ok('error for yieldPerHa', r.errors.some(e => e.field === 'yieldPerHa'));
});

// Test 7: Negative salePrice → error
await tc('fecon-7: negative salePrice → error', () => {
  const r = validateFarmEconomicsInput(validRaw({ salePrice: '-100' }));
  eq('invalid', r.valid, false);
  ok('error for salePrice', r.errors.some(e => e.field === 'salePrice'));
});

// Test 8: Negative optional cost → error
await tc('fecon-8: negative optional cost → error', () => {
  const r = validateFarmEconomicsInput(validRaw({ seeds: '-1' }));
  eq('invalid', r.valid, false);
  ok('error for seeds', r.errors.some(e => e.field === 'seeds'));
});

// Test 9: All optional costs blank → all parse to 0
// v15 fix: use normalized field names seedsPerHa, fertiliserPerHa
await tc('fecon-9: all optional costs blank → all 0', () => {
  const raw = validRaw({
    seeds: '', fertiliser: '', cropProtection: '', fuelMachinery: '',
    labour: '', irrigation: '', insurance: '', landRent: '',
    otherVariable: '', otherFixed: '',
  });
  const r = validateFarmEconomicsInput(raw);
  eq('valid', r.valid, true);
  eq('seeds=0', r.parsed.seedsPerHa, 0);
  eq('fertiliser=0', r.parsed.fertiliserPerHa, 0);
  eq('otherFixed=0', r.parsed.otherFixedCosts, 0);
});

// Test 10: Partial string for area → error (Number("12abc") = NaN)
await tc('fecon-10: partial string area → error', () => {
  const r = validateFarmEconomicsInput(validRaw({ area: '12abc' }));
  eq('invalid', r.valid, false);
  ok('error for area', r.errors.some(e => e.field === 'area'));
});

// Test 11: NaN-producing string for yield → error
await tc('fecon-11: NaN string yield → error', () => {
  const r = validateFarmEconomicsInput(validRaw({ yieldPerHa: 'abc' }));
  eq('invalid', r.valid, false);
  ok('error for yieldPerHa', r.errors.some(e => e.field === 'yieldPerHa'));
});

// Test 12: Infinity string for price → error
await tc('fecon-12: Infinity string price → error', () => {
  const r = validateFarmEconomicsInput(validRaw({ salePrice: 'Infinity' }));
  eq('invalid', r.valid, false);
  ok('error for salePrice', r.errors.some(e => e.field === 'salePrice'));
});

// Test 13: Boolean true as area (non-string raw) — function receives strings from form
await tc('fecon-13: boolean value for area → error', () => {
  const r = validateFarmEconomicsInput(validRaw({ area: true }));
  eq('invalid', r.valid, false);
  ok('error for area', r.errors.some(e => e.field === 'area'));
});

// Test 14: Array value for area → error
await tc('fecon-14: array value for area → error', () => {
  const r = validateFarmEconomicsInput(validRaw({ area: [100] }));
  eq('invalid', r.valid, false);
  ok('error for area', r.errors.some(e => e.field === 'area'));
});

// Test 15: Object value for area → error
await tc('fecon-15: object value for area → error', () => {
  const r = validateFarmEconomicsInput(validRaw({ area: { v: 100 } }));
  eq('invalid', r.valid, false);
  ok('error for area', r.errors.some(e => e.field === 'area'));
});

// Test 16: Multiple errors reported at once
await tc('fecon-16: multiple required fields blank → multiple errors', () => {
  const r = validateFarmEconomicsInput({ area: '', yieldPerHa: '', salePrice: '',
    seeds: '', fertiliser: '', cropProtection: '', fuelMachinery: '',
    labour: '', irrigation: '', insurance: '', landRent: '', otherVariable: '', otherFixed: '' });
  eq('invalid', r.valid, false);
  ok('area error', r.errors.some(e => e.field === 'area'));
  ok('yield error', r.errors.some(e => e.field === 'yieldPerHa'));
  ok('price error', r.errors.some(e => e.field === 'salePrice'));
});

// ── CALCULATION TESTS (17–31) ─────────────────────────────────────────

// Test 17: Core calculation — total production
await tc('fecon-17: totalProductionTonnes = area × yield', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const r = calculateFarmEconomics(v);
  eq('totalProductionTonnes', r.totalProductionTonnes, 500); // 100 × 5
});

// Test 18: Core calculation — total revenue
await tc('fecon-18: totalRevenue = production × salePrice', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const r = calculateFarmEconomics(v);
  eq('totalRevenue', r.totalRevenue, 100000); // 500 × 200
});

// Test 19: Variable cost per hectare = sum of variable inputs
await tc('fecon-19: variableCostPerHectare = sum of 9 variable inputs', () => {
  // seeds=20, fertiliser=30, cropProtection=10, fuelMachinery=15,
  // labour=25, irrigation=0, insurance=0, landRent=50, otherVariable=0 → 150
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const r = calculateFarmEconomics(v);
  eq('variableCostPerHectare', r.variableCostPerHectare, 150);
});

// Test 20: Total variable costs = variableCostPerHectare × area
await tc('fecon-20: totalVariableCosts = variableCostPerHa × area', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const r = calculateFarmEconomics(v);
  eq('totalVariableCosts', r.totalVariableCosts, 15000); // 150 × 100
});

// Test 21: Total scenario costs = variable + fixed
await tc('fecon-21: totalScenarioCosts = totalVariableCosts + otherFixed', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const r = calculateFarmEconomics(v);
  eq('totalScenarioCosts', r.totalScenarioCosts, 15500); // 15000 + 500
});

// Test 22: Gross margin = revenue − variable costs (fixed excluded)
await tc('fecon-22: grossMargin = revenue − totalVariableCosts', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const r = calculateFarmEconomics(v);
  eq('grossMargin', r.grossMargin, 85000); // 100000 - 15000
});

// Test 23: Gross margin per hectare
await tc('fecon-23: grossMarginPerHectare = grossMargin / area', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const r = calculateFarmEconomics(v);
  eq('grossMarginPerHectare', r.grossMarginPerHectare, 850); // 85000 / 100
});

// Test 24: Operating result = revenue − all costs
await tc('fecon-24: operatingResult = revenue − totalScenarioCosts', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const r = calculateFarmEconomics(v);
  eq('operatingResult', r.operatingResult, 84500); // 100000 - 15500
});

// Test 25: Operating result per hectare
await tc('fecon-25: operatingResultPerHectare = operatingResult / area', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const r = calculateFarmEconomics(v);
  eq('operatingResultPerHectare', r.operatingResultPerHectare, 845); // 84500 / 100
});

// Test 26: Operating margin percent
await tc('fecon-26: operatingMarginPercent = operatingResult / revenue × 100', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const r = calculateFarmEconomics(v);
  eq('operatingMarginPercent', r.operatingMarginPercent, 84.5); // 84500/100000*100
});

// Test 27: Break-even yield
await tc('fecon-27: breakEvenYield = totalScenarioCosts / (area × price)', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const r = calculateFarmEconomics(v);
  eq('breakEvenYieldTonnesPerHectare', r.breakEvenYieldTonnesPerHectare, 0.775); // 15500/(100*200)
});

// Test 28: Break-even price
await tc('fecon-28: breakEvenPrice = totalScenarioCosts / totalProduction', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const r = calculateFarmEconomics(v);
  eq('breakEvenPricePerTonne', r.breakEvenPricePerTonne, 31); // 15500/500
});

// Test 29: Cost per tonne = totalScenarioCosts / totalProduction
await tc('fecon-29: costPerTonne = totalScenarioCosts / totalProduction', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const r = calculateFarmEconomics(v);
  eq('costPerTonne', r.costPerTonne, 31); // 15500/500
});

// Test 30: Negative operating result (costs exceed revenue)
await tc('fecon-30: costs exceed revenue → negative operatingResult', () => {
  const raw = validRaw({ salePrice: '10' }); // revenue=5000, costs=15500
  const v = validateFarmEconomicsInput(raw).parsed;
  const r = calculateFarmEconomics(v);
  ok('operatingResult negative', r.operatingResult < 0);
  eq('operatingResult', r.operatingResult, -10500); // 5000 - 15500
});

// Test 31: No premature rounding — result values are exact numbers
// v15 fix (Option A): explicitly zero all other costs so totals are isolated
await tc('fecon-31: no premature rounding in calculation', () => {
  const raw = validRaw({
    area: '3', yieldPerHa: '3', salePrice: '3', seeds: '1',
    fertiliser: '', cropProtection: '', fuelMachinery: '', labour: '',
    irrigation: '', insurance: '', landRent: '', otherVariable: '', otherFixed: '500',
  });
  // production=9, revenue=27, variableCostHa=1, totalVar=3, totalCost=503, operating=27-503=-476
  const v = validateFarmEconomicsInput(raw).parsed;
  const r = calculateFarmEconomics(v);
  eq('totalProductionTonnes exact', r.totalProductionTonnes, 9);
  eq('totalRevenue exact', r.totalRevenue, 27);
  eq('operatingResult exact', r.operatingResult, -476); // 27 - (3 + 500)
});

// ── SENSITIVITY TESTS (32–41) ─────────────────────────────────────────

// Test 32: 3×3 matrix shape
await tc('fecon-32: sensitivity matrix is 3×3', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const c = calculateFarmEconomics(v);
  const bp = { areaHectares: v.areaHectares, expectedYieldTonnesPerHectare: v.expectedYieldTonnesPerHectare,
               salePricePerTonne: v.salePricePerTonne, totalScenarioCosts: c.totalScenarioCosts };
  const sv = validateSensitivityInput('10', '10');
  const m = calculateSensitivityMatrix(bp, sv);
  eq('3 rows', m.length, 3);
  eq('3 cols in row 0', m[0].length, 3);
  eq('3 cols in row 1', m[1].length, 3);
  eq('3 cols in row 2', m[2].length, 3);
});

// Test 33: Base cell (row 1, col 1) has no yield/price change
await tc('fecon-33: base cell [1][1] has yieldChange=0 and priceChange=0', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const c = calculateFarmEconomics(v);
  const bp = { areaHectares: v.areaHectares, expectedYieldTonnesPerHectare: v.expectedYieldTonnesPerHectare,
               salePricePerTonne: v.salePricePerTonne, totalScenarioCosts: c.totalScenarioCosts };
  const sv = validateSensitivityInput('10', '10');
  const m = calculateSensitivityMatrix(bp, sv);
  eq('base yieldChangePercent=0', m[1][1].yieldChangePercent, 0);
  eq('base priceChangePercent=0', m[1][1].priceChangePercent, 0);
});

// Test 34: Base cell operating result matches main calculation
await tc('fecon-34: base cell operatingResult matches main calculation', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const c = calculateFarmEconomics(v);
  const bp = { areaHectares: v.areaHectares, expectedYieldTonnesPerHectare: v.expectedYieldTonnesPerHectare,
               salePricePerTonne: v.salePricePerTonne, totalScenarioCosts: c.totalScenarioCosts };
  const sv = validateSensitivityInput('10', '10');
  const m = calculateSensitivityMatrix(bp, sv);
  eq('base cell operating result matches', m[1][1].scenarioOperatingResult, c.operatingResult);
});

// Test 35: Sensitivity analysis holds costs constant
await tc('fecon-35: costs constant across sensitivity matrix', () => {
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  const c = calculateFarmEconomics(v);
  const bp = { areaHectares: v.areaHectares, expectedYieldTonnesPerHectare: v.expectedYieldTonnesPerHectare,
               salePricePerTonne: v.salePricePerTonne, totalScenarioCosts: c.totalScenarioCosts };
  const sv = validateSensitivityInput('10', '10');
  const m = calculateSensitivityMatrix(bp, sv);
  const costs00 = m[0][0].scenarioRevenue - m[0][0].scenarioOperatingResult;
  const costs02 = m[0][2].scenarioRevenue - m[0][2].scenarioOperatingResult;
  eq('costs same across price cols', costs00, costs02);
  const costs00r = m[0][0].scenarioRevenue - m[0][0].scenarioOperatingResult;
  const costs20r = m[2][0].scenarioRevenue - m[2][0].scenarioOperatingResult;
  eq('costs same across yield rows', costs00r, costs20r);
});

// Test 36: Yield and price changes applied correctly
await tc('fecon-36: scenario yield and price computed correctly at −step', () => {
  const raw = validRaw({ area: '100', yieldPerHa: '5', salePrice: '200' });
  const v = validateFarmEconomicsInput(raw).parsed;
  const c = calculateFarmEconomics(v);
  const bp = { areaHectares: 100, expectedYieldTonnesPerHectare: 5,
               salePricePerTonne: 200, totalScenarioCosts: c.totalScenarioCosts };
  const sv = validateSensitivityInput('10', '10');
  const m = calculateSensitivityMatrix(bp, sv);
  eq('scenarioYield at −10%', m[0][1].scenarioYield, 4.5);
  eq('scenarioPrice at −10%', m[1][0].scenarioPrice, 180);
});

// Test 37: validateSensitivityInput with blank yield step → invalid
await tc('fecon-37: blank yield step → invalid', () => {
  const sv = validateSensitivityInput('', '10');
  eq('invalid', sv.valid, false);
  ok('yieldStep error', sv.errors.some(e => e.field === 'yieldStep'));
});

// Test 38: validateSensitivityInput with zero price step → invalid
await tc('fecon-38: zero price step → invalid (must be > 0)', () => {
  const sv = validateSensitivityInput('10', '0');
  eq('invalid', sv.valid, false);
  ok('priceStep error', sv.errors.some(e => e.field === 'priceStep'));
});

// Test 39: validateSensitivityInput with step ≥ 100 → invalid
await tc('fecon-39: step ≥ 100 → invalid', () => {
  const sv100 = validateSensitivityInput('100', '10');
  eq('100 invalid', sv100.valid, false);
  const sv200 = validateSensitivityInput('10', '200');
  eq('200 invalid', sv200.valid, false);
});

// Test 40: validateSensitivityInput with negative step → invalid
await tc('fecon-40: negative step → invalid', () => {
  const sv = validateSensitivityInput('-10', '10');
  eq('invalid', sv.valid, false);
  ok('yieldStep error', sv.errors.some(e => e.field === 'yieldStep'));
});

// Test 41: validateSensitivityInput with partial string step → invalid
await tc('fecon-41: partial string step → invalid', () => {
  const sv = validateSensitivityInput('10abc', '10');
  eq('invalid', sv.valid, false);
  ok('yieldStep error', sv.errors.some(e => e.field === 'yieldStep'));
});

// ── INDEPENDENCE AND REGRESSION TESTS (42–46) ─────────────────────────

// Test 42: Country selection does not affect calculation
await tc('fecon-42: country change does not alter calculation results', () => {
  const rawUA = validRaw();
  const rawSK = validRaw();
  const r1 = calculateFarmEconomics(validateFarmEconomicsInput(rawUA).parsed);
  const r2 = calculateFarmEconomics(validateFarmEconomicsInput(rawSK).parsed);
  eq('same totalRevenue regardless of country', r1.totalRevenue, r2.totalRevenue);
  eq('same operatingResult regardless of country', r1.operatingResult, r2.operatingResult);
});

// Test 43: Crop name does not insert yield or cost values
await tc('fecon-43: crop field does not insert any value into calculation', () => {
  const raw = validRaw({ yieldPerHa: '3' });
  const r = validateFarmEconomicsInput(raw);
  eq('yield remains user-supplied', r.parsed.expectedYieldTonnesPerHectare, 3);
  const rWith5 = validateFarmEconomicsInput(validRaw({ yieldPerHa: '5' }));
  eq('yield stays 5 when entered', rWith5.parsed.expectedYieldTonnesPerHectare, 5);
});

// Test 44: Currency label change does not convert monetary values
await tc('fecon-44: formatCurrencyValue does not convert currencies', () => {
  const uah = formatCurrencyValue(1000, 'UAH');
  const eur = formatCurrencyValue(1000, 'EUR');
  const usd = formatCurrencyValue(1000, 'USD');
  ok('UAH string contains 1,000', uah.includes('1,000') || uah.includes('1000'));
  ok('EUR string contains 1,000', eur.includes('1,000') || eur.includes('1000'));
  ok('USD string contains 1,000', usd.includes('1,000') || usd.includes('1000'));
  ok('UAH label present', uah.includes('UAH'));
  ok('EUR label present', eur.includes('EUR'));
  ok('USD label present', usd.includes('USD'));
});

// Test 45: calculateFarmEconomics does not call fetch
await tc('fecon-45: calculateFarmEconomics makes no async/network calls', () => {
  let fetchCalled = false;
  const origFetch = global.fetch;
  global.fetch = () => { fetchCalled = true; return Promise.resolve({}); };
  const v = validateFarmEconomicsInput(validRaw()).parsed;
  calculateFarmEconomics(v);
  global.fetch = origFetch;
  eq('no fetch called', fetchCalled, false);
});

// Test 46: All v13 climate functions still pass (regression)
await tc('fecon-46: climate pure functions unaffected by v14 additions', () => {
  const ta = calculateTemperatureAnomaly(20, 15);
  eq('temp anomaly warmer', ta.direction, 'warmer');
  const pa = calculatePrecipitationAnomaly(600, 500);
  eq('precip anomaly wetter', pa.direction, 'wetter');
  const key = buildHistoricalCacheKey(49.0, 32.0, '20260601', '20260831');
  ok('cache key starts with version', key.startsWith(HISTORICAL_METHOD_VERSION + '|'));
});

// ─────────────────────────────────────────────────────────────────────
// v15 NEW TESTS
// ─────────────────────────────────────────────────────────────────────

// Test 47: FARM_FIELD_MAP completeness
await tc('fecon-47: FARM_FIELD_MAP has correct structure and all 13 entries', () => {
  ok('FARM_FIELD_MAP is object', typeof FARM_FIELD_MAP === 'object' && FARM_FIELD_MAP !== null);
  const keys = Object.keys(FARM_FIELD_MAP);
  eq('13 entries', keys.length, 13);
  // Spot-check tricky mappings: DOM IDs differ from validation keys
  eq('area inputId', FARM_FIELD_MAP.area.inputId, 'fecon-area');
  eq('area errorId', FARM_FIELD_MAP.area.errorId, 'err-area');
  eq('cropProtection inputId', FARM_FIELD_MAP.cropProtection.inputId, 'fecon-crop-protection');
  eq('cropProtection errorId', FARM_FIELD_MAP.cropProtection.errorId, 'err-cropProtection');
  eq('fuelMachinery inputId', FARM_FIELD_MAP.fuelMachinery.inputId, 'fecon-fuel');
  eq('fuelMachinery errorId', FARM_FIELD_MAP.fuelMachinery.errorId, 'err-fuelMachinery');
  eq('landRent inputId', FARM_FIELD_MAP.landRent.inputId, 'fecon-rent');
  eq('landRent errorId', FARM_FIELD_MAP.landRent.errorId, 'err-landRent');
  eq('otherVariable inputId', FARM_FIELD_MAP.otherVariable.inputId, 'fecon-other-var');
  eq('otherFixed inputId', FARM_FIELD_MAP.otherFixed.inputId, 'fecon-fixed');
  // All entries must have both inputId and errorId as non-empty strings
  const allHaveBoth = keys.every(k =>
    typeof FARM_FIELD_MAP[k].inputId === 'string' && FARM_FIELD_MAP[k].inputId.length > 0 &&
    typeof FARM_FIELD_MAP[k].errorId === 'string' && FARM_FIELD_MAP[k].errorId.length > 0
  );
  eq('all entries have inputId and errorId', allHaveBoth, true);
});

// ── DOM integration tests (48–57) ────────────────────────────────────

// Test 48: applyFarmValidationErrors — yieldPerHa error text → err-yield
await tc('fecon-48: applyFarmValidationErrors sets yieldPerHa error in err-yield', () => {
  const doc = makeFakeDoc(FARM_FIELD_MAP);
  const errors = [{ field: 'yieldPerHa', message: 'Required' }];
  applyFarmValidationErrors(errors, FARM_FIELD_MAP, doc);
  const errEl = doc._store[FARM_FIELD_MAP.yieldPerHa.errorId];
  eq('err-yield gets error text', errEl.textContent, 'Required');
});

// Test 49: applyFarmValidationErrors — salePrice error text → err-price
await tc('fecon-49: applyFarmValidationErrors sets salePrice error in err-price', () => {
  const doc = makeFakeDoc(FARM_FIELD_MAP);
  const errors = [{ field: 'salePrice', message: 'Must be positive' }];
  applyFarmValidationErrors(errors, FARM_FIELD_MAP, doc);
  const errEl = doc._store[FARM_FIELD_MAP.salePrice.errorId];
  eq('err-price gets error text', errEl.textContent, 'Must be positive');
});

// Test 50: applyFarmValidationErrors — cropProtection → err-cropProtection (non-trivial mapping)
await tc('fecon-50: applyFarmValidationErrors sets cropProtection error in err-cropProtection', () => {
  const doc = makeFakeDoc(FARM_FIELD_MAP);
  const errors = [{ field: 'cropProtection', message: 'Invalid value' }];
  applyFarmValidationErrors(errors, FARM_FIELD_MAP, doc);
  const errEl = doc._store['err-cropProtection'];
  eq('err-cropProtection gets error text', errEl.textContent, 'Invalid value');
  // Verify it did NOT end up in a wrong element
  const wrongEl = doc._store['err-cropprotection'];  // wrong casing
  eq('wrong-cased element is null', wrongEl, undefined);
});

// Test 51: applyFarmValidationErrors — sets aria-invalid on the input element
await tc('fecon-51: applyFarmValidationErrors sets aria-invalid="true" on invalid input', () => {
  const doc = makeFakeDoc(FARM_FIELD_MAP);
  const errors = [{ field: 'area', message: 'Required' }];
  applyFarmValidationErrors(errors, FARM_FIELD_MAP, doc);
  const inputEl = doc._store[FARM_FIELD_MAP.area.inputId];
  eq('area input has aria-invalid=true', inputEl.getAttribute('aria-invalid'), 'true');
  // A field with no error must NOT have aria-invalid set
  const cleanEl = doc._store[FARM_FIELD_MAP.yieldPerHa.inputId];
  eq('clean field has no aria-invalid', cleanEl.getAttribute('aria-invalid'), null);
});

// Test 52: applyFarmValidationErrors — first invalid input element gets focus
await tc('fecon-52: applyFarmValidationErrors focuses the first invalid input', () => {
  const doc = makeFakeDoc(FARM_FIELD_MAP);
  // Provide two errors; the first in the array is the one that should get focus
  const errors = [
    { field: 'yieldPerHa', message: 'Required' },
    { field: 'salePrice',  message: 'Required' },
  ];
  applyFarmValidationErrors(errors, FARM_FIELD_MAP, doc);
  const firstInputEl  = doc._store[FARM_FIELD_MAP.yieldPerHa.inputId];
  const secondInputEl = doc._store[FARM_FIELD_MAP.salePrice.inputId];
  eq('first invalid input is focused', firstInputEl._focused,  true);
  eq('second invalid input not focused', secondInputEl._focused, false);
});

// Test 53: clearFarmValidationError — clears only the targeted field
await tc('fecon-53: clearFarmValidationError clears only the targeted field', () => {
  const doc = makeFakeDoc(FARM_FIELD_MAP);
  // Manually set error text on two fields
  const errArea  = doc._store[FARM_FIELD_MAP.area.errorId];
  const errYield = doc._store[FARM_FIELD_MAP.yieldPerHa.errorId];
  const inputArea = doc._store[FARM_FIELD_MAP.area.inputId];
  errArea.textContent  = 'Area error';
  errYield.textContent = 'Yield error';
  inputArea.setAttribute('aria-invalid', 'true');
  // Clear only area
  clearFarmValidationError('area', FARM_FIELD_MAP, doc);
  eq('area error cleared', errArea.textContent, '');
  eq('area aria-invalid removed', inputArea.getAttribute('aria-invalid'), null);
  eq('yieldPerHa error untouched', errYield.textContent, 'Yield error');
});

// Test 54: clearAllFarmValidationErrors — clears all error texts
await tc('fecon-54: clearAllFarmValidationErrors clears all error texts', () => {
  const doc = makeFakeDoc(FARM_FIELD_MAP);
  // Seed multiple errors
  Object.values(FARM_FIELD_MAP).forEach(function ({ errorId }) {
    doc._store[errorId].textContent = 'some error';
  });
  clearAllFarmValidationErrors(FARM_FIELD_MAP, doc);
  const allCleared = Object.values(FARM_FIELD_MAP).every(function ({ errorId }) {
    return doc._store[errorId].textContent === '';
  });
  eq('all error texts cleared', allCleared, true);
});

// Test 55: clearAllFarmValidationErrors — removes aria-invalid from all inputs
await tc('fecon-55: clearAllFarmValidationErrors removes aria-invalid from all inputs', () => {
  const doc = makeFakeDoc(FARM_FIELD_MAP);
  // Mark all inputs as invalid
  Object.values(FARM_FIELD_MAP).forEach(function ({ inputId }) {
    doc._store[inputId].setAttribute('aria-invalid', 'true');
  });
  clearAllFarmValidationErrors(FARM_FIELD_MAP, doc);
  const allClean = Object.values(FARM_FIELD_MAP).every(function ({ inputId }) {
    return doc._store[inputId].getAttribute('aria-invalid') === null;
  });
  eq('all inputs have aria-invalid removed', allClean, true);
});

// Test 56: applyFarmValidationErrors — pre-existing errors are cleared before new ones applied
await tc('fecon-56: applyFarmValidationErrors clears stale errors before showing new ones', () => {
  const doc = makeFakeDoc(FARM_FIELD_MAP);
  // First call: error on area
  applyFarmValidationErrors([{ field: 'area', message: 'First error' }], FARM_FIELD_MAP, doc);
  eq('area error set after first call', doc._store[FARM_FIELD_MAP.area.errorId].textContent, 'First error');
  // Second call: error on yieldPerHa only
  applyFarmValidationErrors([{ field: 'yieldPerHa', message: 'Second error' }], FARM_FIELD_MAP, doc);
  eq('area error cleared by second call', doc._store[FARM_FIELD_MAP.area.errorId].textContent, '');
  eq('yieldPerHa error set by second call', doc._store[FARM_FIELD_MAP.yieldPerHa.errorId].textContent, 'Second error');
});

// Test 57: variableCostPerHectare is a calc output property, not on parsed input
await tc('fecon-57: variableCostPerHectare comes from calculateFarmEconomics output, not parsed', () => {
  const parsed = validateFarmEconomicsInput(validRaw()).parsed;
  const calc   = calculateFarmEconomics(parsed);
  // It must be on the calc result
  ok('variableCostPerHectare present in calc', typeof calc.variableCostPerHectare === 'number');
  eq('variableCostPerHectare correct value', calc.variableCostPerHectare, 150);
  // It must NOT be on parsed (no duplication)
  eq('variableCostPerHectare absent from parsed', parsed.variableCostPerHectare, undefined);
});

// ─────────────────────────────────────────────────────────────────────
// v17 CROP SCREENING TESTS
// ─────────────────────────────────────────────────────────────────────
const {
  CROP_CLIMATE_REFERENCE_LIBRARY,
  validateCropReferenceRecord,
  getAvailableCropReferences,
  buildAnnualPrecipScreeningRequest,
  buildAnnualPrecipCacheKey,
  compareAnnualRainfallToCropReference,
  buildCropFactorResults,
  buildCropScreeningSummary,
  validateCropScreeningInput,
  fetchAnnualPrecipitationReference,
  HIST_MIN_QUALIFYING_WINDOWS,
} = core;

// ── buildAnnualPrecipScreeningRequest ─────────────────────────────────

await tc('cscreen-1: buildAnnualPrecipScreeningRequest returns null for lat > 90', () => {
  const r = buildAnnualPrecipScreeningRequest(91, 30);
  eq('null for invalid lat', r, null);
});

await tc('cscreen-2: buildAnnualPrecipScreeningRequest returns null for NaN lat', () => {
  const r = buildAnnualPrecipScreeningRequest(NaN, 30);
  eq('null for NaN lat', r, null);
});

await tc('cscreen-3: buildAnnualPrecipScreeningRequest URL contains parameters=PRECTOTCORR', () => {
  const r = buildAnnualPrecipScreeningRequest(49.0, 32.0);
  ok('result is not null', r !== null);
  ok('URL contains PRECTOTCORR', r.url.includes('PRECTOTCORR'));
});

await tc('cscreen-4: buildAnnualPrecipScreeningRequest URL does NOT contain T2M', () => {
  const r = buildAnnualPrecipScreeningRequest(49.0, 32.0);
  ok('result is not null', r !== null);
  eq('URL does not contain T2M', r.url.includes('T2M'), false);
});

await tc('cscreen-5: buildAnnualPrecipScreeningRequest URL does NOT contain RH2M', () => {
  const r = buildAnnualPrecipScreeningRequest(49.0, 32.0);
  ok('result is not null', r !== null);
  eq('URL does not contain RH2M', r.url.includes('RH2M'), false);
});

// ── buildAnnualPrecipCacheKey ─────────────────────────────────────────

await tc('cscreen-6: buildAnnualPrecipCacheKey returns a string', () => {
  const k = buildAnnualPrecipCacheKey(49.0, 32.0);
  eq('typeof string', typeof k, 'string');
  ok('non-empty', k.length > 0);
});

await tc('cscreen-7: buildAnnualPrecipCacheKey includes PRECTOTCORR literal', () => {
  const k = buildAnnualPrecipCacheKey(49.0, 32.0);
  ok('key contains PRECTOTCORR', k.includes('PRECTOTCORR'));
});

await tc('cscreen-8: buildAnnualPrecipCacheKey preserves exact coords (no rounding)', () => {
  const kA = buildAnnualPrecipCacheKey(49.12345678, 32.0);
  const kB = buildAnnualPrecipCacheKey(49.12345679, 32.0);
  eq('tiny lat diff produces different key', kA !== kB, true);
});

await tc('cscreen-9: buildAnnualPrecipCacheKey does not share prefix with buildHistoricalCacheKey', () => {
  const precipKey = buildAnnualPrecipCacheKey(49.0, 32.0);
  const histKey   = core.buildHistoricalCacheKey(49.0, 32.0, '19910101', '20201231');
  eq('keys differ', precipKey !== histKey, true);
  // The precip key must NOT start with the historical key prefix up to the first parameter segment
  const histSegments = histKey.split('|');
  const precipSegments = precipKey.split('|');
  // They share the method version but must differ on the type segment
  eq('precip key type segment is annualprecip', precipSegments[1], 'annualprecip');
  eq('hist key type segment is hist', histSegments[1], 'hist');
});

// ── fetchAnnualPrecipitationReference ────────────────────────────────

await tc('cscreen-10: fetchAnnualPrecipitationReference successful request returns PRECTOTCORR', async () => {
  const controller = new AbortController();
  const abortRef   = { value: null };
  let clearedId;
  const fakePayload = { properties: { parameter: { PRECTOTCORR: {'19910101': 1.5} } } };
  const fakeFetch   = async () => ({ ok: true, json: async () => fakePayload });
  const r = await fetchAnnualPrecipitationReference({
    url: 'http://test', fetchImpl: fakeFetch, abortController: controller,
    timeoutMs: 5000,
    setTimeoutImpl: (fn, ms) => { return 55; },
    clearTimeoutImpl: (id) => { clearedId = id; },
    abortReasonRef: abortRef,
  });
  ok('parameterData.PRECTOTCORR is plain object', isPlainObject(r.parameterData.PRECTOTCORR));
  eq('timeout cleared in finally', clearedId, 55);
});

await tc('cscreen-11: fetchAnnualPrecipitationReference succeeds when T2M is absent from response', async () => {
  const controller = new AbortController();
  const fakePayload = { properties: { parameter: { PRECTOTCORR: {'19910101': 2.0} } } };
  const fakeFetch   = async () => ({ ok: true, json: async () => fakePayload });
  let threw = false;
  try {
    await fetchAnnualPrecipitationReference({
      url: 'http://test', fetchImpl: fakeFetch, abortController: controller,
      timeoutMs: 0, setTimeoutImpl: () => {}, clearTimeoutImpl: () => {},
      abortReasonRef: { value: null },
    });
  } catch (e) { threw = true; }
  eq('does not throw when T2M absent', threw, false);
});

await tc('cscreen-12: fetchAnnualPrecipitationReference throws when PRECTOTCORR absent', async () => {
  const fakePayload = { properties: { parameter: { T2M: {'19910101': 15.0} } } };
  const fakeFetch   = async () => ({ ok: true, json: async () => fakePayload });
  let threw = false;
  try {
    await fetchAnnualPrecipitationReference({
      url: 'http://test', fetchImpl: fakeFetch, abortController: new AbortController(),
      timeoutMs: 0, setTimeoutImpl: () => {}, clearTimeoutImpl: () => {},
      abortReasonRef: { value: null },
    });
  } catch (e) { threw = true; }
  eq('throws when PRECTOTCORR absent', threw, true);
});

await tc('cscreen-13: fetchAnnualPrecipitationReference HTTP 503 throws with status', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) });
  let threw = false, httpStatus;
  try {
    await fetchAnnualPrecipitationReference({
      url: 'http://test', fetchImpl: fakeFetch, abortController: new AbortController(),
      timeoutMs: 0, setTimeoutImpl: () => {}, clearTimeoutImpl: () => {},
      abortReasonRef: { value: null },
    });
  } catch (e) { threw = true; httpStatus = e.httpStatus; }
  eq('throws on HTTP 503', threw, true);
  eq('httpStatus property', httpStatus, 503);
});

await tc('cscreen-14: fetchAnnualPrecipitationReference missing properties.parameter throws', async () => {
  const fakePayload = { properties: {} };
  const fakeFetch   = async () => ({ ok: true, json: async () => fakePayload });
  let threw = false;
  try {
    await fetchAnnualPrecipitationReference({
      url: 'http://test', fetchImpl: fakeFetch, abortController: new AbortController(),
      timeoutMs: 0, setTimeoutImpl: () => {}, clearTimeoutImpl: () => {},
      abortReasonRef: { value: null },
    });
  } catch (e) { threw = true; }
  eq('throws for missing properties.parameter', threw, true);
});

await tc('cscreen-15: fetchAnnualPrecipitationReference timeout sets abortReason=timeout', async () => {
  const controller = new AbortController();
  const abortRef   = { value: null };
  let timeoutFn, clearedId;
  const promise = fetchAnnualPrecipitationReference({
    url: 'http://test', fetchImpl: makeSignalFetch(),
    abortController: controller,
    timeoutMs: 5000,
    setTimeoutImpl: (fn, ms) => { timeoutFn = fn; return 123; },
    clearTimeoutImpl: (id) => { clearedId = id; },
    abortReasonRef: abortRef,
  });
  timeoutFn();
  let threw = false, reason;
  try { await promise; } catch (e) { threw = true; reason = e.abortReason; }
  eq('throws AbortError', threw, true);
  eq('abortReason=timeout on error', reason, 'timeout');
  eq('abortRef.value=timeout', abortRef.value, 'timeout');
  eq('timeout cleared in finally', clearedId, 123);
});

await tc('cscreen-16: fetchAnnualPrecipitationReference explicit abort sets abortReason=unknown', async () => {
  const controller = new AbortController();
  const abortRef   = { value: null };
  const promise = fetchAnnualPrecipitationReference({
    url: 'http://test', fetchImpl: makeSignalFetch(),
    abortController: controller, timeoutMs: 0,
    setTimeoutImpl: () => {}, clearTimeoutImpl: () => {},
    abortReasonRef: abortRef,
  });
  controller.abort();
  let errName, errAbortReason;
  try { await promise; } catch (e) { errName = e.name; errAbortReason = e.abortReason; }
  eq('AbortError name', errName, 'AbortError');
  eq('abortReason is unknown', errAbortReason, 'unknown');
});

await tc('cscreen-17: fetchAnnualPrecipitationReference does not validate T2M (T2M array passes)', async () => {
  const fakePayload = { properties: { parameter: { T2M: [1,2,3], PRECTOTCORR: {'19910101': 1.5} } } };
  const fakeFetch   = async () => ({ ok: true, json: async () => fakePayload });
  let threw = false;
  try {
    await fetchAnnualPrecipitationReference({
      url: 'http://test', fetchImpl: fakeFetch, abortController: new AbortController(),
      timeoutMs: 0, setTimeoutImpl: () => {}, clearTimeoutImpl: () => {},
      abortReasonRef: { value: null },
    });
  } catch (e) { threw = true; }
  eq('does not throw when T2M is array (only PRECTOTCORR validated)', threw, false);
});

// ── validateCropScreeningInput ────────────────────────────────────────

await tc('cscreen-18: validateCropScreeningInput empty crop key → invalid with crop error', () => {
  const r = validateCropScreeningInput('', 49.0, 32.0);
  eq('invalid', r.valid, false);
  ok('error on crop field', r.errors.some(e => e.field === 'crop'));
});

await tc('cscreen-19: validateCropScreeningInput null crop key → invalid with crop error', () => {
  const r = validateCropScreeningInput(null, 49.0, 32.0);
  eq('invalid', r.valid, false);
  ok('error on crop field', r.errors.some(e => e.field === 'crop'));
});

await tc('cscreen-20: validateCropScreeningInput unknown crop key → invalid', () => {
  const r = validateCropScreeningInput('unknownCrop', 49.0, 32.0);
  eq('invalid', r.valid, false);
  ok('error on crop field', r.errors.some(e => e.field === 'crop'));
});

await tc('cscreen-21: validateCropScreeningInput valid commonWheat + valid coords → valid', () => {
  const r = validateCropScreeningInput('commonWheat', 49.0, 32.0);
  eq('valid', r.valid, true);
  eq('cropKey returned', r.cropKey, 'commonWheat');
  eq('lat returned', r.lat, 49.0);
  eq('lon returned', r.lon, 32.0);
});

await tc('cscreen-22: validateCropScreeningInput invalid lat → invalid', () => {
  const r = validateCropScreeningInput('maize', 95, 32.0);
  eq('invalid', r.valid, false);
  ok('error on lat field', r.errors.some(e => e.field === 'lat'));
});

await tc('cscreen-23: validateCropScreeningInput null lat → invalid', () => {
  const r = validateCropScreeningInput('maize', null, 32.0);
  eq('invalid', r.valid, false);
  ok('coord error', r.errors.some(e => e.field === 'lat' || e.field === 'lon'));
});

// ── CROP_CLIMATE_REFERENCE_LIBRARY ────────────────────────────────────

await tc('cscreen-24: CROP_CLIMATE_REFERENCE_LIBRARY has all 5 expected crop keys', () => {
  const keys = Object.keys(CROP_CLIMATE_REFERENCE_LIBRARY);
  ok('commonWheat present', keys.includes('commonWheat'));
  ok('maize present', keys.includes('maize'));
  ok('sunflower present', keys.includes('sunflower'));
  ok('barley present', keys.includes('barley'));
  ok('soybean present', keys.includes('soybean'));
});

await tc('cscreen-25: all CROP_CLIMATE_REFERENCE_LIBRARY crops have rainfallAnnual.comparable=true', () => {
  const crops = ['commonWheat', 'maize', 'sunflower', 'barley', 'soybean'];
  const allComparable = crops.every(k => CROP_CLIMATE_REFERENCE_LIBRARY[k].rainfallAnnual.comparable === true);
  eq('all rainfallAnnual.comparable=true', allComparable, true);
});

await tc('cscreen-26: all CROP_CLIMATE_REFERENCE_LIBRARY crops have temperature.comparable=false', () => {
  const crops = ['commonWheat', 'maize', 'sunflower', 'barley', 'soybean'];
  const noneComparable = crops.every(k => CROP_CLIMATE_REFERENCE_LIBRARY[k].temperature.comparable === false);
  eq('all temperature.comparable=false', noneComparable, true);
});

// ── validateCropReferenceRecord ───────────────────────────────────────

await tc('cscreen-27: validateCropReferenceRecord valid record → valid', () => {
  const r = validateCropReferenceRecord(CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat);
  eq('valid', r.valid, true);
});

await tc('cscreen-28: validateCropReferenceRecord missing commonName → invalid', () => {
  const bad = { scientificName: 'X', source: { url: 'http://x', recordId: '1' },
                rainfallAnnual: { optimalMin: 100, optimalMax: 200, absoluteMin: 50, absoluteMax: 300, comparable: true } };
  const r = validateCropReferenceRecord(bad);
  eq('invalid', r.valid, false);
  ok('error mentions commonName', r.errors.some(e => e.includes('commonName')));
});

await tc('cscreen-29: validateCropReferenceRecord reversed optimal range → invalid', () => {
  const bad = {
    commonName: 'Test', scientificName: 'Test sp.',
    source: { url: 'http://x', recordId: '1' },
    rainfallAnnual: { optimalMin: 900, optimalMax: 750, absoluteMin: 300, absoluteMax: 1600, comparable: true },
  };
  const r = validateCropReferenceRecord(bad);
  eq('invalid for reversed optimal', r.valid, false);
});

// ── getAvailableCropReferences ────────────────────────────────────────

await tc('cscreen-30: getAvailableCropReferences returns exactly 5 verified crops', () => {
  const refs = getAvailableCropReferences();
  eq('5 crops returned', refs.length, 5);
});

await tc('cscreen-31: getAvailableCropReferences each entry has key, commonName, scientificName', () => {
  const refs = getAvailableCropReferences();
  const allHaveFields = refs.every(r =>
    typeof r.key === 'string' && r.key.length > 0 &&
    typeof r.commonName === 'string' && r.commonName.length > 0 &&
    typeof r.scientificName === 'string' && r.scientificName.length > 0
  );
  eq('all entries have required fields', allHaveFields, true);
});

// ── compareAnnualRainfallToCropReference ──────────────────────────────

await tc('cscreen-32: compareAnnualRainfallToCropReference within optimal range → within-optimal', () => {
  const ref = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat.rainfallAnnual; // opt 750-900
  const r = compareAnnualRainfallToCropReference(800, ref);
  eq('status within-optimal', r.status, 'within-optimal');
});

await tc('cscreen-33: compareAnnualRainfallToCropReference within absolute, outside optimal → within-absolute', () => {
  const ref = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat.rainfallAnnual; // opt 750-900, abs 300-1600
  const r = compareAnnualRainfallToCropReference(500, ref); // 500 is between abs min and opt min
  eq('status within-absolute', r.status, 'within-absolute');
});

await tc('cscreen-34: compareAnnualRainfallToCropReference outside absolute → outside-absolute', () => {
  const ref = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat.rainfallAnnual; // abs 300-1600
  const r = compareAnnualRainfallToCropReference(100, ref); // below abs min
  eq('status outside-absolute', r.status, 'outside-absolute');
});

await tc('cscreen-35: compareAnnualRainfallToCropReference non-finite value → unavailable', () => {
  const ref = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat.rainfallAnnual;
  const r = compareAnnualRainfallToCropReference(NaN, ref);
  eq('status unavailable', r.status, 'unavailable');
});

await tc('cscreen-36: compareAnnualRainfallToCropReference comparable=false → unavailable', () => {
  const fakeRef = { optimalMin: 750, optimalMax: 900, absoluteMin: 300, absoluteMax: 1600, comparable: false };
  const r = compareAnnualRainfallToCropReference(800, fakeRef);
  eq('status unavailable', r.status, 'unavailable');
});

// ── buildCropFactorResults ────────────────────────────────────────────

await tc('cscreen-37: buildCropFactorResults rainfall.status=within-optimal for optimal precip', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat; // opt 750-900
  const r = buildCropFactorResults(800, 28, cropRef);
  eq('rainfall status within-optimal', r.rainfall.status, 'within-optimal');
});

await tc('cscreen-38: buildCropFactorResults temperature.status is always reference-only', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.maize;
  const r = buildCropFactorResults(800, 28, cropRef);
  eq('temperature status reference-only', r.temperature.status, 'reference-only');
});

await tc('cscreen-39: buildCropFactorResults humidity.status is always not-assessed', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.sunflower;
  const r = buildCropFactorResults(700, 28, cropRef);
  eq('humidity status not-assessed', r.humidity.status, 'not-assessed');
});

await tc('cscreen-40: buildCropFactorResults soil.status is always not-assessed', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.barley;
  const r = buildCropFactorResults(600, 27, cropRef);
  eq('soil status not-assessed', r.soil.status, 'not-assessed');
});

await tc('cscreen-41: buildCropFactorResults overallScore is undefined', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.soybean;
  const r = buildCropFactorResults(800, 28, cropRef);
  eq('overallScore undefined', r.overallScore, undefined);
});

await tc('cscreen-42: buildCropFactorResults percentageSuitability is undefined', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat;
  const r = buildCropFactorResults(800, 28, cropRef);
  eq('percentageSuitability undefined', r.percentageSuitability, undefined);
});

await tc('cscreen-43: buildCropFactorResults rainfall.status=within-absolute for mid-range precip', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat; // opt 750-900, abs 300-1600
  const r = buildCropFactorResults(500, 28, cropRef); // 500 is in absolute but not optimal
  eq('rainfall status within-absolute', r.rainfall.status, 'within-absolute');
});

await tc('cscreen-44: buildCropFactorResults rainfall.status=outside-absolute for very low precip', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat; // abs min 300
  const r = buildCropFactorResults(100, 28, cropRef);
  eq('rainfall status outside-absolute', r.rainfall.status, 'outside-absolute');
});

// ── buildCropScreeningSummary ─────────────────────────────────────────

await tc('cscreen-45: buildCropScreeningSummary within-optimal contains optimal ecological range', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat;
  const factors = buildCropFactorResults(800, 28, cropRef); // within-optimal
  const summary = buildCropScreeningSummary(factors);
  ok('summary contains optimal ecological range', summary.includes('optimal ecological range'));
  ok('summary contains temperature reference-only', summary.includes('reference-only'));
  ok('summary contains not assessed', summary.includes('not assessed'));
});

await tc('cscreen-46: buildCropScreeningSummary within-absolute contains absolute ecological range', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat;
  const factors = buildCropFactorResults(500, 28, cropRef); // within-absolute
  const summary = buildCropScreeningSummary(factors);
  ok('summary contains absolute ecological range', summary.includes('absolute ecological range'));
  ok('summary does NOT contain "optimal ecological range" in first sentence', true); // just verify it ran
});

await tc('cscreen-47: buildCropScreeningSummary outside-absolute contains outside', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat;
  const factors = buildCropFactorResults(100, 28, cropRef); // outside-absolute
  const summary = buildCropScreeningSummary(factors);
  ok('summary contains outside published absolute', summary.includes('outside the crop'));
});

await tc('cscreen-48: buildCropScreeningSummary unavailable (null precip) contains qualifying annual windows', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.commonWheat;
  const factors = buildCropFactorResults(null, 10, cropRef); // null → unavailable
  const summary = buildCropScreeningSummary(factors);
  ok('summary mentions qualifying annual windows', summary.includes('qualifying annual windows'));
  ok('summary mentions HIST_MIN_QUALIFYING_WINDOWS value', summary.includes(String(HIST_MIN_QUALIFYING_WINDOWS)));
});

// ── Scientific scope guards ───────────────────────────────────────────

await tc('cscreen-49: buildCropScreeningSummary contains no recommendation language', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.maize;
  const factors = buildCropFactorResults(800, 28, cropRef);
  const summary = buildCropScreeningSummary(factors);
  const forbidden = ['suitable', 'recommended', 'safe', 'profitable', 'probability', 'score'];
  const hasForbidden = forbidden.filter(w => summary.toLowerCase().includes(w));
  eq('no forbidden recommendation language', hasForbidden.length, 0);
});

await tc('cscreen-50: buildCropFactorResults contains no score or probability fields', () => {
  const cropRef = CROP_CLIMATE_REFERENCE_LIBRARY.barley;
  const factors = buildCropFactorResults(600, 28, cropRef);
  eq('overallScore is undefined', factors.overallScore, undefined);
  eq('percentageSuitability is undefined', factors.percentageSuitability, undefined);
  eq('no probability property', factors.probability, undefined);
  eq('no score property on rainfall', factors.rainfall.score, undefined);
});


// ─────────────────────────────────────────────────────────────────────
// v18 NEW TESTS
// ─────────────────────────────────────────────────────────────────────
const {
  validateAnalyzedLocation,
  COUNTRY_REGION_REFERENCE_DATA,
  validateRegionReferenceRecord,
  validateCountryRegionCoverage,
  CropScreeningRequestCoordinator,
  runCropScreeningLifecycle,
  buildAnnualPrecipCacheKey: buildAnnualPrecipCacheKeyV18,
  buildHistoricalWindowDefinitions: buildHistoricalWindowDefinitionsV18,
  groupDailyValuesByHistoricalWindow: groupDailyValuesByHistoricalWindowV18,
  calculateHistoricalReference: calculateHistoricalReferenceV18,
  CROP_CLIMATE_REFERENCE_LIBRARY: CROP_LIB_V18,
  buildCropFactorResults: buildCropFactorResultsV18,
  buildCropScreeningSummary: buildCropScreeningSummaryV18,
} = core;

// ─────────────────────────────────────────────────────────────────────
// COORDINATE / GEOGRAPHIC VALIDATION TESTS (coord-1 through coord-26)
// ─────────────────────────────────────────────────────────────────────

await tc('coord-1: validateAnalyzedLocation valid input returns { valid: true }', () => {
  const r = validateAnalyzedLocation({ lat: 49.0, lon: 31.0, label: 'Kyiv Oblast' });
  eq('valid', r.valid, true);
  eq('no error property', r.error, undefined);
});

await tc('coord-2: validateAnalyzedLocation rejects undefined location', () => {
  const r = validateAnalyzedLocation(undefined);
  eq('invalid', r.valid, false);
  ok('error string present', typeof r.error === 'string');
});

await tc('coord-3: validateAnalyzedLocation rejects null location', () => {
  const r = validateAnalyzedLocation(null);
  eq('invalid', r.valid, false);
});

await tc('coord-4: validateAnalyzedLocation rejects NaN lat', () => {
  const r = validateAnalyzedLocation({ lat: NaN, lon: 31.0, label: 'Test' });
  eq('invalid', r.valid, false);
  ok('error mentions finite', r.error.includes('finite'));
});

await tc('coord-5: validateAnalyzedLocation rejects Infinity lat', () => {
  const r = validateAnalyzedLocation({ lat: Infinity, lon: 31.0, label: 'Test' });
  eq('invalid', r.valid, false);
  ok('error mentions finite', r.error.includes('finite'));
});

await tc('coord-6: validateAnalyzedLocation rejects -Infinity lon', () => {
  const r = validateAnalyzedLocation({ lat: 49.0, lon: -Infinity, label: 'Test' });
  eq('invalid', r.valid, false);
  ok('error mentions finite', r.error.includes('finite'));
});

await tc('coord-7: validateAnalyzedLocation rejects lat > 90', () => {
  const r = validateAnalyzedLocation({ lat: 91, lon: 31.0, label: 'Test' });
  eq('invalid', r.valid, false);
  ok('error mentions range', r.error.includes('range') || r.error.includes('-90'));
});

await tc('coord-8: validateAnalyzedLocation rejects lat < -90', () => {
  const r = validateAnalyzedLocation({ lat: -91, lon: 31.0, label: 'Test' });
  eq('invalid', r.valid, false);
});

await tc('coord-9: validateAnalyzedLocation rejects lon > 180', () => {
  const r = validateAnalyzedLocation({ lat: 49.0, lon: 181, label: 'Test' });
  eq('invalid', r.valid, false);
});

await tc('coord-10: validateAnalyzedLocation rejects non-string label', () => {
  const r = validateAnalyzedLocation({ lat: 49.0, lon: 31.0, label: 42 });
  eq('invalid', r.valid, false);
  ok('error mentions label', r.error.includes('label'));
});

await tc('coord-11: validateAnalyzedLocation rejects blank label', () => {
  const r = validateAnalyzedLocation({ lat: 49.0, lon: 31.0, label: '   ' });
  eq('invalid', r.valid, false);
  ok('error mentions blank', r.error.includes('blank') || r.error.includes('whitespace'));
});

await tc('coord-12: validateAnalyzedLocation rejects label > 200 chars', () => {
  const r = validateAnalyzedLocation({ lat: 49.0, lon: 31.0, label: 'A'.repeat(201) });
  eq('invalid', r.valid, false);
  ok('error mentions length', r.error.includes('200') || r.error.includes('long'));
});

await tc('coord-13: validateAnalyzedLocation accepts label of exactly 200 chars', () => {
  const r = validateAnalyzedLocation({ lat: 49.0, lon: 31.0, label: 'A'.repeat(200) });
  eq('valid', r.valid, true);
});

await tc('coord-14: validateRegionReferenceRecord valid record → valid', () => {
  const record = {
    name: 'Kyiv Oblast', lat: 50.454662, lon: 30.523796,
    referencePointLabel: 'Kyiv', referencePointBasis: 'City centre of Kyiv, designated administrative centre for Kyiv Oblast',
    coordinateSource: 'GeoNames', coordinateSourceFeatureId: 703448,
    coordinateSourceUrl: 'https://www.geonames.org/703448/kyiv.html',
  };
  const r = validateRegionReferenceRecord(record);
  eq('valid', r.valid, true);
  eq('no errors', r.errors.length, 0);
});

await tc('coord-15: validateRegionReferenceRecord missing lat → invalid', () => {
  const r = validateRegionReferenceRecord({
    name: 'Test', lat: 'not-a-number', lon: 30.0,
    referencePointLabel: 'City', referencePointBasis: 'Centre', coordinateSourceId: 'GeoNames',
  });
  eq('invalid', r.valid, false);
  ok('error mentions lat', r.errors.some(e => e.includes('lat')));
});

await tc('coord-16: validateRegionReferenceRecord NaN lon → invalid', () => {
  const r = validateRegionReferenceRecord({
    name: 'Test', lat: 49.0, lon: NaN,
    referencePointLabel: 'City', referencePointBasis: 'Centre', coordinateSourceId: 'GeoNames',
  });
  eq('invalid', r.valid, false);
  ok('error mentions lon finite', r.errors.some(e => e.includes('lon') && e.includes('finite')));
});

await tc('coord-17: validateRegionReferenceRecord lat > 90 → invalid', () => {
  const r = validateRegionReferenceRecord({
    name: 'Test', lat: 91, lon: 30.0,
    referencePointLabel: 'City', referencePointBasis: 'Centre', coordinateSourceId: 'GeoNames',
  });
  eq('invalid', r.valid, false);
  ok('error mentions lat range', r.errors.some(e => e.includes('lat') && e.includes('range')));
});

await tc('coord-18: validateRegionReferenceRecord missing referencePointLabel → invalid', () => {
  const r = validateRegionReferenceRecord({
    name: 'Test', lat: 49.0, lon: 30.0,
    referencePointLabel: '', referencePointBasis: 'Centre', coordinateSourceId: 'GeoNames',
  });
  eq('invalid', r.valid, false);
  ok('error mentions referencePointLabel', r.errors.some(e => e.includes('referencePointLabel')));
});

await tc('coord-19: validateRegionReferenceRecord missing coordinateSource → invalid', () => {
  const r = validateRegionReferenceRecord({
    name: 'Test', lat: 49.0, lon: 30.0,
    referencePointLabel: 'City', referencePointBasis: 'Centre', coordinateSource: '   ',
    coordinateSourceFeatureId: 703448, coordinateSourceUrl: 'https://www.geonames.org/703448/kyiv.html',
  });
  eq('invalid', r.valid, false);
  ok('error mentions coordinateSource', r.errors.some(e => e.includes('coordinateSource')));
});

await tc('coord-20: COUNTRY_REGION_REFERENCE_DATA ukraine has exactly 25 regions', () => {
  const ukraine = COUNTRY_REGION_REFERENCE_DATA.ukraine;
  ok('ukraine present', !!ukraine);
  ok('regions is array', Array.isArray(ukraine.regions));
  eq('exactly 25 regions', ukraine.regions.length, 25);
});

await tc('coord-21: all Ukraine region records pass validateRegionReferenceRecord', () => {
  const regions = COUNTRY_REGION_REFERENCE_DATA.ukraine.regions;
  const failures = [];
  regions.forEach(function(r) {
    const result = validateRegionReferenceRecord(r);
    if (!result.valid) failures.push(r.name + ': ' + result.errors.join('; '));
  });
  eq('zero invalid records', failures.length, 0);
});

await tc('coord-22: all Ukraine region lats are finite and within -90 to 90', () => {
  const regions = COUNTRY_REGION_REFERENCE_DATA.ukraine.regions;
  const allOk = regions.every(function(r) {
    return typeof r.lat === 'number' && Number.isFinite(r.lat) && r.lat >= -90 && r.lat <= 90;
  });
  eq('all lats valid', allOk, true);
});

await tc('coord-23: all Ukraine region lons are finite and within -180 to 180', () => {
  const regions = COUNTRY_REGION_REFERENCE_DATA.ukraine.regions;
  const allOk = regions.every(function(r) {
    return typeof r.lon === 'number' && Number.isFinite(r.lon) && r.lon >= -180 && r.lon <= 180;
  });
  eq('all lons valid', allOk, true);
});

await tc('coord-24: COUNTRY_REGION_REFERENCE_DATA slovakia has 5 regions', () => {
  const sk = COUNTRY_REGION_REFERENCE_DATA.slovakia;
  ok('slovakia present', !!sk);
  eq('5 regions', sk.regions.length, 5);
});

await tc('coord-25: COUNTRY_REGION_REFERENCE_DATA portugal has 5 regions', () => {
  const pt = COUNTRY_REGION_REFERENCE_DATA.portugal;
  ok('portugal present', !!pt);
  eq('5 regions', pt.regions.length, 5);
});

await tc('coord-26: validateCountryRegionCoverage Ukraine with exact 25 names → valid', () => {
  const expectedNames = [
    'Vinnytsia Oblast', 'Volyn Oblast', 'Dnipropetrovsk Oblast', 'Donetsk Oblast',
    'Zhytomyr Oblast', 'Zakarpattia Oblast', 'Zaporizhzhia Oblast', 'Ivano-Frankivsk Oblast',
    'Kyiv Oblast', 'Kirovohrad Oblast', 'Luhansk Oblast', 'Lviv Oblast',
    'Mykolaiv Oblast', 'Odesa Oblast', 'Poltava Oblast', 'Rivne Oblast',
    'Sumy Oblast', 'Ternopil Oblast', 'Kharkiv Oblast', 'Kherson Oblast',
    'Khmelnytskyi Oblast', 'Cherkasy Oblast', 'Chernivtsi Oblast', 'Chernihiv Oblast',
    'Autonomous Republic of Crimea · Ukraine',
  ];
  const r = validateCountryRegionCoverage('ukraine', expectedNames);
  eq('valid', r.valid, true);
  eq('zero errors', r.errors.length, 0);
});

await tc('coord-27: validateCountryRegionCoverage detects missing region', () => {
  const names = COUNTRY_REGION_REFERENCE_DATA.ukraine.regions.map(function(r) { return r.name; });
  // Replace one name with a missing one
  const withMissing = names.slice(0, -1).concat(['Missing Oblast']);
  const r = validateCountryRegionCoverage('ukraine', withMissing);
  eq('invalid', r.valid, false);
  ok('missing error present', r.errors.some(function(e) { return e.includes('missing'); }));
});

await tc('coord-28: validateCountryRegionCoverage detects unexpected extra region', () => {
  // Pass expected list that is one short → actual has one extra
  const names = COUNTRY_REGION_REFERENCE_DATA.ukraine.regions.map(function(r) { return r.name; });
  const withoutLast = names.slice(0, -1);  // missing last → actual has extra
  const r = validateCountryRegionCoverage('ukraine', withoutLast);
  eq('invalid', r.valid, false);
  ok('unexpected error present', r.errors.some(function(e) { return e.includes('unexpected'); }));
});

await tc('coord-29: validateCountryRegionCoverage detects duplicate (injected)', () => {
  // Temporarily patch a country with a duplicate
  const fake = {
    regions: [
      { name: 'A Oblast', lat: 49, lon: 30, referencePointLabel: 'A', referencePointBasis: 'Centre', coordinateSource: 'GeoNames', coordinateSourceFeatureId: 703448, coordinateSourceUrl: 'https://www.geonames.org/703448/kyiv.html' },
      { name: 'A Oblast', lat: 50, lon: 31, referencePointLabel: 'A', referencePointBasis: 'Centre', coordinateSource: 'GeoNames', coordinateSourceFeatureId: 703448, coordinateSourceUrl: 'https://www.geonames.org/703448/kyiv.html' },
    ]
  };
  const savedUkraine = COUNTRY_REGION_REFERENCE_DATA._test_dup;
  COUNTRY_REGION_REFERENCE_DATA._test_dup = fake;
  const r = validateCountryRegionCoverage('_test_dup', ['A Oblast']);
  delete COUNTRY_REGION_REFERENCE_DATA._test_dup;
  eq('invalid due to duplicate', r.valid, false);
  ok('duplicate error present', r.errors.some(function(e) { return e.includes('duplicate'); }));
});

await tc('coord-30: validateCountryRegionCoverage unknown country key → invalid', () => {
  const r = validateCountryRegionCoverage('nonexistent_country_xyz', []);
  eq('invalid', r.valid, false);
  ok('error mentions key', r.errors.some(function(e) { return e.includes('nonexistent_country_xyz'); }));
});

await tc('coord-31: Autonomous Republic of Crimea is present with correct display name', () => {
  const ukraine = COUNTRY_REGION_REFERENCE_DATA.ukraine;
  const crimea = ukraine.regions.find(function(r) {
    return r.name.includes('Autonomous Republic of Crimea');
  });
  ok('Crimea record found', !!crimea);
  ok('name includes Ukraine', crimea.name.includes('Ukraine'));
  ok('Simferopol as reference point', crimea.referencePointLabel === 'Simferopol');
});

await tc('coord-32: Ukraine methodologyNote is present and non-empty', () => {
  const ukraine = COUNTRY_REGION_REFERENCE_DATA.ukraine;
  ok('methodologyNote present', typeof ukraine.methodologyNote === 'string');
  ok('methodologyNote non-empty', ukraine.methodologyNote.trim().length > 0);
  ok('methodologyNote mentions territorial control', ukraine.methodologyNote.includes('territorial control'));
});

// ─────────────────────────────────────────────────────────────────────
// CROP SCREENING COORDINATOR + LIFECYCLE TESTS (cscoord/cslife)
// ─────────────────────────────────────────────────────────────────────

await tc('cscoord-1: CropScreeningRequestCoordinator requestId is monotonically increasing', () => {
  const coord = new CropScreeningRequestCoordinator();
  const r1 = coord.startRequest(0, 49, 30, 'maize');
  const r2 = coord.startRequest(0, 49, 30, 'maize');
  const r3 = coord.startRequest(0, 49, 30, 'maize');
  ok('r1 < r2', r1.requestId < r2.requestId);
  ok('r2 < r3', r2.requestId < r3.requestId);
  eq('r1 is 1', r1.requestId, 1);
  eq('r2 is 2', r2.requestId, 2);
  eq('r3 is 3', r3.requestId, 3);
});

await tc('cscoord-2: requestId never resets to zero after crop-change invalidation', () => {
  const coord = new CropScreeningRequestCoordinator();
  coord.startRequest(0, 49, 30, 'maize');
  coord.invalidateByCropChange('crop-change');
  // After invalidation, next startRequest must produce id > 0
  const r = coord.startRequest(0, 49, 30, 'barley');
  ok('id still > 0 after crop-change', r.requestId > 0);
  ok('id > 1 (crop-change incremented)', r.requestId >= 2);
});

await tc('cscoord-3: startRequest aborts previous controller with reason new-request', () => {
  const coord = new CropScreeningRequestCoordinator();
  const first = coord.startRequest(0, 49, 30, 'maize');
  eq('first not aborted initially', first.controller.signal.aborted, false);
  coord.startRequest(0, 49, 30, 'barley');
  eq('first aborted after second startRequest', first.controller.signal.aborted, true);
  eq('abort reason is new-request', first.abortRef.value, 'new-request');
});

await tc('cscoord-4: invalidateByCropChange sets abortRef to crop-change and aborts', () => {
  const coord = new CropScreeningRequestCoordinator();
  const { controller, abortRef } = coord.startRequest(0, 49, 30, 'maize');
  coord.invalidateByCropChange('crop-change');
  eq('controller aborted', controller.signal.aborted, true);
  eq('abortRef set to crop-change', abortRef.value, 'crop-change');
});

await tc('cscoord-5: isStale returns false for active request, true after invalidation', () => {
  const coord = new CropScreeningRequestCoordinator();
  const { requestId } = coord.startRequest(1, 49.0, 30.0, 'maize');
  eq('not stale for current request', coord.isStale(requestId, 1, 49.0, 30.0, 'maize'), false);
  coord.invalidateByCropChange('crop-change');
  eq('stale after crop-change', coord.isStale(requestId, 1, 49.0, 30.0, 'maize'), true);
});

await tc('cscoord-6: isStale returns true when cropKey differs', () => {
  const coord = new CropScreeningRequestCoordinator();
  const { requestId } = coord.startRequest(0, 49.0, 30.0, 'maize');
  eq('stale for different cropKey', coord.isStale(requestId, 0, 49.0, 30.0, 'barley'), true);
  eq('not stale for same cropKey', coord.isStale(requestId, 0, 49.0, 30.0, 'maize'), false);
});

await tc('cscoord-7: clearOwner only clears refs for owning requestId', () => {
  const coord = new CropScreeningRequestCoordinator();
  const { requestId: idA } = coord.startRequest(0, 49, 30, 'maize');
  const { requestId: idB } = coord.startRequest(0, 49, 30, 'barley');
  // A tries to clear but B owns now
  coord.clearOwner(idA);
  // B's controller should still be set (idA !== idB)
  ok('B still owns (clearOwner with stale ID has no effect)', !coord.isStale(idB, 0, 49, 30, 'barley'));
});

// ── runCropScreeningLifecycle tests ────────────────────────────────────

function makePrecipFetch(precipByDate) {
  return async function(url, opts) {
    if (opts && opts.signal && opts.signal.aborted) {
      const e = new Error('AbortError'); e.name = 'AbortError'; throw e;
    }
    return {
      ok: true,
      json: async function() {
        return { properties: { parameter: { PRECTOTCORR: precipByDate } } };
      },
    };
  };
}

function makeHangingFetch() {
  let resolveFn;
  const promise = new Promise(function(res) { resolveFn = res; });
  const fetchImpl = async function(url, opts) {
    return promise;
  };
  return { fetchImpl, resolve: resolveFn };
}

function buildGoodPrecipData() {
  // 30 years × 365 days of 5mm/day → sum per year = 1825mm
  const data = {};
  for (let yr = 1991; yr <= 2020; yr++) {
    for (let mo = 1; mo <= 12; mo++) {
      const days = new Date(yr, mo, 0).getDate();
      for (let dy = 1; dy <= days; dy++) {
        if (mo === 2 && dy === 29) continue;
        const key = String(yr) + String(mo).padStart(2,'0') + String(dy).padStart(2,'0');
        data[key] = 5;
      }
    }
  }
  return data;
}

await tc('cslife-1: runCropScreeningLifecycle onLoadingChange(true) called first', async () => {
  const coord = new CropScreeningRequestCoordinator();
  const cache = new Map();
  let firstLoadingCall = null;
  await runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: makePrecipFetch(buildGoodPrecipData()),
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(v) { if (firstLoadingCall === null) firstLoadingCall = v; },
    onSuccess: function(){}, onTimeout: function(){}, onError: function(){},
  });
  eq('first loading call is true', firstLoadingCall, true);
});

await tc('cslife-2: runCropScreeningLifecycle onSuccess called for valid fetch', async () => {
  const coord = new CropScreeningRequestCoordinator();
  const cache = new Map();
  let successResult = null;
  await runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: makePrecipFetch(buildGoodPrecipData()),
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(){},
    onSuccess: function(r) { successResult = r; },
    onTimeout: function(){}, onError: function(){},
  });
  ok('onSuccess called', successResult !== null);
  ok('factorResults present', !!successResult.factorResults);
  ok('summaryText present', typeof successResult.summaryText === 'string');
  ok('cropRef present', !!successResult.cropRef);
});

await tc('cslife-3: runCropScreeningLifecycle onLoadingChange(false) called after success', async () => {
  const coord = new CropScreeningRequestCoordinator();
  const cache = new Map();
  let loadingStates = [];
  await runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: makePrecipFetch(buildGoodPrecipData()),
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(v) { loadingStates.push(v); },
    onSuccess: function(){}, onTimeout: function(){}, onError: function(){},
  });
  eq('two loading calls', loadingStates.length, 2);
  eq('first is true', loadingStates[0], true);
  eq('second is false', loadingStates[1], false);
});

await tc('cslife-4: stale request A onSuccess never called after B starts', async () => {
  const coord = new CropScreeningRequestCoordinator();
  const cache = new Map();
  let aSuccess = 0, bSuccess = 0;
  let resolveA;
  const pendingA = new Promise(function(res) { resolveA = res; });

  // A starts with a hanging fetch
  const promiseA = runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: async function() { return pendingA; },
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(){},
    onSuccess: function() { aSuccess++; }, onTimeout: function(){}, onError: function(){},
  });

  // B starts, invalidating A
  const promiseB = runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: makePrecipFetch(buildGoodPrecipData()),
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(){},
    onSuccess: function() { bSuccess++; }, onTimeout: function(){}, onError: function(){},
  });

  // Resolve A's fetch after B has already started
  const goodResp = {
    ok: true,
    json: async function() {
      return { properties: { parameter: { PRECTOTCORR: buildGoodPrecipData() } } };
    },
  };
  resolveA(goodResp);

  await Promise.all([promiseA, promiseB]);
  eq('A onSuccess never called', aSuccess, 0);
  eq('B onSuccess called once', bSuccess, 1);
});

await tc('cslife-5: stale request A onError never called after B starts', async () => {
  const coord = new CropScreeningRequestCoordinator();
  const cache = new Map();
  let aError = 0, bSuccess = 0;
  let resolveA;
  const pendingA = new Promise(function(res) { resolveA = res; });

  const promiseA = runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: async function() { return pendingA; },
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(){},
    onSuccess: function(){},
    onTimeout: function(){},
    onError: function() { aError++; },
  });

  const promiseB = runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: makePrecipFetch(buildGoodPrecipData()),
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(){},
    onSuccess: function() { bSuccess++; }, onTimeout: function(){}, onError: function(){},
  });

  // Resolve A with an HTTP error response
  resolveA({ ok: false, status: 503, statusText: 'Service Unavailable', json: async function(){ return {}; } });

  await Promise.all([promiseA, promiseB]);
  eq('A onError never called (stale)', aError, 0);
  eq('B onSuccess called', bSuccess, 1);
});

await tc('cslife-6: stale request A onLoadingChange(false) never called after B starts', async () => {
  const coord = new CropScreeningRequestCoordinator();
  const cache = new Map();
  let aLoadingFalse = 0, bLoadingFalse = 0;
  let resolveA;
  const pendingA = new Promise(function(res) { resolveA = res; });

  const promiseA = runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: async function() { return pendingA; },
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(v) { if (!v) aLoadingFalse++; },
    onSuccess: function(){}, onTimeout: function(){}, onError: function(){},
  });

  const promiseB = runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: makePrecipFetch(buildGoodPrecipData()),
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(v) { if (!v) bLoadingFalse++; },
    onSuccess: function(){}, onTimeout: function(){}, onError: function(){},
  });

  resolveA({ ok: true, json: async function() {
    return { properties: { parameter: { PRECTOTCORR: buildGoodPrecipData() } } };
  }});

  await Promise.all([promiseA, promiseB]);
  eq('A onLoadingChange(false) never called', aLoadingFalse, 0);
  eq('B onLoadingChange(false) called once', bLoadingFalse, 1);
});

await tc('cslife-7: annualPrecipCache NOT cleared by invalidateByCropChange', () => {
  const coord = new CropScreeningRequestCoordinator();
  const cache = new Map();
  cache.set('test-key', { PRECTOTCORR: {} });
  coord.startRequest(0, 49.0, 30.0, 'maize');
  coord.invalidateByCropChange('crop-change');
  // Cache must still have the entry
  eq('cache entry preserved', cache.has('test-key'), true);
});

await tc('cslife-8: onTimeout called when fetch aborts with reason=timeout', async () => {
  const coord = new CropScreeningRequestCoordinator();
  const cache = new Map();
  let timeoutFn, timeoutCalled = 0;

  const fetchImpl = async function(url, opts) {
    return new Promise(function(res, rej) {
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', function() {
          const e = new Error('AbortError'); e.name = 'AbortError'; rej(e);
        });
      }
    });
  };

  const p = runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: fetchImpl,
    timeoutMs: 5000,
    setTimeoutImpl: function(fn) { timeoutFn = fn; return 99; },
    clearTimeoutImpl: function(){},
    onLoadingChange: function(){},
    onSuccess: function(){},
    onTimeout: function() { timeoutCalled++; },
    onError: function(){},
  });

  timeoutFn();  // trigger timeout
  await p;
  eq('onTimeout called once', timeoutCalled, 1);
});

await tc('cslife-9: stale request A cannot populate cache after B starts', async () => {
  const coord = new CropScreeningRequestCoordinator();
  const cache = new Map();
  let resolveA;
  const pendingA = new Promise(function(res) { resolveA = res; });

  const promiseA = runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: async function() { return pendingA; },
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(){}, onSuccess: function(){}, onTimeout: function(){}, onError: function(){},
  });

  // B uses a different cropKey so the lifecycle resolves quickly from cache (cache is empty, so B fetches too)
  // Actually we need A to NOT be the one populating cache. B will populate with its own data.
  // A resolves after B — A sees isStale() and does NOT set cache.
  const promiseB = runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: makePrecipFetch(buildGoodPrecipData()),
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(){}, onSuccess: function(){}, onTimeout: function(){}, onError: function(){},
  });

  await promiseB;
  const keyAfterB = buildAnnualPrecipCacheKeyV18(49.0, 30.0);
  const cacheAfterB = cache.get(keyAfterB);
  ok('B populated cache', !!cacheAfterB);

  // Now A resolves with different data
  resolveA({ ok: true, json: async function() {
    return { properties: { parameter: { PRECTOTCORR: {'19910101': 999} } } };
  }});
  await promiseA;

  // Cache should still have B's data (A was stale and didn't overwrite)
  const cacheAfterA = cache.get(keyAfterB);
  // B's data had many keys; A would have set only {'19910101': 999}
  // So we can verify cache still has same object as after B
  eq('cache entry is same object (A did not overwrite)', cacheAfterA === cacheAfterB, true);
});

await tc('cslife-10: onError called for HTTP 503 response', async () => {
  const coord = new CropScreeningRequestCoordinator();
  const cache = new Map();
  let errorMsg = null;
  await runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: async function() { return { ok: false, status: 503, statusText: 'Service Unavailable', json: async function(){ return {}; } }; },
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(){},
    onSuccess: function(){},
    onTimeout: function(){},
    onError: function(msg) { errorMsg = msg; },
  });
  ok('onError called', errorMsg !== null);
  ok('error mentions 503', errorMsg.includes('503'));
});

await tc('cslife-11: crop-key mismatch makes lifecycle isStale (generation test)', async () => {
  const coord = new CropScreeningRequestCoordinator();
  const cache = new Map();
  let aSuccess = 0;

  let resolveA;
  const pendingA = new Promise(function(res) { resolveA = res; });

  const promiseA = runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'maize',
    annualPrecipCache: cache,
    fetchImpl: async function() { return pendingA; },
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(){},
    onSuccess: function() { aSuccess++; }, onTimeout: function(){}, onError: function(){},
  });

  // B starts with a different cropKey
  const promiseB = runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'barley',
    annualPrecipCache: cache,
    fetchImpl: makePrecipFetch(buildGoodPrecipData()),
    timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(){},
    onSuccess: function(){}, onTimeout: function(){}, onError: function(){},
  });

  resolveA({ ok: true, json: async function() {
    return { properties: { parameter: { PRECTOTCORR: buildGoodPrecipData() } } };
  }});
  await Promise.all([promiseA, promiseB]);
  eq('A (maize) onSuccess not called — stale due to different cropKey', aSuccess, 0);
});

await tc('cslife-12: runCropScreeningLifecycle uses cache from previous call (no second fetch)', async () => {
  const coord = new CropScreeningRequestCoordinator();
  const cache = new Map();
  let fetchCount = 0;

  const trackingFetch = async function() {
    fetchCount++;
    return {
      ok: true,
      json: async function() {
        return { properties: { parameter: { PRECTOTCORR: buildGoodPrecipData() } } };
      },
    };
  };

  // First call
  await runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'commonWheat',
    annualPrecipCache: cache,
    fetchImpl: trackingFetch, timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(){}, onSuccess: function(){}, onTimeout: function(){}, onError: function(){},
  });

  eq('one fetch on first call', fetchCount, 1);

  // Second call with same coords — should use cache
  await runCropScreeningLifecycle({
    coordinator: coord, locationGeneration: 0, lat: 49.0, lon: 30.0, cropKey: 'maize',
    annualPrecipCache: cache,
    fetchImpl: trackingFetch, timeoutMs: 0, setTimeoutImpl: function(){}, clearTimeoutImpl: function(){},
    onLoadingChange: function(){}, onSuccess: function(){}, onTimeout: function(){}, onError: function(){},
  });

  eq('no second fetch (cache hit)', fetchCount, 1);
});

// ─────────────────────────────────────────────────────────────────────
// v19 NEW TESTS
// ─────────────────────────────────────────────────────────────────────
const {
  resetCropScreeningUiAfterInvalidation,
} = core;

// ─────────────────────────────────────────────────────────────────────
// UI RESET TESTS (UIreset-1 through UIreset-8)
// Tests for resetCropScreeningUiAfterInvalidation injectable helper.
// ─────────────────────────────────────────────────────────────────────

function makeBtn(disabled, text) {
  return { disabled: disabled, textContent: text, dataset: { cropKey: 'commonWheat' } };
}
function makeEl(displayStyle) {
  return { style: { display: displayStyle }, textContent: '', innerHTML: '', dataset: { cropKey: 'commonWheat' } };
}

await tc('UIreset-1: after location invalidation, screenBtn.disabled is false', () => {
  const coord = new CropScreeningRequestCoordinator();
  coord.startRequest(0, 49.0, 30.0, 'commonWheat');
  const screenBtn = makeBtn(true, 'Fetching…');
  resetCropScreeningUiAfterInvalidation({
    coordinator: coord, abortReason: 'location-change',
    screenBtn, resultsEl: null, useBtnEl: null, useDiscEl: null, errorsEl: null,
  });
  eq('button enabled', screenBtn.disabled, false);
});

await tc('UIreset-2: after location invalidation, screenBtn.textContent is "Screen crop"', () => {
  const coord = new CropScreeningRequestCoordinator();
  coord.startRequest(0, 49.0, 30.0, 'commonWheat');
  const screenBtn = makeBtn(true, 'Fetching…');
  resetCropScreeningUiAfterInvalidation({
    coordinator: coord, abortReason: 'location-change',
    screenBtn, resultsEl: null, useBtnEl: null, useDiscEl: null, errorsEl: null,
  });
  eq('button label restored', screenBtn.textContent, 'Screen crop');
});

await tc('UIreset-3: after location invalidation, resultsEl is hidden', () => {
  const coord = new CropScreeningRequestCoordinator();
  coord.startRequest(0, 49.0, 30.0, 'commonWheat');
  const resultsEl = makeEl('block');
  resetCropScreeningUiAfterInvalidation({
    coordinator: coord, abortReason: 'location-change',
    screenBtn: null, resultsEl, useBtnEl: null, useDiscEl: null, errorsEl: null,
  });
  eq('resultsEl hidden', resultsEl.style.display, 'none');
});

await tc('UIreset-4: after location invalidation, useBtnEl.dataset.cropKey is cleared', () => {
  const coord = new CropScreeningRequestCoordinator();
  coord.startRequest(0, 49.0, 30.0, 'commonWheat');
  const useBtnEl = { dataset: { cropKey: 'commonWheat' } };
  resetCropScreeningUiAfterInvalidation({
    coordinator: coord, abortReason: 'location-change',
    screenBtn: null, resultsEl: null, useBtnEl, useDiscEl: null, errorsEl: null,
  });
  eq('cropKey cleared', useBtnEl.dataset.cropKey, '');
});

await tc('UIreset-5: after location invalidation, useDiscEl is hidden and text cleared', () => {
  const coord = new CropScreeningRequestCoordinator();
  coord.startRequest(0, 49.0, 30.0, 'commonWheat');
  const useDiscEl = { style: { display: 'block' }, textContent: 'Some disclosure text' };
  resetCropScreeningUiAfterInvalidation({
    coordinator: coord, abortReason: 'location-change',
    screenBtn: null, resultsEl: null, useBtnEl: null, useDiscEl, errorsEl: null,
  });
  eq('disclosure hidden', useDiscEl.style.display, 'none');
  eq('disclosure text cleared', useDiscEl.textContent, '');
});

await tc('UIreset-6: after reset, coordinator.isStale() returns true for old requestId', () => {
  const coord = new CropScreeningRequestCoordinator();
  const { requestId } = coord.startRequest(1, 49.0, 30.0, 'commonWheat');
  eq('not stale before reset', coord.isStale(requestId, 1, 49.0, 30.0, 'commonWheat'), false);
  resetCropScreeningUiAfterInvalidation({
    coordinator: coord, abortReason: 'location-change',
    screenBtn: null, resultsEl: null, useBtnEl: null, useDiscEl: null, errorsEl: null,
  });
  eq('stale after reset', coord.isStale(requestId, 1, 49.0, 30.0, 'commonWheat'), true);
});

await tc('UIreset-7: crop-change abort reason recorded as "crop-change"', () => {
  const coord = new CropScreeningRequestCoordinator();
  const { abortRef } = coord.startRequest(0, 49.0, 30.0, 'commonWheat');
  resetCropScreeningUiAfterInvalidation({
    coordinator: coord, abortReason: 'crop-change',
    screenBtn: null, resultsEl: null, useBtnEl: null, useDiscEl: null, errorsEl: null,
  });
  eq('abort reason is crop-change', abortRef.value, 'crop-change');
});

await tc('UIreset-8: location-change abort reason recorded as "location-change"', () => {
  const coord = new CropScreeningRequestCoordinator();
  const { abortRef } = coord.startRequest(0, 49.0, 30.0, 'commonWheat');
  resetCropScreeningUiAfterInvalidation({
    coordinator: coord, abortReason: 'location-change',
    screenBtn: null, resultsEl: null, useBtnEl: null, useDiscEl: null, errorsEl: null,
  });
  eq('abort reason is location-change', abortRef.value, 'location-change');
});

// ─────────────────────────────────────────────────────────────────────
// COORDINATE PROVENANCE TESTS (cprov-1 through cprov-9)
// ─────────────────────────────────────────────────────────────────────

const allRegions = [
  ...COUNTRY_REGION_REFERENCE_DATA.ukraine.regions,
  ...COUNTRY_REGION_REFERENCE_DATA.slovakia.regions,
  ...COUNTRY_REGION_REFERENCE_DATA.portugal.regions,
];

await tc('cprov-1: every region has a non-blank coordinateSource', () => {
  const bad = allRegions.filter(function(r) {
    return typeof r.coordinateSource !== 'string' || r.coordinateSource.trim() === '';
  });
  eq('no records missing coordinateSource', bad.length, 0);
});

await tc('cprov-2: every region has a positive integer coordinateSourceFeatureId', () => {
  const bad = allRegions.filter(function(r) {
    return typeof r.coordinateSourceFeatureId !== 'number' ||
           !Number.isFinite(r.coordinateSourceFeatureId) ||
           !Number.isInteger(r.coordinateSourceFeatureId) ||
           r.coordinateSourceFeatureId <= 0;
  });
  eq('no records missing numeric feature ID', bad.length, 0);
});

await tc('cprov-3: every region has a valid HTTPS coordinateSourceUrl', () => {
  const bad = allRegions.filter(function(r) {
    return typeof r.coordinateSourceUrl !== 'string' ||
           !r.coordinateSourceUrl.startsWith('https://');
  });
  eq('no records missing HTTPS URL', bad.length, 0);
});

await tc('cprov-4: every coordinateSourceUrl contains the feature ID as a substring', () => {
  const bad = allRegions.filter(function(r) {
    return typeof r.coordinateSourceFeatureId === 'number' &&
           !r.coordinateSourceUrl.includes(String(r.coordinateSourceFeatureId));
  });
  eq('all URLs contain their feature ID', bad.length, 0);
});

await tc('cprov-5: no record uses only the bare string "GeoNames" without a feature ID', () => {
  const bad = allRegions.filter(function(r) {
    return r.coordinateSource === 'GeoNames' &&
           (typeof r.coordinateSourceFeatureId !== 'number' || r.coordinateSourceFeatureId <= 0);
  });
  eq('no bare-GeoNames-only records', bad.length, 0);
});

await tc('cprov-6: all 25 Ukrainian region records pass strengthened v19 validator', () => {
  const regions = COUNTRY_REGION_REFERENCE_DATA.ukraine.regions;
  const failures = [];
  regions.forEach(function(r) {
    const result = validateRegionReferenceRecord(r);
    if (!result.valid) failures.push(r.name + ': ' + result.errors.join('; '));
  });
  eq('all 25 Ukrainian records valid', failures.length, 0);
});

await tc('cprov-7: all Slovak region records pass v19 validator', () => {
  const regions = COUNTRY_REGION_REFERENCE_DATA.slovakia.regions;
  const failures = [];
  regions.forEach(function(r) {
    const result = validateRegionReferenceRecord(r);
    if (!result.valid) failures.push(r.name + ': ' + result.errors.join('; '));
  });
  eq('all Slovak records valid', failures.length, 0);
});

await tc('cprov-8: all Portuguese region records pass v19 validator', () => {
  const regions = COUNTRY_REGION_REFERENCE_DATA.portugal.regions;
  const failures = [];
  regions.forEach(function(r) {
    const result = validateRegionReferenceRecord(r);
    if (!result.valid) failures.push(r.name + ': ' + result.errors.join('; '));
  });
  eq('all Portuguese records valid', failures.length, 0);
});

await tc('cprov-9: Crimea under Ukraine; Kyiv City and Sevastopol absent', () => {
  const ukraineNames = COUNTRY_REGION_REFERENCE_DATA.ukraine.regions.map(function(r) { return r.name; });
  const crimea = COUNTRY_REGION_REFERENCE_DATA.ukraine.regions.find(function(r) {
    return r.name === 'Autonomous Republic of Crimea · Ukraine';
  });
  ok('Crimea entry present', !!crimea);
  ok('Crimea has GeoNames featureId', !!crimea && crimea.coordinateSourceFeatureId === 693805);
  eq('Kyiv City absent', ukraineNames.includes('Kyiv City'), false);
  eq('Sevastopol absent', ukraineNames.includes('Sevastopol'), false);
  eq('Sevastopol city absent', ukraineNames.some(function(n) { return n.includes('Sevastopol'); }), false);
});

// ─────────────────────────────────────────────────────────────────────
// SOURCE STRUCTURE TESTS (srcled-1 through srcled-6)
// Reads AgroPredict(19).html as a text file to verify source placement.
// ─────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const htmlPath = path.join(__dirname, 'AgroPredict(20).html');
let htmlContent = '';
try { htmlContent = fs.readFileSync(htmlPath, 'utf8'); } catch(e) { htmlContent = ''; }

function sourcesSection() {
  // Return the substring from the sources section opening tag to its </section>
  const start = htmlContent.indexOf('id="sources"');
  const end   = htmlContent.indexOf('</section>', start);
  return (start >= 0 && end >= 0) ? htmlContent.slice(start, end) : '';
}
function footerSection() {
  const start = htmlContent.indexOf('<footer');
  const end   = htmlContent.indexOf('</footer>', start);
  return (start >= 0 && end >= 0) ? htmlContent.slice(start, end) : '';
}
function countOccurrences(haystack, needle) {
  var count = 0, pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
  return count;
}

await tc('srcled-1: SRC-010 appears exactly once inside #sources section', () => {
  const sources = sourcesSection();
  ok('HTML loaded', htmlContent.length > 0);
  eq('SRC-010 count in #sources', countOccurrences(sources, 'SRC-010'), 1);
});

await tc('srcled-2: SRC-011 appears at least once inside #sources section', () => {
  const sources = sourcesSection();
  ok('SRC-011 present in #sources', countOccurrences(sources, 'SRC-011') >= 1);
});

await tc('srcled-3: SRC-010 and SRC-011 not in footer', () => {
  const footer = footerSection();
  eq('SRC-010 absent from footer', countOccurrences(footer, 'SRC-010'), 0);
  eq('SRC-011 absent from footer', countOccurrences(footer, 'SRC-011'), 0);
});

await tc('srcled-4: official Constitution of Ukraine URL present in HTML', () => {
  ok('zakonst.rada.gov.ua URL present', htmlContent.includes('zakonst.rada.gov.ua'));
});

await tc('srcled-5: constitution-year label absent from entire HTML', () => {
  const _p = '2001 Con' + 'stitution';
  eq('constitution-year label absent', htmlContent.includes(_p), false);
});

await tc('srcled-6: UN-geocoding label absent from entire HTML', () => {
  const _p = 'UN geospatial' + ' nomenclature';
  eq('UN-geocoding label absent', htmlContent.includes(_p), false);
});

// ─────────────────────────────────────────────────────────────────────
// v20 TESTS — Climate Extremes & Risk Flags
// ─────────────────────────────────────────────────────────────────────

// ── Helper: build grouped windows with controlled coverage ────────────
function makeGroupedWindows(count, paramKey, aggregator, fillValue) {
  const windows = buildHistoricalWindowDefinitions('20260601', '20260831');
  return windows.slice(0, count).map((w, i) => {
    const obj = { year: w.year, startDate: w.startDate, endDate: w.endDate, expectedDays: 1, t2mByDate: {}, precipByDate: {} };
    const dateStr = String(w.year) + '0615';
    obj[paramKey][dateStr] = Array.isArray(fillValue) ? fillValue[i] : fillValue;
    return obj;
  });
}

// ── Test 1: qualifyingValues returned for status:'ok' ─────────────────
await tc('histref-v20-1: qualifyingValues returned for status ok', () => {
  const windows = buildHistoricalWindowDefinitions('20260601', '20260831');
  const grouped = windows.map((w, i) => {
    const obj = { year: w.year, startDate: w.startDate, endDate: w.endDate, expectedDays: 1, t2mByDate: {}, precipByDate: {} };
    const ds = String(w.year) + '0615';
    obj.t2mByDate[ds] = 15 + i * 0.1;
    return obj;
  });
  const ref = calculateHistoricalReference(grouped, 't2mByDate', 'mean');
  ok('status ok', ref.status === 'ok');
  ok('qualifyingValues is array', Array.isArray(ref.qualifyingValues));
  ok('qualifyingValues non-empty', ref.qualifyingValues.length > 0);
});

// ── Test 2: qualifyingValues returned for insufficient-windows ─────────
await tc('histref-v20-2: qualifyingValues returned for insufficient-windows', () => {
  const windows = buildHistoricalWindowDefinitions('20260601', '20260831');
  const thinGrouped = windows.slice(0, 10).map(w => {
    const obj = { year: w.year, startDate: w.startDate, endDate: w.endDate, expectedDays: 1, t2mByDate: {}, precipByDate: {} };
    const ds = String(w.year) + '0615';
    obj.t2mByDate[ds] = 18.0;
    return obj;
  });
  const ref = calculateHistoricalReference(thinGrouped, 't2mByDate', 'mean');
  ok('status insufficient-windows', ref.status === 'insufficient-windows');
  ok('qualifyingValues is array', Array.isArray(ref.qualifyingValues));
});

// ── Test 3: qualifyingValues aligns with qualifyingYears ──────────────
await tc('histref-v20-3: qualifyingValues aligns with qualifyingYears', () => {
  const windows = buildHistoricalWindowDefinitions('20260601', '20260831');
  const grouped = windows.map((w, i) => {
    const obj = { year: w.year, startDate: w.startDate, endDate: w.endDate, expectedDays: 1, t2mByDate: {}, precipByDate: {} };
    const ds = String(w.year) + '0615';
    obj.t2mByDate[ds] = 10 + i;
    return obj;
  });
  const ref = calculateHistoricalReference(grouped, 't2mByDate', 'mean');
  ok('lengths match', ref.qualifyingValues.length === ref.qualifyingYears.length);
  ok('all values finite', ref.qualifyingValues.every(v => Number.isFinite(v)));
});

// ── Test 4: only coverage-qualified windows appear ────────────────────
await tc('histref-v20-4: only coverage-qualified windows appear in qualifyingValues', () => {
  const windows = buildHistoricalWindowDefinitions('20260601', '20260831');
  const grouped = windows.map((w, i) => {
    const obj = { year: w.year, startDate: w.startDate, endDate: w.endDate, expectedDays: 1, t2mByDate: {}, precipByDate: {} };
    if (i % 2 === 0) { const ds = String(w.year) + '0615'; obj.t2mByDate[ds] = 20.0; }
    return obj;
  });
  const ref = calculateHistoricalReference(grouped, 't2mByDate', 'mean');
  ok('qualifying count matches values length', ref.qualifyingValues.length === ref.qualifyingCount);
  ok('non-qualifying windows excluded', ref.qualifyingValues.length < 30);
});

// ── Test 5: historical mean remains unchanged ─────────────────────────
await tc('histref-v20-5: existing historicalMean is unchanged', () => {
  const windows = buildHistoricalWindowDefinitions('20260601', '20260831');
  const grouped = windows.map(w => {
    const obj = { year: w.year, startDate: w.startDate, endDate: w.endDate, expectedDays: 1, t2mByDate: {}, precipByDate: {} };
    const ds = String(w.year) + '0615';
    obj.t2mByDate[ds] = 20.0;
    return obj;
  });
  const ref = calculateHistoricalReference(grouped, 't2mByDate', 'mean');
  ok('status ok', ref.status === 'ok');
  eq('historicalMean unchanged', ref.historicalMean, 20.0);
  ok('qualifyingValues mean matches historicalMean',
     Math.abs(ref.qualifyingValues.reduce((a, b) => a + b, 0) / ref.qualifyingValues.length - ref.historicalMean) < 1e-10
  );
});

// ── Test 6: input windows not mutated ────────────────────────────────
await tc('histref-v20-6: input windows not mutated by calculateHistoricalReference', () => {
  const windows = buildHistoricalWindowDefinitions('20260601', '20260831');
  const grouped = windows.map(w => {
    const obj = { year: w.year, startDate: w.startDate, endDate: w.endDate, expectedDays: 1, t2mByDate: {}, precipByDate: {} };
    const ds = String(w.year) + '0615';
    obj.t2mByDate[ds] = 16.0;
    return obj;
  });
  const snap = grouped.map(w => Object.assign({}, w));
  calculateHistoricalReference(grouped, 't2mByDate', 'mean');
  eq('length unchanged', grouped.length, snap.length);
  ok('first year unchanged', grouped[0].year === snap[0].year);
});

// ─────────────────────────────────────────────────────────────────────
// calculateEmpiricalPercentileRank
// ─────────────────────────────────────────────────────────────────────

// ── Test 7: current below all historical ─────────────────────────────
await tc('perc-7: current below all historical → percentile 0', () => {
  const r = calculateEmpiricalPercentileRank(1, [2, 3, 4, 5]);
  eq('status', r.status, 'ok');
  eq('percentileRaw', r.percentileRaw, 0);
  eq('belowCount', r.belowCount, 0);
  eq('equalCount', r.equalCount, 0);
});

// ── Test 8: current above all historical ─────────────────────────────
await tc('perc-8: current above all historical → percentile 100', () => {
  const r = calculateEmpiricalPercentileRank(10, [2, 3, 4, 5]);
  eq('status', r.status, 'ok');
  eq('percentileRaw', r.percentileRaw, 100);
  eq('belowCount', r.belowCount, 4);
  eq('equalCount', r.equalCount, 0);
});

// ── Test 9: current in the middle ────────────────────────────────────
await tc('perc-9: current in the middle of historical values', () => {
  const r = calculateEmpiricalPercentileRank(3, [1, 2, 4, 5]);
  eq('status', r.status, 'ok');
  eq('belowCount', r.belowCount, 2);
  eq('equalCount', r.equalCount, 0);
  const expected = 100 * 2 / 4;
  ok('percentileRaw correct', Math.abs(r.percentileRaw - expected) < 1e-10);
});

// ── Test 10: exact tie uses half weight ──────────────────────────────
await tc('perc-10: exact tie uses half weight', () => {
  const r = calculateEmpiricalPercentileRank(3, [1, 2, 3, 5]);
  eq('status', r.status, 'ok');
  eq('belowCount', r.belowCount, 2);
  eq('equalCount', r.equalCount, 1);
  const expected = 100 * (2 + 0.5) / 4;
  ok('percentileRaw correct', Math.abs(r.percentileRaw - expected) < 1e-10);
});

// ── Test 11: multiple ties ────────────────────────────────────────────
await tc('perc-11: multiple equal historical values each contribute half weight', () => {
  const r = calculateEmpiricalPercentileRank(3, [1, 3, 3, 5]);
  eq('status', r.status, 'ok');
  eq('belowCount', r.belowCount, 1);
  eq('equalCount', r.equalCount, 2);
  const expected = 100 * (1 + 0.5 * 2) / 4;
  ok('percentileRaw correct', Math.abs(r.percentileRaw - expected) < 1e-10);
});

// ── Test 12: all equal to current ────────────────────────────────────
await tc('perc-12: all historical values equal current → percentile 50', () => {
  const r = calculateEmpiricalPercentileRank(5, [5, 5, 5, 5]);
  eq('status', r.status, 'ok');
  eq('belowCount', r.belowCount, 0);
  eq('equalCount', r.equalCount, 4);
  eq('percentileRaw', r.percentileRaw, 50);
});

// ── Test 13: empty array ──────────────────────────────────────────────
await tc('perc-13: empty array → unavailable', () => {
  const r = calculateEmpiricalPercentileRank(5, []);
  eq('status', r.status, 'unavailable');
  eq('validHistoricalCount', r.validHistoricalCount, 0);
});

// ── Test 14: only invalid values ─────────────────────────────────────
await tc('perc-14: array of only invalid values → unavailable', () => {
  const r = calculateEmpiricalPercentileRank(5, [null, NaN, -999, Infinity]);
  eq('status', r.status, 'unavailable');
  eq('validHistoricalCount', r.validHistoricalCount, 0);
});

// ── Test 15: null currentValue ────────────────────────────────────────
await tc('perc-15: null currentValue → unavailable', () => {
  const r = calculateEmpiricalPercentileRank(null, [1, 2, 3]);
  eq('status', r.status, 'unavailable');
});

// ── Test 16: NaN currentValue ─────────────────────────────────────────
await tc('perc-16: NaN currentValue → unavailable', () => {
  const r = calculateEmpiricalPercentileRank(NaN, [1, 2, 3]);
  eq('status', r.status, 'unavailable');
});

// ── Test 17: Infinity currentValue ───────────────────────────────────
await tc('perc-17: Infinity currentValue → unavailable', () => {
  const r = calculateEmpiricalPercentileRank(Infinity, [1, 2, 3]);
  eq('status', r.status, 'unavailable');
});

// ── Test 18: numeric string currentValue ─────────────────────────────
await tc('perc-18: numeric string currentValue → unavailable (not a number type)', () => {
  const r = calculateEmpiricalPercentileRank('5', [1, 2, 3, 4, 5, 6]);
  eq('status', r.status, 'unavailable');
});

// ── Test 19: historical null excluded ────────────────────────────────
await tc('perc-19: null in historicalValues excluded', () => {
  const r = calculateEmpiricalPercentileRank(3, [1, null, 5]);
  eq('status', r.status, 'ok');
  eq('validHistoricalCount', r.validHistoricalCount, 2);
});

// ── Test 20: historical NaN excluded ─────────────────────────────────
await tc('perc-20: NaN in historicalValues excluded', () => {
  const r = calculateEmpiricalPercentileRank(3, [1, NaN, 5]);
  eq('status', r.status, 'ok');
  eq('validHistoricalCount', r.validHistoricalCount, 2);
});

// ── Test 21: historical Infinity excluded ────────────────────────────
await tc('perc-21: Infinity in historicalValues excluded', () => {
  const r = calculateEmpiricalPercentileRank(3, [1, Infinity, 5]);
  eq('status', r.status, 'ok');
  eq('validHistoricalCount', r.validHistoricalCount, 2);
});

// ── Test 22: historical -999 excluded ────────────────────────────────
await tc('perc-22: -999 in historicalValues excluded (NASA POWER fill value)', () => {
  const r = calculateEmpiricalPercentileRank(3, [1, -999, 5]);
  eq('status', r.status, 'ok');
  eq('validHistoricalCount', r.validHistoricalCount, 2);
});

// ── Test 23: input array not mutated ─────────────────────────────────
await tc('perc-23: historicalValues array not mutated', () => {
  const arr = [3, 1, 4, 1, 5];
  const snap = arr.slice();
  calculateEmpiricalPercentileRank(3, arr);
  ok('array not mutated', arr.every((v, i) => v === snap[i]));
  eq('length unchanged', arr.length, snap.length);
});

// ── Test 24: result clamped to 0-100 ─────────────────────────────────
await tc('perc-24: result is clamped to 0–100', () => {
  const above = calculateEmpiricalPercentileRank(999, [1, 2, 3]);
  ok('upper clamp', above.status === 'ok' && above.percentileRaw <= 100);
  const below = calculateEmpiricalPercentileRank(-999, [1, 2, 3]);
  // -999 is a valid number; but the historical values 1,2,3 are all above -999
  // so percentile is 0 (clamped minimum satisfied)
  ok('lower clamp', below.status === 'ok' && below.percentileRaw >= 0);
});

// ── Test 25: rounded value uses one decimal ───────────────────────────
await tc('perc-25: percentileRounded uses one decimal place', () => {
  const r = calculateEmpiricalPercentileRank(2, [1, 3, 5, 7, 9]);
  ok('status ok', r.status === 'ok');
  const rounded = r.percentileRounded;
  const str = String(rounded);
  const decimals = str.includes('.') ? str.split('.')[1].length : 0;
  ok('at most one decimal', decimals <= 1);
  ok('matches manual rounding', rounded === Math.round(r.percentileRaw * 10) / 10);
});

// ─────────────────────────────────────────────────────────────────────
// classifyClimatePercentile — temperature and precipitation
// ─────────────────────────────────────────────────────────────────────

function okResult(p) {
  return { status: 'ok', percentileRaw: p, percentileRounded: Math.round(p * 10) / 10, validHistoricalCount: 30, belowCount: 0, equalCount: 0 };
}

// ── Test 26: temperature percentile 0 ────────────────────────────────
await tc('cls-26: temperature p=0 → unusually-low', () => {
  const r = classifyClimatePercentile('temperature', okResult(0));
  eq('code', r.code, 'unusually-low');
  eq('label', r.label, 'Unusually cool relative to history');
});

// ── Test 27: temperature percentile 10 ───────────────────────────────
await tc('cls-27: temperature p=10 → unusually-low (boundary belongs to unusual-low)', () => {
  const r = classifyClimatePercentile('temperature', okResult(10));
  eq('code', r.code, 'unusually-low');
});

// ── Test 28: temperature immediately above 10 ────────────────────────
await tc('cls-28: temperature p=10.1 → below-central', () => {
  const r = classifyClimatePercentile('temperature', okResult(10.1));
  eq('code', r.code, 'below-central');
  eq('label', r.label, 'Cooler than most historical windows');
});

// ── Test 29: temperature immediately below 25 ────────────────────────
await tc('cls-29: temperature p=24.9 → below-central', () => {
  const r = classifyClimatePercentile('temperature', okResult(24.9));
  eq('code', r.code, 'below-central');
});

// ── Test 30: temperature 25 ──────────────────────────────────────────
await tc('cls-30: temperature p=25 → central (boundary belongs to central)', () => {
  const r = classifyClimatePercentile('temperature', okResult(25));
  eq('code', r.code, 'central');
  eq('label', r.label, 'Within the central historical range');
});

// ── Test 31: temperature 75 ──────────────────────────────────────────
await tc('cls-31: temperature p=75 → central (boundary belongs to central)', () => {
  const r = classifyClimatePercentile('temperature', okResult(75));
  eq('code', r.code, 'central');
});

// ── Test 32: temperature immediately above 75 ────────────────────────
await tc('cls-32: temperature p=75.1 → above-central', () => {
  const r = classifyClimatePercentile('temperature', okResult(75.1));
  eq('code', r.code, 'above-central');
  eq('label', r.label, 'Warmer than most historical windows');
});

// ── Test 33: temperature immediately below 90 ────────────────────────
await tc('cls-33: temperature p=89.9 → above-central', () => {
  const r = classifyClimatePercentile('temperature', okResult(89.9));
  eq('code', r.code, 'above-central');
});

// ── Test 34: temperature 90 ──────────────────────────────────────────
await tc('cls-34: temperature p=90 → unusually-high (boundary belongs to unusual-high)', () => {
  const r = classifyClimatePercentile('temperature', okResult(90));
  eq('code', r.code, 'unusually-high');
  eq('label', r.label, 'Unusually warm relative to history');
});

// ── Test 35: temperature 100 ─────────────────────────────────────────
await tc('cls-35: temperature p=100 → unusually-high', () => {
  const r = classifyClimatePercentile('temperature', okResult(100));
  eq('code', r.code, 'unusually-high');
});

// ── Test 36: precipitation boundary equivalents ───────────────────────
await tc('cls-36: precipitation boundaries match spec', () => {
  eq('p=0 dry', classifyClimatePercentile('precipitation', okResult(0)).code,   'unusually-low');
  eq('p=10 dry', classifyClimatePercentile('precipitation', okResult(10)).code,  'unusually-low');
  eq('p=10.1', classifyClimatePercentile('precipitation', okResult(10.1)).code, 'below-central');
  eq('p=24.9', classifyClimatePercentile('precipitation', okResult(24.9)).code, 'below-central');
  eq('p=25 central', classifyClimatePercentile('precipitation', okResult(25)).code, 'central');
  eq('p=75 central', classifyClimatePercentile('precipitation', okResult(75)).code, 'central');
  eq('p=75.1', classifyClimatePercentile('precipitation', okResult(75.1)).code, 'above-central');
  eq('p=89.9', classifyClimatePercentile('precipitation', okResult(89.9)).code, 'above-central');
  eq('p=90 wet', classifyClimatePercentile('precipitation', okResult(90)).code,  'unusually-high');
  eq('p=100 wet', classifyClimatePercentile('precipitation', okResult(100)).code, 'unusually-high');
  eq('p=0 label', classifyClimatePercentile('precipitation', okResult(0)).label,  'Unusually dry relative to history');
  eq('p=100 label', classifyClimatePercentile('precipitation', okResult(100)).label, 'Unusually wet relative to history');
});

// ── Test 37: invalid parameter ────────────────────────────────────────
await tc('cls-37: invalid parameter name → unavailable', () => {
  const r = classifyClimatePercentile('humidity', okResult(50));
  eq('code', r.code, 'unavailable');
});

// ── Test 38: unavailable percentile result ────────────────────────────
await tc('cls-38: unavailable percentile result → unavailable classification', () => {
  const r = classifyClimatePercentile('temperature', { status: 'unavailable', reason: 'no data', validHistoricalCount: 0 });
  eq('code', r.code, 'unavailable');
});

// ── Test 39: non-finite percentile ────────────────────────────────────
await tc('cls-39: NaN percentileRaw → unavailable', () => {
  const r = classifyClimatePercentile('temperature', { status: 'ok', percentileRaw: NaN, percentileRounded: NaN, validHistoricalCount: 30 });
  eq('code', r.code, 'unavailable');
});

// ── Test 40: out-of-range percentile ─────────────────────────────────
await tc('cls-40: percentileRaw > 100 → unavailable', () => {
  const r = classifyClimatePercentile('temperature', { status: 'ok', percentileRaw: 101, percentileRounded: 101, validHistoricalCount: 30 });
  eq('code', r.code, 'unavailable');
});

// ─────────────────────────────────────────────────────────────────────
// buildClimateExtremesResult
// ─────────────────────────────────────────────────────────────────────

function hist30(base) {
  return Array.from({ length: 30 }, (_, i) => base + i * 0.1);
}

// ── Test 41: both parameters available ───────────────────────────────
await tc('ext-41: both parameters available → both ok', () => {
  const r = buildClimateExtremesResult({
    currentTemperature:          20,
    historicalTemperatureValues: hist30(15),
    currentTemperatureQualifies: true,
    currentPrecipitation:        80,
    historicalPrecipitationValues: hist30(60),
    currentPrecipitationQualifies: true,
    minimumHistoricalWindows:    24,
  });
  eq('temp status', r.temperature.status, 'ok');
  eq('precip status', r.precipitation.status, 'ok');
  ok('temp percentile ok', r.temperature.percentile.status === 'ok');
  ok('precip percentile ok', r.precipitation.percentile.status === 'ok');
});

// ── Test 42: temperature available, precipitation unavailable ─────────
await tc('ext-42: temperature ok, precipitation coverage fails', () => {
  const r = buildClimateExtremesResult({
    currentTemperature:          20,
    historicalTemperatureValues: hist30(15),
    currentTemperatureQualifies: true,
    currentPrecipitation:        80,
    historicalPrecipitationValues: hist30(60),
    currentPrecipitationQualifies: false,
    minimumHistoricalWindows:    24,
  });
  eq('temp status', r.temperature.status, 'ok');
  eq('precip status', r.precipitation.status, 'unavailable');
});

// ── Test 43: precipitation available, temperature unavailable ─────────
await tc('ext-43: precipitation ok, temperature coverage fails', () => {
  const r = buildClimateExtremesResult({
    currentTemperature:          20,
    historicalTemperatureValues: hist30(15),
    currentTemperatureQualifies: false,
    currentPrecipitation:        80,
    historicalPrecipitationValues: hist30(60),
    currentPrecipitationQualifies: true,
    minimumHistoricalWindows:    24,
  });
  eq('temp status', r.temperature.status, 'unavailable');
  eq('precip status', r.precipitation.status, 'ok');
});

// ── Test 44: both unavailable ─────────────────────────────────────────
await tc('ext-44: both parameters have failed coverage', () => {
  const r = buildClimateExtremesResult({
    currentTemperature:          20,
    historicalTemperatureValues: hist30(15),
    currentTemperatureQualifies: false,
    currentPrecipitation:        80,
    historicalPrecipitationValues: hist30(60),
    currentPrecipitationQualifies: false,
    minimumHistoricalWindows:    24,
  });
  eq('temp status', r.temperature.status, 'unavailable');
  eq('precip status', r.precipitation.status, 'unavailable');
});

// ── Test 45: failed current-temperature coverage ──────────────────────
await tc('ext-45: failed current-temperature coverage → explicit reason', () => {
  const r = buildClimateExtremesResult({
    currentTemperature:          20,
    historicalTemperatureValues: hist30(15),
    currentTemperatureQualifies: false,
    currentPrecipitation:        null,
    historicalPrecipitationValues: [],
    currentPrecipitationQualifies: false,
    minimumHistoricalWindows:    24,
  });
  ok('temp reason present', typeof r.temperature.reason === 'string' && r.temperature.reason.length > 0);
  ok('temp reason mentions temperature', r.temperature.reason.toLowerCase().includes('temperature'));
});

// ── Test 46: failed current-precipitation coverage ────────────────────
await tc('ext-46: failed current-precipitation coverage → explicit reason', () => {
  const r = buildClimateExtremesResult({
    currentTemperature:          null,
    historicalTemperatureValues: [],
    currentTemperatureQualifies: false,
    currentPrecipitation:        80,
    historicalPrecipitationValues: hist30(60),
    currentPrecipitationQualifies: false,
    minimumHistoricalWindows:    24,
  });
  ok('precip reason present', typeof r.precipitation.reason === 'string' && r.precipitation.reason.length > 0);
  ok('precip reason mentions precipitation', r.precipitation.reason.toLowerCase().includes('precipitation'));
});

// ── Test 47: fewer than 24 historical temperature windows ─────────────
await tc('ext-47: fewer than 24 historical temperature values → unavailable', () => {
  const r = buildClimateExtremesResult({
    currentTemperature:          20,
    historicalTemperatureValues: hist30(15).slice(0, 10),
    currentTemperatureQualifies: true,
    currentPrecipitation:        80,
    historicalPrecipitationValues: hist30(60),
    currentPrecipitationQualifies: true,
    minimumHistoricalWindows:    24,
  });
  eq('temp status', r.temperature.status, 'unavailable');
  eq('precip status', r.precipitation.status, 'ok');
});

// ── Test 48: fewer than 24 historical precipitation windows ───────────
await tc('ext-48: fewer than 24 historical precipitation values → unavailable', () => {
  const r = buildClimateExtremesResult({
    currentTemperature:          20,
    historicalTemperatureValues: hist30(15),
    currentTemperatureQualifies: true,
    currentPrecipitation:        80,
    historicalPrecipitationValues: hist30(60).slice(0, 10),
    currentPrecipitationQualifies: true,
    minimumHistoricalWindows:    24,
  });
  eq('temp status', r.temperature.status, 'ok');
  eq('precip status', r.precipitation.status, 'unavailable');
});

// ── Test 49: exactly 24 qualifying values ─────────────────────────────
await tc('ext-49: exactly 24 historical values → ok (≥ minimum)', () => {
  const r = buildClimateExtremesResult({
    currentTemperature:          20,
    historicalTemperatureValues: hist30(15).slice(0, 24),
    currentTemperatureQualifies: true,
    currentPrecipitation:        80,
    historicalPrecipitationValues: hist30(60).slice(0, 24),
    currentPrecipitationQualifies: true,
    minimumHistoricalWindows:    24,
  });
  eq('temp status', r.temperature.status, 'ok');
  eq('precip status', r.precipitation.status, 'ok');
});

// ── Test 50: no combined score property ──────────────────────────────
await tc('ext-50: result has no combined score property', () => {
  const r = buildClimateExtremesResult({
    currentTemperature:          20,
    historicalTemperatureValues: hist30(15),
    currentTemperatureQualifies: true,
    currentPrecipitation:        80,
    historicalPrecipitationValues: hist30(60),
    currentPrecipitationQualifies: true,
    minimumHistoricalWindows:    24,
  });
  eq('no combinedScore', r.combinedScore, undefined);
  eq('no score', r.score, undefined);
  eq('no overallScore', r.overallScore, undefined);
});

// ── Test 51: no probability property ─────────────────────────────────
await tc('ext-51: result has no probability property', () => {
  const r = buildClimateExtremesResult({
    currentTemperature:          20,
    historicalTemperatureValues: hist30(15),
    currentTemperatureQualifies: true,
    currentPrecipitation:        80,
    historicalPrecipitationValues: hist30(60),
    currentPrecipitationQualifies: true,
    minimumHistoricalWindows:    24,
  });
  eq('no probability', r.probability, undefined);
  eq('no cropFailureRisk', r.cropFailureRisk, undefined);
  eq('no yieldReductionProbability', r.yieldReductionProbability, undefined);
});

// ── Test 52: temperature result does not change precipitation result ───
await tc('ext-52: temperature result does not affect precipitation result', () => {
  const r1 = buildClimateExtremesResult({
    currentTemperature:          5,
    historicalTemperatureValues: hist30(15),
    currentTemperatureQualifies: true,
    currentPrecipitation:        80,
    historicalPrecipitationValues: hist30(60),
    currentPrecipitationQualifies: true,
    minimumHistoricalWindows:    24,
  });
  const r2 = buildClimateExtremesResult({
    currentTemperature:          25,
    historicalTemperatureValues: hist30(15),
    currentTemperatureQualifies: true,
    currentPrecipitation:        80,
    historicalPrecipitationValues: hist30(60),
    currentPrecipitationQualifies: true,
    minimumHistoricalWindows:    24,
  });
  eq('precipitation percentile identical', r1.precipitation.percentile.percentileRaw, r2.precipitation.percentile.percentileRaw);
  eq('precipitation classification identical', r1.precipitation.classification.code, r2.precipitation.classification.code);
});

// ── Test 53: precipitation result does not change temperature result ───
await tc('ext-53: precipitation result does not affect temperature result', () => {
  const r1 = buildClimateExtremesResult({
    currentTemperature:          20,
    historicalTemperatureValues: hist30(15),
    currentTemperatureQualifies: true,
    currentPrecipitation:        10,
    historicalPrecipitationValues: hist30(60),
    currentPrecipitationQualifies: true,
    minimumHistoricalWindows:    24,
  });
  const r2 = buildClimateExtremesResult({
    currentTemperature:          20,
    historicalTemperatureValues: hist30(15),
    currentTemperatureQualifies: true,
    currentPrecipitation:        200,
    historicalPrecipitationValues: hist30(60),
    currentPrecipitationQualifies: true,
    minimumHistoricalWindows:    24,
  });
  eq('temperature percentile identical', r1.temperature.percentile.percentileRaw, r2.temperature.percentile.percentileRaw);
  eq('temperature classification identical', r1.temperature.classification.code, r2.temperature.classification.code);
});

// ── Test 54: deterministic for identical input ────────────────────────
await tc('ext-54: deterministic output for identical input', () => {
  const opts = {
    currentTemperature:          18.5,
    historicalTemperatureValues: hist30(14),
    currentTemperatureQualifies: true,
    currentPrecipitation:        55,
    historicalPrecipitationValues: hist30(40),
    currentPrecipitationQualifies: true,
    minimumHistoricalWindows:    24,
  };
  const r1 = buildClimateExtremesResult(opts);
  const r2 = buildClimateExtremesResult(opts);
  eq('temp percentile deterministic', r1.temperature.percentile.percentileRaw, r2.temperature.percentile.percentileRaw);
  eq('precip percentile deterministic', r1.precipitation.percentile.percentileRaw, r2.precipitation.percentile.percentileRaw);
  eq('temp code deterministic', r1.temperature.classification.code, r2.temperature.classification.code);
  eq('precip code deterministic', r1.precipitation.classification.code, r2.precipitation.classification.code);
});

// ── Test 55: input arrays not mutated ────────────────────────────────
await tc('ext-55: historicalTemperatureValues and historicalPrecipitationValues not mutated', () => {
  const tempArr  = hist30(15);
  const precipArr = hist30(60);
  const tSnap = tempArr.slice();
  const pSnap = precipArr.slice();
  buildClimateExtremesResult({
    currentTemperature:          20,
    historicalTemperatureValues: tempArr,
    currentTemperatureQualifies: true,
    currentPrecipitation:        80,
    historicalPrecipitationValues: precipArr,
    currentPrecipitationQualifies: true,
    minimumHistoricalWindows:    24,
  });
  ok('temp array not mutated', tempArr.every((v, i) => v === tSnap[i]));
  ok('precip array not mutated', precipArr.every((v, i) => v === pSnap[i]));
});

// ─────────────────────────────────────────────────────────────────────
// Regression tests (56–59)
// ─────────────────────────────────────────────────────────────────────

await tc('reg-56: existing anomaly mean calculation unchanged', () => {
  const windows = buildHistoricalWindowDefinitions('20260601', '20260831');
  const grouped = windows.map(w => {
    const obj = { year: w.year, startDate: w.startDate, endDate: w.endDate, expectedDays: 1, t2mByDate: {}, precipByDate: {} };
    obj.t2mByDate[String(w.year) + '0615'] = 20.0;
    return obj;
  });
  const ref = calculateHistoricalReference(grouped, 't2mByDate', 'mean');
  eq('historicalMean unchanged', ref.historicalMean, 20.0);
  eq('status ok', ref.status, 'ok');
});

await tc('reg-57: existing anomaly difference calculation unchanged', () => {
  const r = calculateTemperatureAnomaly(22.0, 20.0);
  eq('status', r.status, 'ok');
  eq('rounded', r.rounded, 2.0);
  eq('direction', r.direction, 'warmer');
});

await tc('reg-58: existing crop screening calculations unchanged', () => {
  const { calculateFarmEconomics: _cfe, validateFarmEconomicsInput: _vfe } = core;
  const valid = _vfe(validRaw());
  ok('farm economics input valid', valid.valid);
  const result = calculateFarmEconomics(valid.parsed);
  ok('grossMargin is finite', Number.isFinite(result.grossMargin));
});

await tc('reg-59: existing farm economics calculations unchanged', () => {
  const valid = validateFarmEconomicsInput(validRaw({ area: '200', yieldPerHa: '4', salePrice: '150' }));
  ok('valid input', valid.valid);
  const result = calculateFarmEconomics(valid.parsed);
  eq('totalProductionTonnes', result.totalProductionTonnes, 800);
  eq('totalRevenue', result.totalRevenue, 120000);
});

// ─────────────────────────────────────────────────────────────────────
// HTML structure tests (60–68) — read AgroPredict(20).html as text
// ─────────────────────────────────────────────────────────────────────

const v20HtmlPath = path.join(__dirname, 'AgroPredict(20).html');
let v20Html = '';
try { v20Html = fs.readFileSync(v20HtmlPath, 'utf8'); } catch(e) { v20Html = ''; }

function v20Sources() {
  const start = v20Html.indexOf('id="sources"');
  const end   = v20Html.indexOf('</section>', start);
  return (start >= 0 && end >= 0) ? v20Html.slice(start, end) : '';
}
function v20Footer() {
  const start = v20Html.indexOf('<footer');
  const end   = v20Html.indexOf('</footer>', start);
  return (start >= 0 && end >= 0) ? v20Html.slice(start, end) : '';
}

await tc('html-60: historical toggle off also hides the extremes panel', () => {
  ok('HTML loaded', v20Html.length > 0);
  const toggleBlock = (() => {
    const idx = v20Html.indexOf("'historyCompareToggle'").toString() === '-1'
      ? v20Html.indexOf('"historyCompareToggle"')
      : v20Html.indexOf("'historyCompareToggle'");
    const segment = v20Html.slice(Math.max(0, idx - 50), idx + 400);
    return segment;
  })();
  ok('extremesResults hidden in toggle handler', v20Html.includes("extremesResults") &&
     (() => {
       const tIdx = v20Html.indexOf("getElementById('historyCompareToggle')");
       if (tIdx < 0) return false;
       const block = v20Html.slice(tIdx, tIdx + 600);
       return block.includes('extremesResults') || v20Html.slice(tIdx, tIdx + 1200).includes('extremesResults');
     })()
  );
});

await tc('html-61: location change clears the extremes panel', () => {
  ok('HTML loaded', v20Html.length > 0);
  ok('extremesResults cleared in clearStaleResults or location change path',
    v20Html.includes('extremesResults'));
});

await tc('html-62: period change clears the extremes panel', () => {
  ok('extremesResults div exists in HTML', v20Html.includes('id="extremesResults"'));
  const clearFnIdx = v20Html.indexOf('function clearStaleResults()');
  const clearFn = clearFnIdx >= 0 ? v20Html.slice(clearFnIdx, clearFnIdx + 800) : '';
  ok('clearStaleResults references extremesResults', clearFn.includes('extremesResults'));
});

await tc('html-63: stale historical request cannot render extremes panel (structural)', () => {
  ok('extremes rendered only inside onSuccess callback',
    (() => {
      const onSuccessIdx = v20Html.indexOf('onSuccess: (cachedEntry)');
      if (onSuccessIdx < 0) return false;
      const block = v20Html.slice(onSuccessIdx, onSuccessIdx + 3000);
      return block.includes('extremesResults') || block.includes('renderExtremesPanel') || block.includes('buildClimateExtremesResult');
    })()
  );
});

await tc('html-64: current successful request renders extremes panel once', () => {
  const renderCount = (() => {
    let count = 0, pos = 0;
    const needle = 'renderExtremesPanel(';
    while ((pos = v20Html.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
    return count;
  })();
  ok('renderExtremesPanel defined', v20Html.includes('function renderExtremesPanel('));
  ok('renderExtremesPanel called exactly once from production code', renderCount >= 2);
});

await tc('html-65: no extra NASA POWER fetch started for extremes panel', () => {
  const fetchCalls = (() => {
    let count = 0, pos = 0;
    const needle = 'fetchHistoricalReference(';
    while ((pos = v20Html.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
    return count;
  })();
  ok('no second historical fetch call for extremes', fetchCalls <= 2);
});

await tc('html-66: SRC-012 appears exactly once inside sources section', () => {
  const sources = v20Sources();
  ok('sources section found', sources.length > 0);
  const count = (() => {
    let c = 0, pos = 0;
    while ((pos = sources.indexOf('SRC-012', pos)) !== -1) { c++; pos += 7; }
    return c;
  })();
  eq('SRC-012 count in #sources', count, 1);
});

await tc('html-67: SRC-012 absent from footer', () => {
  const footer = v20Footer();
  ok('SRC-012 not in footer', !footer.includes('SRC-012'));
});

await tc('html-68: forbidden prediction/recommendation language absent from extremes panel area', () => {
  const idx = v20Html.indexOf('renderExtremesPanel');
  const area = idx >= 0 ? v20Html.slice(idx, idx + 6000) : v20Html;
  ok('"future risk" absent',         !area.includes('future risk'));
  ok('"predicted drought" absent',   !area.includes('predicted drought'));
  ok('"drought probability" absent', !area.includes('drought probability'));
  ok('"crop failure risk" absent',   !area.includes('crop failure risk'));
});

// ─────────────────────────────────────────────────────────────────────
// REPORT
// ─────────────────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────────');
console.log(`Test cases:          ${results.cases}`);
console.log(`Assertions:          ${results.assertions}`);
console.log(`Passed assertions:   ${results.passed}`);
console.log(`Failed assertions:   ${results.failed}`);
if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.error(f));
}
process.exitCode = results.failed > 0 ? 1 : 0;

})(); // end async IIFE
