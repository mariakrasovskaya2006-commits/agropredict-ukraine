const HTML_BASE64 = "__HTML_BASE64__";
const CORE_BASE64 = "__CORE_BASE64__";

const decoder = new TextDecoder();
function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return decoder.decode(bytes);
}

const page = decodeBase64(HTML_BASE64);
const coreScript = decodeBase64(CORE_BASE64);

const WCS_BASE = "https://maps.isric.org/mapserv";
const WCS_VERSION = "2.0.1";
const CRS_4326 = "http://www.opengis.net/def/crs/EPSG/0/4326";
const BBOX_HALF_DEG = 0.005;
const INT16_NODATA = -32768;
const CACHE_TTL_MS = 3600000;
const MAX_RESPONSE_BYTES = 1048576;
const MAX_DECOMP_BYTES = 2097152;
const SOIL_PH_FALLBACK_OFFSETS = [
  [0, 0], [-0.05, 0], [0.05, 0], [0, 0.05], [0, -0.05],
  [-0.05, 0.05], [-0.05, -0.05], [0.05, 0.05], [0.05, -0.05],
];

const PROPERTIES = {
  phh2o: { mapFile: "/map/phh2o.map", factor: 10, rawUnit: "pH ×10", displayUnit: "pH" },
  soc: { mapFile: "/map/soc.map", factor: 10, rawUnit: "dg/kg", displayUnit: "g/kg" },
  sand: { mapFile: "/map/sand.map", factor: 10, rawUnit: "g/kg", displayUnit: "%" },
  silt: { mapFile: "/map/silt.map", factor: 10, rawUnit: "g/kg", displayUnit: "%" },
  clay: { mapFile: "/map/clay.map", factor: 10, rawUnit: "g/kg", displayUnit: "%" },
  cec: { mapFile: "/map/cec.map", factor: 10, rawUnit: "mmol(c)/kg", displayUnit: "cmol(c)/kg" },
  nitrogen: { mapFile: "/map/nitrogen.map", factor: 100, rawUnit: "cg/kg", displayUnit: "g/kg" },
};
const STATS = ["mean", "Q0.05", "Q0.5", "Q0.95"];
const TEXTURE_KEYS = ["sand", "silt", "clay", "soc", "cec", "nitrogen"];
const cache = new Map();
const rateLimits = new Map();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const ANALYTICS_EVENTS = new Set([
  "page_view",
  "cta_click",
  "analysis_started",
  "analysis_completed",
  "detailed_analysis_opened",
]);
const FEEDBACK_USEFULNESS = new Set(["yes", "partly", "no"]);
const VISITOR_TYPES = new Set(["farmer", "agronomist", "student-researcher", "business", "other"]);
const SCORE_BANDS = new Set(["0-39", "40-59", "60-74", "75-89", "90-100", "unavailable"]);

function cleanOptional(value, maxLength) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function cleanPagePath(value) {
  const path = cleanOptional(value, 120) || "/";
  return path.startsWith("/") && !path.includes("?") && !path.includes("#") ? path : "/";
}

function cleanCountryCode(value) {
  const code = cleanOptional(value, 2);
  return code && /^(UA|SK|PT)$/.test(code.toUpperCase()) ? code.toUpperCase() : null;
}

function cleanCropKey(value) {
  const crop = cleanOptional(value, 60);
  return crop && /^[a-z0-9_-]+$/.test(crop) ? crop : null;
}

function cleanEventLabel(value) {
  const label = cleanOptional(value, 80);
  return label && /^[a-z0-9-]+$/.test(label) ? label : null;
}

function cleanScoreBand(value) {
  return typeof value === "string" && SCORE_BANDS.has(value) ? value : null;
}

function sameOriginRequest(request, url) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === url.host; } catch { return false; }
}

async function readSmallJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > 4096) throw new Error("payload-too-large");
  const text = await request.text();
  if (text.length > 4096) throw new Error("payload-too-large");
  return text ? JSON.parse(text) : {};
}

function databaseUnavailable() {
  return json({ status: "error", message: "Feedback storage is temporarily unavailable." }, 503);
}

