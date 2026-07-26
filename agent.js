// RouteWise AI — Gemma 4 autonomous agent
// Provider chain: OpenRouter (primary) → Google AI Studio (fallback), both with retry.
// Canonical message format is OpenAI-style; the Google path translates on demand.
import { GoogleGenAI } from "@google/genai";
import { toolImpls } from "./tools.js";

const OR_KEY = process.env.OPENROUTER_API_KEY;
const OR_MODEL = process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free";
const G_KEY = process.env.GOOGLE_API_KEY;
const G_MODEL = process.env.MODEL || "gemma-4-31b-it";
const genai = G_KEY ? new GoogleGenAI({ apiKey: G_KEY }) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tool schema (OpenAI/JSON-Schema form; works for OpenRouter and, translated, for Google) ──
const TOOLS = [
  {
    name: "get_coordinates",
    description: "Geocode a place name (e.g. 'Mirpur') into lat/lon. Call first for any origin or destination.",
    parameters: { type: "object", properties: { place: { type: "string", description: "Place or area name" } }, required: ["place"] },
  },
  {
    name: "calculate_route",
    description: "Compute route(s) with distance, ETA and alternatives between two coordinates.",
    parameters: {
      type: "object",
      properties: {
        origin_lat: { type: "number" }, origin_lon: { type: "number" },
        dest_lat: { type: "number" }, dest_lon: { type: "number" },
        mode: { type: "string", enum: ["driving", "walking", "cycling"] },
      },
      required: ["origin_lat", "origin_lon", "dest_lat", "dest_lon"],
    },
  },
  {
    name: "get_weather",
    description: "Current weather + 6h rain forecast at a coordinate.",
    parameters: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, required: ["lat", "lon"] },
  },
  {
    name: "get_live_traffic",
    description: "Live/estimated traffic congestion level at a coordinate.",
    parameters: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, required: ["lat", "lon"] },
  },
  {
    name: "find_bus_stops",
    description: "Find nearby bus stops and metro/rail stations around a coordinate.",
    parameters: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" }, radius_m: { type: "number" } }, required: ["lat", "lon"] },
  },
  {
    name: "estimate_travel_cost",
    description: "Estimate cost (BDT ৳) across bus, metro, rickshaw, ride-share and walking for a distance.",
    parameters: { type: "object", properties: { distance_km: { type: "number" } }, required: ["distance_km"] },
  },
  {
    name: "safety_score",
    description: "Compute a 0-100 safety score for an area from street lighting and time of day.",
    parameters: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, required: ["lat", "lon"] },
  },
];
const OPENROUTER_TOOLS = TOOLS.map((t) => ({ type: "function", function: t }));

const SYSTEM = `You are RouteWise AI, an autonomous transit agent for students in Dhaka.
Decide yourself which tools to call: geocode origin+destination, then calculate_route, get_weather, get_live_traffic, and as needed find_bus_stops, estimate_travel_cost, safety_score.
Reason over results: warn about rain (suggest metro/covered), avoid heavy traffic (prefer metro/alternatives), respect any ৳ budget.
To save calls, request independent tools together in one turn when possible.
When you have enough info, STOP calling tools and give a concise recommendation: best option, when to leave, ETA, cost (৳), and weather/traffic/safety warnings.`;

