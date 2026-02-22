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
const API_KEY = process.env.API_KEY;

// Service Account JSON stored as env var (recommended for hosting)
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON; // stringified JSON

// ===== RULES (Sanadenta) =====
const WORK_START = "08:00";
const WORK_END = "17:00";
const SLOT_STEP_MINUTES = 15; // slotai kas 15 min

// Service -> duration map (minutes)
// Update names to match what your bot/UI uses exactly
const SERVICE_DURATIONS = {
  Konsultacija: 15,
  "Konsultacija (15 min)": 15,

  "Trumpas vizitas": 30,
  "Kontrolė": 30,
  "Vizitas 30": 30,

  Vizitas: 60,
  "Vizitas 60": 60,
  "Ilgas vizitas": 60,
};

// Fallback duration if service is unknown and durationMinutes isn't provided
const DEFAULT_DURATION_MINUTES = 15;
const ALLOWED_DURATIONS = new Set([15, 30, 60]);

// ===== AUTH / HELPERS =====
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // dev mode; production: set API_KEY
  const incoming = req.header("x-api-key");
  if (!incoming || incoming !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function getAuth() {
  if (!SERVICE_ACCOUNT_JSON) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var");
  let creds;
  try {
    creds = JSON.parse(SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

function isWeekdayAllowed(dateObj) {
  // JS: 0=Sun, 1=Mon ... 6=Sat
  const d = dateObj.getDay();
  return d === 1 || d === 4 || d === 5; // Mon, Thu, Fri
}

function getLastMondayOfMonth(year, monthIndex0) {
  const lastDay = new Date(year, monthIndex0 + 1, 0);
  const d = lastDay.getDay();
  const diff = d >= 1 ? d - 1 : 6; // Sunday -> 6
  return new Date(year, monthIndex0, lastDay.getDate() - diff);
}

function isSurgeonDay(dateObj) {
  const y = dateObj.getFullYear();
  const m = dateObj.getMonth();
  const lastMon = getLastMondayOfMonth(y, m);
  return (
    dateObj.getFullYear() === lastMon.getFullYear() &&
    dateObj.getMonth() === lastMon.getMonth() &&
    dateObj.getDate() === lastMon.getDate()
  );
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function generateDaySlots(dateStr, startHHMM, endHHMM, stepMinutes, durationMinutes) {
  const startTotal = toMinutes(startHHMM);
  const endTotal = toMinutes(endHHMM);

  const latestStart = endTotal - durationMinutes; // inclusive
  const slots = [];
  for (let t = startTotal; t <= latestStart; t += stepMinutes) {
    const hh = Math.floor(t / 60);
    const mm = t % 60;
    slots.push(`${pad2(hh)}:${pad2(mm)}`);
  }
  return slots;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

async function getBusyRanges(calendar, timeMinISO, timeMaxISO) {
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      timeZone: TIME_ZONE,
      items: [{ id: CALENDAR_ID }],
    },
  });

  const busy = fb.data.calendars?.[CALENDAR_ID]?.busy || [];
  return busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

function resolveDuration({ service, durationMinutes }) {
  // 1) If durationMinutes provided, prefer it (but validate)
  if (durationMinutes !== undefined && durationMinutes !== null && String(durationMinutes) !== "") {
    const dur = Number(durationMinutes);
    if (!Number.isFinite(dur)) return { ok: false, error: "Invalid durationMinutes" };
    if (!ALLOWED_DURATIONS.has(dur)) {
      return { ok: false, error: "durationMinutes must be one of: 15, 30, 60" };
    }
    return { ok: true, duration: dur, source: "durationMinutes" };
  }

  // 2) Try to resolve from service map
  if (service && SERVICE_DURATIONS[service]) {
    return { ok: true, duration: SERVICE_DURATIONS[service], source: "service" };
  }

  // 3) Fallback
  return { ok: true, duration: DEFAULT_DURATION_MINUTES, source: "default" };
}

function validateWithinWorkingHours(time, duration) {
  const startMin = toMinutes(time);
  const endMin = startMin + duration;
  const workStartMin = toMinutes(WORK_START);
  const workEndMin = toMinutes(WORK_END);

  return startMin >= workStartMin && endMin <= workEndMin;
}

// ===== ROUTES =====
app.get("/", (req, res) =>
  res.send("Sanadenta API is running. Use /health, /free-slots, /create-booking")
);

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * GET /free-slots?date=YYYY-MM-DD&service=Konsultacija
 * OR  /free-slots?date=YYYY-MM-DD&durationMinutes=30
 */
app.get("/free-slots", requireApiKey, async (req, res) => {
  try {
    const date = String(req.query.date || "").trim(); // YYYY-MM-DD
    const service = req.query.service ? String(req.query.service).trim() : undefined;
    const durationMinutes = req.query.durationMinutes;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD" });
    }

    const resolved = resolveDuration({ service, durationMinutes });
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });
    const dur = resolved.duration;

    const dayObj = new Date(`${date}T00:00:00`);

    if (!isWeekdayAllowed(dayObj)) {
      return res.json({
        ok: true,
        date,
        allowed: false,
        reason: "Clinic does not work this day (allowed: Mon/Thu/Fri).",
        service: service || null,
        durationMinutes: dur,
        slots: [],
      });
    }

    if (isSurgeonDay(dayObj)) {
      return res.json({
        ok: true,
        date,
        allowed: false,
        reason: "Surgeon day (manual scheduling via administrator).",
        service: service || null,
        durationMinutes: dur,
        slots: [],
      });
    }

    const candidateSlots = generateDaySlots(date, WORK_START, WORK_END, SLOT_STEP_MINUTES, dur);

    const calendar = google.calendar({ version: "v3", auth: getAuth() });
    const timeMin = new Date(`${date}T00:00:00`).toISOString();
    const timeMax = new Date(`${date}T23:59:59`).toISOString();
    const busyRanges = await getBusyRanges(calendar, timeMin, timeMax);

    const freeSlots = candidateSlots.filter((hhmm) => {
      // working hours already ensured by generator
      const start = new Date(`${date}T${hhmm}:00`);
      const end = new Date(start.getTime() + dur * 60000);

      for (const b of busyRanges) {
        if (overlaps(start, end, b.start, b.end)) return false;
      }
      return true;
    });

    return res.json({
      ok: true,
      date,
      allowed: true,
      service: service || null,
      durationMinutes: dur,
      durationSource: resolved.source,
      stepMinutes: SLOT_STEP_MINUTES,
      workHours: { start: WORK_START, end: WORK_END },
      slots: freeSlots,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", details: String(err.message || err) });
  }
});

/**
 * POST /create-booking
 * Body: {name, phone, date, time, service, durationMinutes?}
 * - Blocks duplicates via freebusy overlap check.
 * - Checks weekday + surgeon day + working hours.
 */
app.post("/create-booking", requireApiKey, async (req, res) => {
  try {
    const {
      name,
      phone,
      date, // YYYY-MM-DD
      time, // HH:MM
      service = "Konsultacija",
      durationMinutes, // optional; if not provided, resolved from service
    } = req.body;

    if (!name || !phone || !date || !time) {
      return res.status(400).json({ error: "Missing required fields: name, phone, date, time" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD" });
    }
    if (!/^\d{2}:\d{2}$/.test(time)) {
      return res.status(400).json({ error: "Invalid time. Use HH:MM" });
    }

    const resolved = resolveDuration({ service, durationMinutes });
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });
    const dur = resolved.duration;

    // Day rules
    const dayObj = new Date(`${date}T00:00:00`);
    if (!isWeekdayAllowed(dayObj)) {
      return res.status(400).json({ error: "Clinic does not work this day (allowed: Mon/Thu/Fri)." });
    }
    if (isSurgeonDay(dayObj)) {
      return res.status(400).json({ error: "Surgeon day. Please schedule via administrator." });
    }

    // Working hours check
    if (!validateWithinWorkingHours(time, dur)) {
      return res
        .status(400)
        .json({ error: `Outside working hours (${WORK_START}–${WORK_END}).` });
    }

    // Build start/end datetime
    const startDateTime = new Date(`${date}T${time}:00`);
    if (Number.isNaN(startDateTime.getTime())) {
      return res.status(400).json({ error: "Invalid date/time format" });
    }
    const endDateTime = new Date(startDateTime.getTime() + dur * 60000);

    const calendar = google.calendar({ version: "v3", auth: getAuth() });

    // Duplicate / overlap block using freebusy
    const busyRanges = await getBusyRanges(
      calendar,
      new Date(`${date}T00:00:00`).toISOString(),
      new Date(`${date}T23:59:59`).toISOString()
    );

    const hasConflict = busyRanges.some((b) => overlaps(startDateTime, endDateTime, b.start, b.end));
    if (hasConflict) {
      return res.status(409).json({ error: "Time slot is already booked. Please choose another time." });
    }

    // Create event
    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `Sanadenta — ${service} — ${name}`,
        description: `Pacientas: ${name}\nTelefonas: ${phone}\nPaslauga: ${service}\nTrukmė: ${dur} min\nSukurta per Vapi.`,
        start: { dateTime: startDateTime.toISOString(), timeZone: TIME_ZONE },
        end: { dateTime: endDateTime.toISOString(), timeZone: TIME_ZONE },
      },
    });

    return res.json({
      success: true,
      eventId: event.data.id,
      durationMinutes: dur,
      durationSource: resolved.source,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", details: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Sanadenta API running on port ${PORT}`);
});