async function handleAnalyticsEvent(request, url, env) {
  if (!sameOriginRequest(request, url)) return json({ status: "error", message: "Origin not allowed." }, 403);
  if (!env || !env.DB) return databaseUnavailable();
  try {
    const payload = await readSmallJson(request);
    if (!ANALYTICS_EVENTS.has(payload.event)) return json({ status: "error", message: "Unsupported analytics event." }, 400);
    await env.DB.prepare(
      "INSERT INTO analytics_events (id, event_name, event_label, page_path, country_code, crop_key, score_band) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      crypto.randomUUID(), payload.event, cleanEventLabel(payload.label), cleanPagePath(payload.page), cleanCountryCode(payload.country),
      cleanCropKey(payload.crop), cleanScoreBand(payload.scoreBand)
    ).run();
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error && error.message === "payload-too-large") return json({ status: "error", message: "Payload too large." }, 413);
    if (error instanceof SyntaxError) return json({ status: "error", message: "Invalid JSON." }, 400);
    console.error("analytics-write-failed", error);
    return databaseUnavailable();
  }
}

async function handleFeedback(request, url, env) {
  if (!sameOriginRequest(request, url)) return json({ status: "error", message: "Origin not allowed." }, 403);
  if (!env || !env.DB) return databaseUnavailable();
  try {
    const payload = await readSmallJson(request);
    if (cleanOptional(payload.website, 100)) return new Response(null, { status: 204 });
    if (!FEEDBACK_USEFULNESS.has(payload.usefulness)) return json({ status: "error", message: "Choose how useful the result was." }, 400);
    if (!VISITOR_TYPES.has(payload.visitorType)) return json({ status: "error", message: "Choose the option that best describes you." }, 400);
    const id = crypto.randomUUID();
    const pagePath = cleanPagePath(payload.page);
    const countryCode = cleanCountryCode(payload.country);
    const cropKey = cleanCropKey(payload.crop);
    const scoreBand = cleanScoreBand(payload.scoreBand);
    const comment = cleanOptional(payload.comment, 1200) || "";
    const feedbackInsert = env.DB.prepare(
      "INSERT INTO analysis_feedback (id, usefulness, visitor_type, comment, page_path, country_code, crop_key, score_band) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, payload.usefulness, payload.visitorType, comment, pagePath, countryCode, cropKey, scoreBand);
    const eventInsert = env.DB.prepare(
      "INSERT INTO analytics_events (id, event_name, event_label, page_path, country_code, crop_key, score_band) VALUES (?, 'feedback_submitted', NULL, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), pagePath, countryCode, cropKey, scoreBand);
    await env.DB.batch([feedbackInsert, eventInsert]);
    return json({ status: "ok", message: "Thank you — your anonymous feedback was saved." }, 201);
  } catch (error) {
    if (error && error.message === "payload-too-large") return json({ status: "error", message: "Feedback is too long." }, 413);
    if (error instanceof SyntaxError) return json({ status: "error", message: "Invalid JSON." }, 400);
    console.error("feedback-write-failed", error);
    return databaseUnavailable();
  }
}

function validateCoordinates(url) {
  if (url.searchParams.getAll("lat").length > 1 || url.searchParams.getAll("lon").length > 1) {
    return { valid: false, code: "repeated-parameter", message: "Repeated query parameters are not allowed." };
  }
  const latRaw = url.searchParams.get("lat");
  const lonRaw = url.searchParams.get("lon");
  if (latRaw === null || lonRaw === null || latRaw.trim() === "" || lonRaw.trim() === "") {
    return { valid: false, code: "invalid-coordinates", message: "Both lat and lon are required." };
  }
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return { valid: false, code: "invalid-coordinates", message: "Coordinates are outside valid latitude/longitude ranges." };
  }
  return { valid: true, lat, lon };
}

function isRateLimited(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const prior = rateLimits.get(ip);
  const entry = !prior || now - prior.start >= 60000 ? { start: now, count: 0 } : prior;
  entry.count++;
  rateLimits.set(ip, entry);
  return entry.count > 20;
}

function buildWcsUrl(property, stat, lat, lon) {
  const def = PROPERTIES[property];
  if (!def || !STATS.includes(stat)) throw new Error("Unsupported SoilGrids property or statistic");
  const params = new URLSearchParams({
    map: def.mapFile,
    SERVICE: "WCS",
    VERSION: WCS_VERSION,
    REQUEST: "GetCoverage",
    COVERAGEID: `${property}_0-5cm_${stat}`,
    FORMAT: "image/tiff",
    SUBSETTINGCRS: CRS_4326,
    OUTPUTCRS: CRS_4326,
  });
  const lonMin = (lon - BBOX_HALF_DEG).toFixed(6);
  const lonMax = (lon + BBOX_HALF_DEG).toFixed(6);
  const latMin = (lat - BBOX_HALF_DEG).toFixed(6);
  const latMax = (lat + BBOX_HALF_DEG).toFixed(6);
  return `${WCS_BASE}?${params}&SUBSET=X(${lonMin},${lonMax})&SUBSET=Y(${latMin},${latMax})`;
}

async function fetchCoverage(property, stat, lat, lon) {
  const key = `${lat.toFixed(6)},${lon.toFixed(6)},${property},${stat}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return { ...hit.value, fromCache: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(buildWcsUrl(property, stat, lat, lon), { signal: controller.signal });
    if (!response.ok) throw new Error(`SoilGrids WCS returned HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error("SoilGrids response exceeded the size limit");
    const raw = await extractPixel(new Uint8Array(buffer), lat, lon);
    if (raw === INT16_NODATA) return { status: "unavailable", reason: "nodata" };
    const converted = raw / PROPERTIES[property].factor;
    const value = { status: "ok", raw, converted, fromCache: false };
    cache.set(key, { time: Date.now(), value });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  const output = new Uint8Array(await new Response(stream).arrayBuffer());
  if (output.byteLength > MAX_DECOMP_BYTES) throw new Error("Decompressed SoilGrids tile exceeded the size limit");
  return output;
}

async function extractPixel(bytes, targetLat, targetLon) {
  if (bytes.byteLength < 16) throw new Error("Invalid GeoTIFF response");
  const magic = String.fromCharCode(bytes[0], bytes[1]);
  if (magic !== "II" && magic !== "MM") throw new Error("Invalid GeoTIFF byte order");
  const little = magic === "II";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = offset => view.getUint16(offset, little);
  const u32 = offset => view.getUint32(offset, little);
  const f64 = offset => view.getFloat64(offset, little);
  if (u16(2) !== 42) throw new Error("Invalid GeoTIFF header");
  const ifd = u32(4);
  const count = u16(ifd);
  let width, height, bits = 16, sampleFormat = 2, predictor = 1;
  let tileWidth = 256, tileHeight = 256, offsets = null, byteCounts = null;
  let tieLon = null, tieLat = null, scaleX = null, scaleY = null, nodata = INT16_NODATA;

  function readLongArray(type, n, entryOffset) {
    if (n === 1) return [type === 3 ? u16(entryOffset + 8) : u32(entryOffset + 8)];
    const arrayOffset = u32(entryOffset + 8);
    const values = [];
    for (let j = 0; j < n; j++) values.push(type === 3 ? u16(arrayOffset + j * 2) : u32(arrayOffset + j * 4));
    return values;
  }

  for (let i = 0; i < count; i++) {
    const offset = ifd + 2 + i * 12;
    const tag = u16(offset);
    const type = u16(offset + 2);
    const n = u32(offset + 4);
    const scalar = type === 3 && n === 1 ? u16(offset + 8) : type === 4 && n === 1 ? u32(offset + 8) : null;
    if (tag === 256) width = scalar;
    else if (tag === 257) height = scalar;
    else if (tag === 258 && scalar !== null) bits = scalar;
    else if (tag === 317 && scalar !== null) predictor = scalar;
    else if (tag === 322 && scalar !== null) tileWidth = scalar;
    else if (tag === 323 && scalar !== null) tileHeight = scalar;
    else if (tag === 339 && scalar !== null) sampleFormat = scalar;
    else if (tag === 324) offsets = readLongArray(type, n, offset);
    else if (tag === 325) byteCounts = readLongArray(type, n, offset);
    else if (tag === 33550) {
      const dataOffset = u32(offset + 8);
      scaleX = f64(dataOffset); scaleY = f64(dataOffset + 8);
    } else if (tag === 33922) {
      const dataOffset = u32(offset + 8);
      tieLon = f64(dataOffset + 24); tieLat = f64(dataOffset + 32);
    } else if (tag === 42113) {
      const dataOffset = n <= 4 ? offset + 8 : u32(offset + 8);
      const text = decoder.decode(bytes.slice(dataOffset, dataOffset + n)).replace(/\0/g, "").trim();
      const parsed = Number.parseInt(text, 10); if (Number.isFinite(parsed)) nodata = parsed;
    }
  }
  if (!width || !height || !offsets || !byteCounts || tieLon === null || tieLat === null || !scaleX || !scaleY) {
    throw new Error("Unsupported or incomplete SoilGrids GeoTIFF");
  }
  const pixelEpsilon = 1e-9;
  const col = Math.floor((targetLon - tieLon) / scaleX + pixelEpsilon);
  const row = Math.floor((tieLat - targetLat) / scaleY + pixelEpsilon);
  if (col < 0 || row < 0 || col >= width || row >= height) throw new Error("Coordinate outside SoilGrids raster");
  const tilesAcross = Math.ceil(width / tileWidth);
  const tileIndex = Math.floor(row / tileHeight) * tilesAcross + Math.floor(col / tileWidth);
  const start = offsets[tileIndex];
  const length = byteCounts[tileIndex];
  if (!Number.isFinite(start) || !Number.isFinite(length) || start + length > bytes.byteLength) throw new Error("Invalid SoilGrids tile offset");
  const data = await inflate(bytes.slice(start, start + length));
  const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (predictor === 2 && bits === 16) {
    for (let y = 0; y < tileHeight; y++) {
      let accumulator = 0;
      for (let x = 0; x < tileWidth; x++) {
        const byteOffset = (y * tileWidth + x) * 2;
        if (byteOffset + 2 > data.byteLength) break;
        const delta = dataView.getInt16(byteOffset, little);
        accumulator = (accumulator + delta) & 0xffff;
        dataView.setInt16(byteOffset, accumulator > 32767 ? accumulator - 65536 : accumulator, little);
      }
    }
  }
  const pixelOffset = ((row % tileHeight) * tileWidth + (col % tileWidth)) * 2;
  if (pixelOffset + 2 > data.byteLength) throw new Error("SoilGrids pixel outside tile");
  const raw = sampleFormat === 2 ? dataView.getInt16(pixelOffset, little) : dataView.getUint16(pixelOffset, little);
  return raw === nodata ? INT16_NODATA : raw;
}

async function propertyResult(property, stats, lat, lon) {
  const settled = await Promise.allSettled(stats.map(stat => fetchCoverage(property, stat, lat, lon)));
  const def = PROPERTIES[property];
  const values = {};
  let okCount = 0;
  stats.forEach((stat, index) => {
    const item = settled[index];
    if (item.status === "fulfilled" && item.value.status === "ok") {
      values[stat] = item.value.converted; okCount++;
    } else values[stat] = null;
  });
  if (!okCount) return { status: "unavailable", reason: "SoilGrids property unavailable", rawUnit: def.rawUnit, displayUnit: def.displayUnit };
  const numericValues = stats.map(stat => values[stat]).filter(value => typeof value === "number" && Number.isFinite(value));
  if (property === "phh2o" && numericValues.length && numericValues.every(value => value === 0)) {
    return { status: "unavailable", reason: "SoilGrids returned an all-zero pH tile at this point", rawUnit: def.rawUnit, displayUnit: def.displayUnit };
  }
  return {
    status: "ok", rawUnit: def.rawUnit, conversionFactor: def.factor, displayUnit: def.displayUnit,
    mean: values.mean, median: values["Q0.5"] ?? null,
    lower: values["Q0.05"] ?? null, upper: values["Q0.95"] ?? null,
  };
}

function sourceMetadata() {
  return {
    provider: "ISRIC", dataset: "SoilGrids 2.0",
    citation: "Poggio et al. (2021), doi:10.5194/soil-7-217-2021",
    license: "CC BY 4.0", accessMethod: "WCS", wcsVersion: WCS_VERSION,
    retrievedAt: new Date().toISOString(), spatialResolution: "approximately 250 m", depthInterval: "0–5 cm",
  };
}

async function soilProfile(lat, lon) {
  const [phh2o, soc] = await Promise.all([propertyResult("phh2o", STATS, lat, lon), propertyResult("soc", STATS, lat, lon)]);
  const ok = [phh2o, soc].filter(value => value.status === "ok").length;
  return { status: ok === 2 ? "ok" : ok ? "partial" : "error", location: { submittedLat: lat, submittedLon: lon }, source: sourceMetadata(), depth: { topCm: 0, bottomCm: 5 }, properties: { phh2o, soc } };
}

async function soilPh(lat, lon) {
  for (const [latOffset, lonOffset] of SOIL_PH_FALLBACK_OFFSETS) {
    const sampledLat = lat + latOffset;
    const sampledLon = lon + lonOffset;
    if (sampledLat < -90 || sampledLat > 90 || sampledLon < -180 || sampledLon > 180) continue;
    const phh2o = await propertyResult("phh2o", ["mean"], sampledLat, sampledLon);
    if (phh2o.status === "ok" && typeof phh2o.mean === "number" && phh2o.mean > 0 && phh2o.mean <= 14) {
      return {
        status: "ok",
        location: {
          submittedLat: lat,
          submittedLon: lon,
          sampledLat,
          sampledLon,
          fallbackUsed: latOffset !== 0 || lonOffset !== 0,
          method: latOffset === 0 && lonOffset === 0 ? "submitted-point" : "nearby-fixed-offset",
        },
        source: sourceMetadata(),
        depth: { topCm: 0, bottomCm: 5 },
        properties: { phh2o },
      };
    }
  }
  return {
    status: "error",
    location: { submittedLat: lat, submittedLon: lon, fallbackUsed: false, method: "no-land-cell-found" },
    source: sourceMetadata(),
    depth: { topCm: 0, bottomCm: 5 },
    properties: { phh2o: { status: "unavailable", reason: "No non-zero pH land cell was found at the reference point or fixed nearby offsets" } },
  };
}

async function soilTexture(lat, lon) {
  const results = await Promise.all(TEXTURE_KEYS.map(key => propertyResult(key, ["mean"], lat, lon)));
  const properties = Object.fromEntries(TEXTURE_KEYS.map((key, index) => [key, results[index]]));
  const ok = results.filter(value => value.status === "ok").length;
  return { status: ok === results.length ? "ok" : ok ? "partial" : "error", location: { submittedLat: lat, submittedLon: lon }, source: { ...sourceMetadata(), statistic: "mean prediction" }, depth: { topCm: 0, bottomCm: 5 }, properties };
}

async function handleSoil(request, url, texture) {
  if (isRateLimited(request)) return json({ status: "error", error: "rate-limit", message: "Too many requests. Please wait before retrying." }, 429);
  const coordinates = validateCoordinates(url);
  if (!coordinates.valid) return json({ status: "error", error: coordinates.code, message: coordinates.message }, 400);
  try {
    const result = texture ? await soilTexture(coordinates.lat, coordinates.lon) : await soilProfile(coordinates.lat, coordinates.lon);
    return json(result, result.status === "error" ? 502 : 200);
  } catch (error) {
    return json({ status: "error", error: "upstream", message: "SoilGrids data is temporarily unavailable." }, 502);
  }
}

async function handleSoilPh(request, url) {
  if (isRateLimited(request)) return json({ status: "error", error: "rate-limit", message: "Too many requests. Please wait before retrying." }, 429);
  const coordinates = validateCoordinates(url);
  if (!coordinates.valid) return json({ status: "error", error: coordinates.code, message: coordinates.message }, 400);
  try {
    const result = await soilPh(coordinates.lat, coordinates.lon);
    return json(result, result.status === "error" ? 502 : 200);
  } catch (error) {
    return json({ status: "error", error: "soil-upstream", message: error && error.message ? error.message : "Could not retrieve SoilGrids pH." }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pageRoutes = new Set([
      "/", "/index.html", "/analysis", "/tools", "/tools/climate", "/tools/soil",
      "/tools/growing-season", "/tools/rainfall", "/tools/economics",
      "/tools/compare-crops", "/tools/crop-reference", "/about", "/research",
    ]);
    if (request.method === "GET" && pageRoutes.has(url.pathname.replace(/\/$/, "") || "/")) {
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (request.method === "GET" && url.pathname === "/agropredict-core-v26-beta.js") {
      return new Response(coreScript, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" });
    if (request.method === "POST" && url.pathname === "/api/analytics/events") return handleAnalyticsEvent(request, url, env);
    if (request.method === "POST" && url.pathname === "/api/feedback") return handleFeedback(request, url, env);
    if (request.method === "GET" && url.pathname === "/api/soil-profile") return handleSoil(request, url, false);
    if (request.method === "GET" && url.pathname === "/api/soil-ph") return handleSoilPh(request, url);
    if (request.method === "GET" && url.pathname === "/api/soil-texture") return handleSoil(request, url, true);
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
