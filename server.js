// RouteWise AI — Express server with streaming agent endpoint
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") }); // load .env regardless of launch cwd

const { default: express } = await import("express");
const { runAgent } = await import("./agent.js");
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// In-memory session history (single-user demo). Keyed by session id.
const sessions = new Map();

app.post("/api/chat", async (req, res) => {
  const { message, sessionId = "default", location = null } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });

  // Server-Sent Events so the UI can show tool activity live
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const history = sessions.get(sessionId) || [];
    const { reply, data, history: newHistory } = await runAgent(history, message, send, location);
    sessions.set(sessionId, newHistory.slice(-40)); // cap memory
    send({ type: "final", reply, data });
  } catch (e) {
    const blob = `${e.status || ""} ${e.message || ""} ${e.body || ""} ${JSON.stringify(e) || ""}`;
    const rate = e.status === 429 || /429|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(blob);
    send({
      type: "error",
      error: rate
        ? "Both AI providers are rate-limited right now (free tier). Please wait ~30s and try again."
        : "Something went wrong: " + (e.message || "unknown error"),
    });
  }
  res.end();
});

app.post("/api/reset", (req, res) => {
  sessions.delete((req.body || {}).sessionId || "default");
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚍  RouteWise AI running → http://localhost:${PORT}`);
  console.log(`    Primary : OpenRouter ${process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free" : "(none)"}`);
  console.log(`    Fallback: Google AI ${process.env.GOOGLE_API_KEY ? process.env.MODEL || "gemma-4-31b-it" : "(none)"}`);
  console.log(`    Traffic : ${process.env.TOMTOM_API_KEY ? "TomTom (live)" : "estimate"}\n`);
});
