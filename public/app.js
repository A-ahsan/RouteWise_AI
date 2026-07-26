// RouteWise AI — frontend logic
const chat = document.getElementById("chat");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const sessionId = "s-" + Math.floor(Date.now() / 1000);

// ── Map ──
const map = L.map("map", { zoomControl: true }).setView([23.78, 90.4], 12);
// Light basemap (CARTO Voyager — clear labels)
L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  attribution: "© OpenStreetMap © CARTO", maxZoom: 19,
}).addTo(map);
let layers = [];

// Colored teardrop pin icons so each marker type is visually distinct.
function pinIcon(color) {
  return L.divIcon({
    className: "",
    html: `<svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 0C6.3 0 0 6.3 0 14c0 9.6 14 26 14 26s14-16.4 14-26C28 6.3 21.7 0 14 0z" fill="${color}" stroke="#fff" stroke-width="2.5"/>
      <circle cx="14" cy="14" r="5.5" fill="#fff"/></svg>`,
    iconSize: [28, 40], iconAnchor: [14, 40], popupAnchor: [0, -36],
  });
}
const COLOR = { start: "#16a34a", end: "#dc2626", me: "#2563eb" }; // green / red / blue
const clearMap = () => { layers.forEach((l) => map.removeLayer(l)); layers = []; };

// ── "My location" control ──
let meMarker = null;
const LocateControl = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const btn = L.DomUtil.create("a", "leaflet-bar leaflet-control leaflet-control-custom");
    btn.href = "#";
    btn.title = "Show my current location";
    btn.innerHTML = "📍";
    Object.assign(btn.style, {
      width: "34px", height: "34px", lineHeight: "34px", textAlign: "center",
      fontSize: "18px", background: "#0f172a", color: "#fff", cursor: "pointer",
    });
    L.DomEvent.on(btn, "click", (e) => { L.DomEvent.stop(e); locateMe(); });
    return btn;
  },
});
map.addControl(new LocateControl());

