const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// ===== ENV =====
const PORT = process.env.PORT || 3000;

// Calendar settings
const CALENDAR_ID =
  process.env.CALENDAR_ID ||
  "10749b71d8c90e5386ee005cfbb1e2f88ab28329d7dfab9b4fe6281528af92e6@group.calendar.google.com";
const TIME_ZONE = process.env.TIME_ZONE || "Europe/Vilnius";

// Simple auth for your API (recommended)
const API_KEY = process.env.API_KEY; // set this on Render

// Service Account JSON stored as env var (recommended for hosting)
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON; // stringified JSON

function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // if you forgot to set it, don't brick dev; but set it for production
  const incoming = req.header("x-api-key");
  if (!incoming || incoming !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function getAuth() {
  if (!SERVICE_ACCOUNT_JSON) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var");
  }
  let creds;
  try {
    creds = JSON.parse(SERVICE_ACCOUNT_JSON);
  } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/create-booking", requireApiKey, async (req, res) => {
  try {
    const { name, phone, date, time, durationMinutes = 60, service = "Vizitas" } = req.body;

    if (!name || !phone || !date || !time) {
      return res.status(400).json({ error: "Missing required fields: name, phone, date, time" });
    }

    // date: YYYY-MM-DD
    // time: HH:MM (24h)
    const startDateTime = new Date(`${date}T${time}:00`);
    if (Number.isNaN(startDateTime.getTime())) {
      return res.status(400).json({ error: "Invalid date/time format" });
    }

    const endDateTime = new Date(startDateTime.getTime() + Number(durationMinutes) * 60000);

    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `Sanadenta — ${service} — ${name}`,
        description: `Pacientas: ${name}\nTelefonas: ${phone}\nPaslauga: ${service}\nSukurta per Vapi.`,
        start: { dateTime: startDateTime.toISOString(), timeZone: TIME_ZONE },
        end: { dateTime: endDateTime.toISOString(), timeZone: TIME_ZONE },
      },
    });

    return res.json({ success: true, eventId: event.data.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", details: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Sanadenta API running on port ${PORT}`);
});