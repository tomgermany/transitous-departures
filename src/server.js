import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const APP_NAME = "Transitous Departures";
const APP_VERSION = "0.1.0";
const CONTACT = process.env.CONTACT || "set-CONTACT-in-environment";
const API_URL = "https://api.transitous.org/api/v6/stoptimes";

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data, null, 2));
}

function getEpoch(value) {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function getRawTime(item) {
  return item.departure ?? item.scheduled ?? item.place?.departure ?? null;
}

function formatLocalTime(epochMs, timeZone) {
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(epochMs));
  } catch {
    return null;
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const rad = (deg) => deg * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function modeCategory(mode) {
  if (["BUS", "ODM"].includes(mode)) return "BUS";
  if (["TRAM", "SUBWAY"].includes(mode)) return "TRAM";
  if (["RAIL", "REGIONAL_RAIL", "REGIONAL_FAST_RAIL", "SUBURBAN", "HIGHSPEED_RAIL", "HIGH_SPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL"].includes(mode)) return "RAIL";
  if (mode === "FERRY") return "FERRY";
  if (mode === "FUNICULAR") return "FUNICULAR";
  return null;
}

function displayedMode(mode) {
  // Keep the existing prototype's labels unchanged for this first iteration.
  if (mode === "FERRY") return "FÄHRE";
  if (mode === "SUBWAY") return "U-BAHN";
  if (mode === "SUBURBAN") return "S-BAHN";
  if (["HIGHSPEED_RAIL", "HIGH_SPEED_RAIL", "LONG_DISTANCE"].includes(mode)) return "FERN";
  if (["REGIONAL_RAIL", "REGIONAL_FAST_RAIL", "RAIL"].includes(mode)) return "BAHN";
  return mode || "UNKNOWN";
}

function normalizeDeparture(item) {
  const place = item.place ?? {};
  const rawTime = getRawTime(item);
  const epochMs = getEpoch(rawTime);
  const mode = item.mode || "UNKNOWN";
  return {
    epochMs,
    time: epochMs !== null ? formatLocalTime(epochMs, place.tz) : null,
    timezone: place.tz || null,
    stopName: place.name || "Unknown stop",
    stopId: place.stopId || null,
    mode,
    displayedMode: displayedMode(mode),
    line: item.routeShortName || item.route?.shortName || "",
    destination: item.headsign || item.tripTo || "",
    status: item.cancelled ? "CANCELLED" : item.realtime ? "REALTIME" : "SCHEDULED",
    platform: place.platform || item.platform || "",
  };
}

async function transitousQuery({ lat, lon, radius, stopId, n = 100 }) {
  const params = new URLSearchParams({
    n: String(n),
    language: "en",
  });

  if (stopId) {
    // Bei einer gezielten Haltestellenabfrage nur die Stop-ID senden.
    params.set("stopId", stopId);
  } else {
    // Bei der Suche im Umkreis Koordinaten und Radius senden.
    params.set("center", `${lat},${lon}`);
    params.set("radius", String(radius));
  }

  const response = await fetch(`${API_URL}?${params}`, {
    headers: {
      "User-Agent": `${APP_NAME}/${APP_VERSION} (${CONTACT})`,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Transitous API returned HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data.stopTimes)) {
    throw new Error("Transitous response did not contain a stopTimes array");
  }

  return data.stopTimes;
}

async function findDepartures({ lat, lon, radius }) {
  const initial = await transitousQuery({ lat, lon, radius, n: 100 });
  const nearestByCategory = new Map();

  for (const item of initial) {
    const place = item.place || {};
    const category = modeCategory(item.mode);
    if (!category || !place.stopId) continue;

    const stopLat = Number(place.lat);
    const stopLon = Number(place.lon);
    if (!Number.isFinite(stopLat) || !Number.isFinite(stopLon)) continue;

    const distance = haversineMeters(lat, lon, stopLat, stopLon);
    const previous = nearestByCategory.get(category);

    if (!previous || distance < previous.distance) {
      nearestByCategory.set(category, {
        category,
        stopId: place.stopId,
        stopName: place.name || "Unknown stop",
        distance,
      });
    }
  }

  const selected = [...nearestByCategory.values()];
  const selectedIds = new Set(selected.map((stop) => stop.stopId));

  // Use departures already returned by the initial radius query.
  // Keep only entries belonging to the nearest selected stop per category.
  const rawDepartures = initial.filter((item) => {
  const place = item.place || {};
  return selectedIds.has(place.stopId);
});

const now = Date.now();

const normalized = rawDepartures
  .map(normalizeDeparture)
  .filter((item) => item.epochMs !== null && item.epochMs >= now - 60_000)
  .sort((a, b) => a.epochMs - b.epochMs);

const debug = {
  apiEntries: initial.length,
  selectedStopEntries: rawDepartures.length,
  futureEntries: normalized.length,
};


  const seen = new Set();
  const departures = [];

  for (const item of normalized) {
    const key = `${item.stopId}|${item.line}|${item.destination}|${item.epochMs}`;
    if (seen.has(key)) continue;

    seen.add(key);
    departures.push(item);
    if (departures.length === 5) break;
  }

  return {
    query: { lat, lon, radius },
    debug,
    stopsSelected: selected.map((stop) => ({
      category: stop.category,
      name: stop.stopName,
      stopId: stop.stopId,
      distanceMeters: Math.round(stop.distance),
    })),
    departures,
    attribution: "Transit data provided by Transitous. See https://transitous.org/sources/",
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/health") return sendJson(res, 200, { ok: true, app: APP_NAME, version: APP_VERSION });

  if (url.pathname === "/api/departures") {
    const lat = Number(url.searchParams.get("lat"));
    const lon = Number(url.searchParams.get("lon"));
    const radius = Number(url.searchParams.get("radius") || 500);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180 || !Number.isFinite(radius) || radius < 1 || radius > 50000) {
      return sendJson(res, 400, { error: "Provide valid lat, lon and radius query parameters (radius 1–50000 m)." });
    }
    try {
      return sendJson(res, 200, await findDepartures({ lat, lon, radius }));
    } catch (error) {
      return sendJson(res, 502, { error: error.message || "Transitous request failed" });
    }
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const html = await readFile(path.join(HERE, "../public/index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      return sendJson(res, 500, { error: "Web interface file not found" });
    }
  }
  return sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("==================================");
  console.log(`${APP_NAME}`);
  console.log(`Version: ${APP_VERSION}`);
  console.log(`Port: ${PORT}`);
  console.log(`Started: ${new Date().toISOString()}`);
  console.log("==================================");
});