// ─────────────────────────────────────────────────────────────
// Provider adapters — each returns { content, toolCalls } normalized.
// toolCalls: [{ id, name, args }]
// ─────────────────────────────────────────────────────────────
async function callOpenRouter(messages) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OR_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost",
      "X-Title": "RouteWise AI",
    },
    body: JSON.stringify({ model: OR_MODEL, messages, tools: OPENROUTER_TOOLS }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`OpenRouter ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  const j = await res.json();
  const m = j.choices?.[0]?.message || {};
  return {
    content: m.content || "",
    toolCalls: (m.tool_calls || []).map((c) => ({
      id: c.id,
      name: c.function.name,
      args: safeJson(c.function.arguments),
    })),
  };
}

async function callGoogle(messages) {
  // Translate canonical (OpenAI) messages -> Google contents
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") contents.push({ role: "user", parts: [{ text: m.content }] });
    else if (m.role === "assistant") {
      if (m.tool_calls?.length)
        contents.push({ role: "model", parts: m.tool_calls.map((c) => ({ functionCall: { name: c.function.name, args: safeJson(c.function.arguments) } })) });
      else contents.push({ role: "model", parts: [{ text: m.content || "" }] });
    } else if (m.role === "tool") {
      contents.push({ role: "user", parts: [{ functionResponse: { name: m.name, response: { result: safeJson(m.content) } } }] });
    }
  }
  const sys = messages.find((m) => m.role === "system")?.content || SYSTEM;
  const res = await genai.models.generateContent({
    model: G_MODEL,
    contents,
    config: {
      systemInstruction: sys,
      tools: [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }],
    },
  });
  return {
    content: res.text || "",
    toolCalls: (res.functionCalls || []).map((c, i) => ({ id: c.id || `g${i}`, name: c.name, args: c.args || {} })),
  };
}

// Extract a server-suggested retry delay (ms) from a 429 error, if present.
// Handles Google ("retry in 17.3s", "retryDelay":"17s") and OpenRouter Retry-After.
function retryAfterMs(e) {
  const text = `${e.message || ""} ${e.body || ""}`;
  const m =
    text.match(/"retryDelay"\s*:\s*"?([\d.]+)s/i) ||
    text.match(/retry in ([\d.]+)\s*s/i) ||
    text.match(/retry.?after["\s:]*([\d.]+)/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
}

const isRateError = (e) =>
  e.status === 429 ||
  (e.status >= 500 && e.status < 600) ||
  /429|RESOURCE_EXHAUSTED|quota|rate.?limit|temporarily/i.test(`${e.message || ""} ${e.body || ""}`);

// Provider chain with retry that HONORS the per-minute reset window.
// Free tiers reset each minute, so on a 429 we wait the suggested delay (capped) and
// retry the SAME provider before switching — this makes requests self-heal instead of erroring.
async function callModel(messages, onEvent) {
  const providers = [];
  if (OR_KEY) providers.push({ name: "OpenRouter", fn: callOpenRouter });
  if (G_KEY) providers.push({ name: "Google AI", fn: callGoogle });
  if (!providers.length) throw new Error("No model provider configured (set OPENROUTER_API_KEY or GOOGLE_API_KEY).");

  const CAP_MS = 20000; // never wait more than 20s on a single attempt
  let lastErr;

  for (let pi = 0; pi < providers.length; pi++) {
    const p = providers[pi];
    const isLast = pi === providers.length - 1;
    // If a fallback exists, try this provider ONCE and switch fast (no waiting).
    // Only the LAST provider patiently waits out the per-minute reset window.
    const maxAttempts = isLast ? 4 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await p.fn(messages);
      } catch (e) {
        lastErr = e;
        if (!isRateError(e) || attempt === maxAttempts - 1) break; // give up on this provider
        const wait = Math.min(CAP_MS, Math.max(2000 * (attempt + 1), retryAfterMs(e)));
        onEvent?.({ type: "status", text: `${p.name} busy — waiting ${Math.round(wait / 1000)}s to retry…` });
        await sleep(wait);
      }
    }
    if (!isLast) onEvent?.({ type: "status", text: `${p.name} busy — switching provider…` });
  }
  throw lastErr || new Error("All model providers failed.");
}

// ─────────────────────────────────────────────────────────────
// Autonomous agent loop (provider-agnostic, OpenAI canonical messages)
// ─────────────────────────────────────────────────────────────
export async function runAgent(history, userMessage, onEvent = () => {}, location = null) {
  // If the user shared their GPS location, tell the model to use it directly as a
  // coordinate for "my location" / "here" / "near me" (no need to geocode that point).
  const locNote =
    location && Number.isFinite(location.lat) && Number.isFinite(location.lon)
      ? `\n\nThe user's current GPS location is latitude ${location.lat}, longitude ${location.lon}. When they refer to "my location", "current location", "here", "near me", or "home from here", use these exact coordinates as that point directly — do NOT call get_coordinates for it.`
      : "";

  // Give the model the real current date & time in Dhaka so it can reason about
  // "before 9 AM", "now", rush hour, etc.
  const dhakaNow = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka", weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(new Date());
  const timeNote = `\n\nThe current date and time in Dhaka (Asia/Dhaka) is ${dhakaNow}. Use this for any time-based reasoning ("now", "before 9 AM", rush hour, etc.).`;

  const messages = [
    { role: "system", content: SYSTEM + timeNote + locNote },
    ...history,
    { role: "user", content: userMessage },
  ];
  const collected = { routes: null, markers: [], stops: [] };
  const MAX_STEPS = 10;

  for (let step = 0; step < MAX_STEPS; step++) {
    const { content, toolCalls } = await callModel(messages, onEvent);

    if (!toolCalls.length) {
      messages.push({ role: "assistant", content });
      return { reply: content || "(no response)", data: collected, history: stripSystem(messages) };
    }

    // Record assistant tool-call turn
    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    });

    // Execute each tool, feed results back
    for (const call of toolCalls) {
      const fn = toolImpls[call.name];
      onEvent({ type: "tool_call", name: call.name, args: call.args });
      let result;
      try {
        result = fn ? await fn(call.args || {}) : { error: `Unknown tool ${call.name}` };
      } catch (e) {
        result = { error: e.message };
      }
      onEvent({ type: "tool_result", name: call.name, result });
      captureMapData(call.name, call.args, result, collected); // full result -> map
      // Send a SLIM result to the model (strip heavy geometry) to save tokens & avoid rate limits.
      messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: JSON.stringify(slimForModel(call.name, result)) });
    }
  }

  return { reply: "I gathered a lot of data but couldn't finish planning — please refine your request.", data: collected, history: stripSystem(messages) };
}

function stripSystem(messages) {
  // Keep recent context for follow-ups but cap size to limit tokens on later turns.
  return messages.filter((m) => m.role !== "system").slice(-16);
}

// Strip large / irrelevant fields before sending a tool result to the model.
// Keeps per-request tokens low so we stay under the free-tier per-minute limit.
function slimForModel(name, result) {
  if (!result || result.error) return result;
  if (name === "calculate_route" && result.routes) {
    return {
      mode: result.mode,
      distance_km: result.distance_km,
      eta_minutes: result.eta_minutes,
      // drop geometry (huge) + cap to 2 routes; keep only label/distance/eta
      routes: result.routes.slice(0, 2).map(({ label, distance_km, eta_minutes }) => ({ label, distance_km, eta_minutes })),
    };
  }
  if (name === "get_coordinates") {
    // drop long display_name (Bengali address string) — model only needs coords
    return { place: result.place, lat: result.lat, lon: result.lon };
  }
  if (name === "find_bus_stops" && result.stops) {
    return { count: result.count, stops: result.stops.slice(0, 5).map(({ name, type }) => ({ name, type })) };
  }
  return result;
}

function captureMapData(name, args, result, c) {
  if (name === "get_coordinates" && result?.lat) c.markers.push({ label: result.place, lat: result.lat, lon: result.lon, kind: "place" });
  if (name === "calculate_route" && result?.routes) c.routes = result.routes;
  if (name === "find_bus_stops" && result?.stops) c.stops.push(...result.stops);
}

function safeJson(v) {
  if (v == null) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return {}; }
}
