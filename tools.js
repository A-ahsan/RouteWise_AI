// RouteWise AI — Tool implementations
// Every tool prefers a KEYLESS free API so the whole agent runs with only the Gemma key.
// Optional keys (ORS_API_KEY, TOMTOM_API_KEY) upgrade quality when present.

const UA = { "User-Agent": "RouteWise-AI/1.0 (hackathon transit agent)" };

async function j(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} @ ${url}`);
  return r.json();
}

const km = (m) => +(m / 1000).toFixed(2);
const mins = (s) => Math.round(s / 60);

// ─────────────────────────────────────────────────────────────
// 1. get_coordinates  — Nominatim (keyless)
// ─────────────────────────────────────────────────────────────
async function get_coordinates({ place }) {
  const DHAKA = { lat: 23.8103, lon: 90.4125 };

  // 1) Nominatim, biased to Bangladesh + Dhaka suffix
  try {
    const q = /dhaka|bangladesh/i.test(place) ? place : `${place}, Dhaka, Bangladesh`;
    const data = await j(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=bd&addressdetails=1`
    );
    if (data.length) return { place, display_name: data[0].display_name, lat: +data[0].lat, lon: +data[0].lon };
  } catch (e) {}

  // 2) Photon (OSM-based, better fuzzy/partial matching), biased to Dhaka
  try {
    const d = await j(`https://photon.komoot.io/api/?q=${encodeURIComponent(place)}&lat=${DHAKA.lat}&lon=${DHAKA.lon}&limit=1&lang=en`);
    const f = d.features?.[0];
    if (f) {
      const [lon, lat] = f.geometry.coordinates;
      const pr = f.properties || {};
      const name = [pr.name, pr.street, pr.district, pr.city, pr.state].filter(Boolean).join(", ");
      return { place, display_name: name || place, lat, lon };
    }
  } catch (e) {}

  // 3) Nominatim without the Dhaka suffix (broadest)
  try {
    const data = await j(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1`);
    if (data.length) return { place, display_name: data[0].display_name, lat: +data[0].lat, lon: +data[0].lon };
  } catch (e) {}

  return { error: `No location found for "${place}". Try adding an area, e.g. "${place}, Dhaka".` };
}

// ─────────────────────────────────────────────────────────────
// 2. calculate_route — OSRM (keyless) w/ optional OpenRouteService
// ─────────────────────────────────────────────────────────────
async function calculate_route({ origin_lat, origin_lon, dest_lat, dest_lon, mode = "driving" }) {
  const profile = { driving: "driving", walking: "foot", cycling: "bike" }[mode] || "driving";
  const data = await j(
    `https://router.project-osrm.org/route/v1/${profile}/${origin_lon},${origin_lat};${dest_lon},${dest_lat}?overview=full&geometries=geojson&alternatives=true`
  );
  if (data.code !== "Ok" || !data.routes?.length) return { error: "No route found" };

  const routes = data.routes.map((r, i) => ({
    label: i === 0 ? "Main route" : `Alternative ${i}`,
    distance_km: km(r.distance),
    eta_minutes: mins(r.duration),
    geometry: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]), // Leaflet [lat,lon]
  }));

  const main = routes[0];
  return {
    mode,
    distance_km: main.distance_km,
    eta_minutes: main.eta_minutes,
    routes, // includes alternatives for the map + agent
  };
}