function locateMe() {
  if (!navigator.geolocation) return alert("Geolocation not supported by this browser.");
  const status = toolChip("📍 Locating you…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      status.remove();
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      if (meMarker) map.removeLayer(meMarker);
      meMarker = L.layerGroup([
        L.circle([lat, lon], { radius: accuracy, color: COLOR.me, fillColor: COLOR.me, fillOpacity: 0.12, weight: 1 }),
        L.marker([lat, lon], { icon: pinIcon(COLOR.me) })
          .bindPopup(`<b>📍 You are here</b><br>${lat.toFixed(5)}, ${lon.toFixed(5)}`),
      ]).addTo(map);
      map.setView([lat, lon], 15);
      meMarker.getLayers()[1].openPopup();
      window.__myLocation = { lat, lon };
      bubble("assistant", "📍 Got your current location. You can now say things like <b>“route to UIU from my location”</b> or <b>“cheapest way home from here”</b>.");
    },
    (err) => { status.remove(); alert("Couldn't get your location: " + err.message); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

const toolLabels = {
  get_coordinates: "📍 Geocoding location",
  calculate_route: "🛣️ Calculating routes",
  get_weather: "🌦️ Checking weather",
  get_live_traffic: "🚦 Reading live traffic",
  find_bus_stops: "🚏 Finding transit stops",
  estimate_travel_cost: "💰 Estimating costs",
  safety_score: "🛡️ Scoring safety",
};

// ── Chat bubbles ──
function bubble(role, html) {
  const wrap = document.createElement("div");
  wrap.className = "msg-fade " + (role === "user" ? "flex justify-end" : "");
  wrap.innerHTML =
    role === "user"
      ? `<div class="bg-emerald-500 text-slate-900 rounded-2xl rounded-br-sm px-3.5 py-2 max-w-[85%]">${html}</div>`
      : `<div class="bg-slate-800 rounded-2xl rounded-bl-sm px-3.5 py-2.5 max-w-[92%] leading-relaxed">${html}</div>`;
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return wrap;
}

function toolChip(text) {
  const el = document.createElement("div");
  el.className = "msg-fade flex items-center gap-2 text-xs text-slate-400 pl-1";
  el.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>${text}`;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

// tiny markdown: **bold**, newlines, ৳
function md(t) {
  return t
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\n/g, "<br>");
}

async function send() {
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  bubble("user", md(message));
  sendBtn.disabled = true;

  const thinking = toolChip("Gemma is thinking…");
  let mapData = null;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId, location: window.__myLocation || null }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const ev of events) {
        if (!ev.startsWith("data: ")) continue;
        const d = JSON.parse(ev.slice(6));
        if (d.type === "status") {
          // Internal provider/retry chatter — intentionally not shown to the user.
        } else if (d.type === "tool_call") {
          thinking.remove();
          toolChip(toolLabels[d.name] || d.name);
        } else if (d.type === "final") {
          bubble("assistant", md(d.reply));
          mapData = d.data;
        } else if (d.type === "error") {
          bubble("assistant", "⚠️ " + md(d.error));
        }
      }
    }
    if (mapData) drawMap(mapData);
  } catch (e) {
    thinking.remove();
    bubble("assistant", "⚠️ Connection error: " + e.message);
  }
  sendBtn.disabled = false;
  input.focus();
}

function drawMap(data) {
  clearMap();
  const bounds = [];
  const colors = ["#34d399", "#60a5fa", "#f472b6"];

  (data.routes || []).forEach((r, i) => {
    if (!r.geometry?.length) return;
    const line = L.polyline(r.geometry, {
      color: colors[i % colors.length], weight: i === 0 ? 5 : 3,
      opacity: i === 0 ? 0.95 : 0.5, dashArray: i === 0 ? null : "6 8",
    }).addTo(map);
    line.bindTooltip(`${r.label}: ${r.distance_km} km · ${r.eta_minutes} min`);
    layers.push(line);
    r.geometry.forEach((p) => bounds.push(p));
  });

  const markers = data.markers || [];
  markers.forEach((m, i) => {
    // First place = start (green), last = destination (red); middle = red too.
    const kind = i === 0 ? "start" : "end";
    const label = i === 0 ? "Start" : i === markers.length - 1 ? "Destination" : "Stop";
    const mk = L.marker([m.lat, m.lon], { icon: pinIcon(COLOR[kind]) })
      .addTo(map)
      .bindPopup(`<b>${label}:</b> ${m.label}`);
    layers.push(mk);
    bounds.push([m.lat, m.lon]);
  });

  (data.stops || []).forEach((s) => {
    const c = L.circleMarker([s.lat, s.lon], {
      radius: 5, color: "#fbbf24", fillColor: "#fbbf24", fillOpacity: 0.8,
    }).addTo(map).bindTooltip(`${s.name} (${s.type})`);
    layers.push(c);
  });

  if (bounds.length) map.fitBounds(bounds, { padding: [50, 50] });

  const legend = document.getElementById("legend");
  if ((data.routes || []).length || markers.length) {
    legend.classList.remove("hidden");
    const pinDot = (c) => `<span class="inline-block w-2.5 h-2.5 rounded-full" style="background:${c};box-shadow:0 0 0 1.5px #fff"></span>`;
    legend.innerHTML =
      (data.routes || []).length
        ? `<div class="font-semibold mb-1 text-slate-200">Routes</div>` +
          data.routes.map((r, i) =>
            `<div class="flex items-center gap-2"><span class="inline-block w-4 h-1 rounded" style="background:${colors[i % colors.length]}"></span>${r.label} · ${r.eta_minutes} min · ${r.distance_km} km</div>`
          ).join("")
        : "";
    legend.innerHTML +=
      `<div class="font-semibold mt-2 mb-1 text-slate-200">Pins</div>` +
      `<div class="flex items-center gap-2">${pinDot(COLOR.start)}Start</div>` +
      `<div class="flex items-center gap-2">${pinDot(COLOR.end)}Destination</div>` +
      `<div class="flex items-center gap-2">${pinDot(COLOR.me)}My location</div>` +
      (data.stops?.length ? `<div class="flex items-center gap-2">${pinDot("#fbbf24")}Transit stops</div>` : "");
  }
}

// ── Suggestions ──
const SUGGESTIONS = [
  "I need to reach UIU before 9 AM from Mirpur. Best way?",
  "Cheapest way from Dhanmondi to Uttara under ৳100?",
  "Is it safe to travel from Gulshan to Motijheel now?",
];
const sc = document.getElementById("suggestions");
SUGGESTIONS.forEach((s) => {
  const b = document.createElement("button");
  b.className = "text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-full px-2.5 py-1";
  b.textContent = s.length > 34 ? s.slice(0, 32) + "…" : s;
  b.title = s;
  b.onclick = () => { input.value = s; send(); };
  sc.appendChild(b);
});

sendBtn.onclick = send;
input.addEventListener("keydown", (e) => e.key === "Enter" && send());
document.getElementById("reset").onclick = async () => {
  await fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) });
  chat.innerHTML = ""; clearMap();
  document.getElementById("legend").classList.add("hidden");
  greeting();
};

function greeting() {
  bubble("assistant", "Hi! I'm <b>RouteWise AI</b> 🚍 — tell me where you want to go in Dhaka and I'll autonomously plan the best route, checking weather, traffic, transit stops, cost and safety for you.");
}
greeting();

// ── Live Dhaka clock (same timezone the agent reasons with) ──
function tickClock() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", weekday: "short", day: "numeric", month: "short" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).format(now);
  document.getElementById("clock").innerHTML = `<div class="text-slate-300">${date}</div><div class="font-semibold text-emerald-400">${time}</div><div class="text-[9px] text-slate-500">Dhaka</div>`;
}
tickClock();
setInterval(tickClock, 1000);
