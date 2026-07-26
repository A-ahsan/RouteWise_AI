# RouteWise AI

An autonomous transit assistant for Dhaka, powered by **Gemma 4 native function calling**.

Ask a question in plain language — *"What's the best way to reach UIU from Mirpur before 9 AM?"* — and the agent decides on its own which tools to call (geocoding, routing, weather, traffic, transit, cost, safety), reasons over the results, and replies with a clear recommendation on an interactive map.

---

## Highlights

- **Autonomous agent** — the model chooses the tools and their order; the user never wires the flow.
- **Runs on free APIs** — OpenStreetMap, OSRM, Open-Meteo and more; no paid services required.
- **Resilient by design** — dual model providers with automatic failover and rate-limit handling.
- **Location-aware** — share your GPS and ask *"route home from here"*; time-aware for *"before 9 AM"* reasoning.
- **Live UI** — an interactive map with colour-coded pins and a chat panel that shows each step as it happens.

**You must share your current location to get any response accurately like "how far is xyz location from me?"**

---

## How it works

```
User request
     │
     ▼
  Gemma 4  ──▶  decides which tools to call, in what order
     │
     ├─ get_coordinates      (Nominatim → Photon)
     ├─ calculate_route      (OSRM)
     ├─ get_weather          (Open-Meteo)
     ├─ get_live_traffic     (TomTom / estimate)
     ├─ find_bus_stops       (Overpass)
     ├─ estimate_travel_cost (Dhaka fare model)
     └─ safety_score         (OSM lighting + time of day)
     │
     ▼
Natural-language recommendation + route on the map
```

## Tools

| Tool | Data source | API key |
| --- | --- | --- |
| `get_coordinates` | Nominatim → Photon (OpenStreetMap) | Not required |
| `calculate_route` | OSRM | Not required |
| `get_weather` | Open-Meteo | Not required |
| `get_live_traffic` | TomTom, else rush-hour estimate | Optional |
| `find_bus_stops` | Overpass (OpenStreetMap) | Not required |
| `estimate_travel_cost` | Dhaka fare model (BDT ৳) | Not required |
| `safety_score` | OSM street lighting + time of day | Not required |

Every core tool is keyless — the app needs only a model API key to run.

## Model providers

Gemma 4 runs through a provider chain so a throttled free tier never breaks the experience:

1. **OpenRouter** (primary) — `google/gemma-4-31b-it:free`
2. **Google AI Studio** (fallback) — `gemma-4-31b-it`

Requests are kept small (route geometry is stripped before it reaches the model) to stay within free-tier token limits, and failed calls are retried with backoff. If both providers are momentarily rate-limited, the UI shows a brief "try again" message instead of an error.

## Getting started

```bash
npm install
cp .env.example .env     # then add your keys
npm start
```

Open **http://localhost:3000** and try:

- *"Best way from Mirpur to UIU before 9 AM?"*
- *"Cheapest way from Dhanmondi to Uttara under ৳100?"*
- *"Is it safe to travel from Gulshan to Motijheel right now?"*
- Click **📍** on the map, then *"route to UIU from my location"*.

## Configuration

Set these in `.env` (locally) or your host's environment variables:

| Variable | Purpose | Required |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Primary model provider | Yes* |
| `OPENROUTER_MODEL` | Defaults to `google/gemma-4-31b-it:free` | No |
| `GOOGLE_API_KEY` | Fallback model provider | Yes* |
| `MODEL` | Defaults to `gemma-4-31b-it` | No |
| `ORS_API_KEY` | Better routing (OpenRouteService) | No |
| `TOMTOM_API_KEY` | Live traffic instead of estimate | No |
| `PORT` | Server port (default `3000`) | No |

\* At least one model provider is required; configuring both enables failover.

## Deployment

The app is a persistent Node server using Server-Sent Events, so it needs a host that runs a long-lived web service (not a serverless function). A free **Render** Web Service works well:

1. Push the repo to GitHub (`.env` is gitignored).
2. Render → **New → Web Service** → connect the repo.
3. Build: `npm install` · Start: `npm start`.
4. Add the environment variables above under **Environment**.

HTTPS is provided automatically, which the browser requires for the location feature. Koyeb and Fly.io are comparable alternatives.

## Project structure

```
routewise/
├── server.js        Express server + SSE streaming endpoint
├── agent.js         Gemma agent loop, tool declarations, provider failover
├── tools.js         Tool implementations (mapping, weather, traffic, transit)
└── public/
    ├── index.html   Chat + map layout
    └── app.js       Leaflet map, live tool feed, geolocation, clock
```

**Stack:** Node.js · Express · `@google/genai` · OpenStreetMap · Leaflet · Tailwind CSS

## Notes

- Conversation state is kept per session, so follow-up questions retain context.
- `find_bus_stops` and `safety_score` depend on OpenStreetMap community data and may be sparse in some areas; the agent handles this gracefully.
- The interface uses Dhaka time (`Asia/Dhaka`) for both the on-screen clock and the agent's time reasoning.

## License

MIT