// ─────────────────────────────────────────────────────────────
// 3. get_weather — Open-Meteo (keyless)
// ─────────────────────────────────────────────────────────────
async function get_weather({ lat, lon }) {
  const d = await j(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,precipitation,rain,weather_code,wind_speed_10m` +
      `&hourly=precipitation_probability,rain&forecast_hours=6&timezone=auto`
  );
  const c = d.current;
  const rainSoon = (d.hourly?.rain || []).slice(0, 6).some((v) => v > 0.1);
  const maxProb = Math.max(0, ...(d.hourly?.precipitation_probability || [0]).slice(0, 6));
  return {
    temperature_c: c.temperature_2m,
    wind_kmh: c.wind_speed_10m,
    raining_now: c.rain > 0 || c.precipitation > 0,
    rain_expected_6h: rainSoon,
    rain_probability_pct: maxProb,
    summary: describeWeather(c.weather_code),
  };
}

function describeWeather(code) {
  if (code === 0) return "Clear sky";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Foggy";
  if (code <= 67) return "Rainy";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Rain showers";
  if (code <= 99) return "Thunderstorm";
  return "Unknown";
}

// ─────────────────────────────────────────────────────────────
// 4. get_live_traffic — TomTom (optional key) else estimate from OSRM
// ─────────────────────────────────────────────────────────────
async function get_live_traffic({ lat, lon }) {
  const key = process.env.TOMTOM_API_KEY;
  if (key) {
    try {
      const d = await j(
        `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${lat},${lon}&key=${key}`
      );
      const f = d.flowSegmentData;
      const ratio = f.currentSpeed / f.freeFlowSpeed;
      return {
        source: "TomTom",
        current_speed_kmh: f.currentSpeed,
        free_flow_speed_kmh: f.freeFlowSpeed,
        congestion: ratio > 0.85 ? "light" : ratio > 0.6 ? "moderate" : "heavy",
        confidence: f.confidence,
      };
    } catch (e) {
      /* fall through to estimate */
    }
  }
  // Keyless estimate: rush-hour heuristic for Dhaka (UTC+6)
  const hour = (new Date().getUTCHours() + 6) % 24;
  const rush = (hour >= 7 && hour <= 10) || (hour >= 16 && hour <= 20);
  return {
    source: "estimate (no traffic key)",
    congestion: rush ? "heavy" : "moderate",
    note: rush
      ? "Peak hours in Dhaka — expect significant congestion on main arteries."
      : "Off-peak — moderate traffic expected.",
  };
}

// ─────────────────────────────────────────────────────────────
// 5. find_bus_stops — Overpass / OpenStreetMap (keyless)
// ─────────────────────────────────────────────────────────────
async function find_bus_stops({ lat, lon, radius_m = 800 }) {
  const query = `[out:json][timeout:15];(
     node["highway"="bus_stop"](around:${radius_m},${lat},${lon});
     node["railway"="station"](around:${radius_m},${lat},${lon});
     node["station"="subway"](around:${radius_m},${lat},${lon});
   );out body 8;`;
  try {
    const d = await j("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
    });
    const stops = (d.elements || []).slice(0, 8).map((e) => ({
      name: e.tags?.name || (e.tags?.railway ? "Metro/Rail station" : "Bus stop"),
      type: e.tags?.railway || e.tags?.station || "bus_stop",
      lat: e.lat,
      lon: e.lon,
    }));
    return { count: stops.length, stops };
  } catch (e) {
    return { count: 0, stops: [], note: "Transit stop data temporarily unavailable." };
  }
}

// ─────────────────────────────────────────────────────────────
// 6. estimate_travel_cost — computed from distance (Dhaka fares, ৳)
// ─────────────────────────────────────────────────────────────
function estimate_travel_cost({ distance_km }) {
  const d = distance_km;
  return {
    currency: "BDT",
    options: [
      { mode: "Walking", cost_taka: 0, note: d > 3 ? "Long for walking" : "Feasible" },
      { mode: "Bus", cost_taka: Math.max(10, Math.round(d * 2.5)) },
      { mode: "Metro Rail", cost_taka: Math.min(100, Math.max(20, Math.round(d * 5))) },
      { mode: "Rickshaw", cost_taka: Math.round(d * 30) },
      { mode: "Ride-share (bike)", cost_taka: Math.round(25 + d * 22) },
      { mode: "Ride-share (car)", cost_taka: Math.round(60 + d * 40) },
    ].sort((a, b) => a.cost_taka - b.cost_taka),
  };
}

// ─────────────────────────────────────────────────────────────
// 7. safety_score — heuristic from street lighting + weather + traffic
// ─────────────────────────────────────────────────────────────
async function safety_score({ lat, lon }) {
  let lightScore = 60;
  try {
    const d = await j("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body:
        "data=" +
        encodeURIComponent(
          `[out:json][timeout:15];node["highway"="street_lamp"](around:400,${lat},${lon});out count;`
        ),
    });
    const lamps = d.elements?.[0]?.tags?.nodes ? +d.elements[0].tags.nodes : (d.elements?.length || 0);
    lightScore = Math.min(100, 40 + lamps * 2);
  } catch (e) {}

  const hour = (new Date().getUTCHours() + 6) % 24;
  const daytime = hour >= 6 && hour <= 18;
  const score = Math.round(lightScore * 0.5 + (daytime ? 100 : 55) * 0.5);
  return {
    safety_score: Math.min(100, score),
    factors: {
      street_lighting: lightScore >= 70 ? "good" : "limited",
      time_of_day: daytime ? "daytime" : "night",
    },
    advice: score < 60 ? "Prefer main, well-lit roads and shared transport." : "Route is reasonably safe.",
  };
}

// ─────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────
export const toolImpls = {
  get_coordinates,
  calculate_route,
  get_weather,
  get_live_traffic,
  find_bus_stops,
  estimate_travel_cost,
  safety_score,
};
