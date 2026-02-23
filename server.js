const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { google } = require("googleapis");
const { DateTime } = require("luxon");

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

// Simple auth for your API
const API_KEY = process.env.API_KEY;

// Service Account JSON stored as env var
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// ===== Helpers: rules =====
function isWeekdayAllowed(dateObj) {
  // dateObj is a Luxon DateTime or JS Date; we'll use Luxon in this file
  const d = dateObj.weekday; // 1=Mon ... 7=Sun
  return d === 1 || d === 4 || d === 5; // Mon, Thu, Fri
}

function getLastMondayOfMonthLuxon(dt) {
  // dt is Luxon DateTime in TIME_ZONE
  const lastDay = dt.endOf("month"); // last moment of month
  // Move back to Monday
  const diff = (lastDay.weekday - 1 + 7) % 7; // 0..6
  return lastDay.minus({ days: diff }).startOf("day");
}

function isSurgeonDayLuxon(dayStart) {
  // last Monday of the month
  const lastMon = getLastMondayOfMonthLuxon(dayStart);
  return (
    dayStart.year === lastMon.year &&
    dayStart.month === lastMon.month &&
    dayStart.day === lastMon.day
  );
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Build Luxon DateTime in clinic TZ from date + time (local wall clock time)
function dtInClinicTZ(dateStrYYYYMMDD, hhmm) {
  // Example: DateTime.fromISO("2026-02-26T12:00", { zone: "Europe/Vilnius" })
  return DateTime.fromISO(`${dateStrYYYYMMDD}T${hhmm}`, { zone: TIME_ZONE });
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function generateDaySlots(startHHMM, endHHMM, stepMinutes, durationMinutes) {
  const [sh, sm] = startHHMM.split(":").map(Number);
  const [eh, em] = endHHMM.split(":").map(Number);

  const startTotal = sh * 60 + sm;
  const endTotal = eh * 60 + em;

  const latestStart = endTotal - durationMinutes;
  const slots = [];
  for (let t = startTotal; t <= latestStart; t += stepMinutes) {
    const hh = Math.floor(t / 60);
    const mm = t % 60;
    slots.push(`${pad2(hh)}:${pad2(mm)}`);
  }
  return slots;
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

  // Important: busy start/end are ISO with timezone; Date() parses correctly.
  return busy.map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));
}

// ===== Auth =====
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
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
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
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
    const durationMinutesRaw = req.query.durationMinutes;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD" });
    }

    // Service durations (turi atitikti tavo front-end select values)
    const SERVICE_DURATIONS = {
      Konsultacija: 15,
      "Trumpas vizitas": 30,
      Vizitas: 60,
    };

    let durationMinutes = 60;
    let durationSource = "default";

    if (service && SERVICE_DURATIONS[service]) {
      durationMinutes = SERVICE_DURATIONS[service];
      durationSource = "service";
    } else if (durationMinutesRaw !== undefined) {
      const n = Number(durationMinutesRaw);
      if (!Number.isFinite(n) || n <= 0 || n > 240) {
        return res.status(400).json({ error: "Invalid durationMinutes" });
      }
      durationMinutes = n;
      durationSource = "durationMinutes";
    }

    // Build day start in clinic TZ
    const dayStart = DateTime.fromISO(date, { zone: TIME_ZONE }).startOf("day");

    // Rules: allowed weekdays only
    if (!isWeekdayAllowed(dayStart)) {
      return res.json({
        ok: true,
        date,
        allowed: false,
        reason: "Clinic does not work this day (allowed: Mon/Thu/Fri).",
        service: service || null,
        durationMinutes,
        durationSource,
        slots: [],
      });
    }

    // Rule: last Monday of month = surgeon day (bot must not self-book)
    if (isSurgeonDayLuxon(dayStart)) {
      return res.json({
        ok: true,
        date,
        allowed: false,
        reason: "Surgeon day (manual scheduling via administrator).",
        service: service || null,
        durationMinutes,
        durationSource,
        slots: [],
      });
    }

    // Working hours
    const WORK_START = "08:00";
    const WORK_END = "17:00";
    const STEP = 15; // always 15-minute grid

    const candidateSlots = generateDaySlots(WORK_START, WORK_END, STEP, durationMinutes);

    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });

    // timeMin/timeMax for that day in clinic TZ, then convert to ISO (UTC)
    const timeMin = dayStart.toUTC().toISO();
    const timeMax = dayStart.plus({ days: 1 }).toUTC().toISO();

    const busyRanges = await getBusyRanges(calendar, timeMin, timeMax);

    const freeSlots = candidateSlots.filter((hhmm) => {
      const startDT = dtInClinicTZ(date, hhmm);
      const endDT = startDT.plus({ minutes: durationMinutes });

      // Compare in UTC using JS Date (stable)
      const start = new Date(startDT.toUTC().toISO());
      const end = new Date(endDT.toUTC().toISO());

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
      durationMinutes,
      durationSource,
      stepMinutes: STEP,
      workHours: { start: WORK_START, end: WORK_END },
      slots: freeSlots,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", details: String(err.message || err) });
  }
});

app.post("/create-booking", requireApiKey, async (req, res) => {
  try {
    const { name, phone, date, time, durationMinutes, service = "Vizitas" } = req.body;

    if (!name || !phone || !date || !time) {
      return res.status(400).json({ error: "Missing required fields: name, phone, date, time" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
    }
    if (!/^\d{2}:\d{2}$/.test(String(time))) {
      return res.status(400).json({ error: "Invalid time format. Use HH:MM" });
    }

    const dur = Number(durationMinutes || 60);
    if (!Number.isFinite(dur) || dur <= 0 || dur > 240) {
      return res.status(400).json({ error: "Invalid durationMinutes" });
    }

    // Create start/end in clinic TZ, then send to Google with offset
    const startDT = dtInClinicTZ(date, time);
    if (!startDT.isValid) {
      return res.status(400).json({ error: "Invalid date/time" });
    }
    const endDT = startDT.plus({ minutes: dur });

    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });

    // 1) Check duplicates/overlaps using freebusy for exact range
    const fbMin = startDT.toUTC().toISO();
    const fbMax = endDT.toUTC().toISO();
    const busyRanges = await getBusyRanges(calendar, fbMin, fbMax);

    const start = new Date(startDT.toUTC().toISO());
    const end = new Date(endDT.toUTC().toISO());
    const conflict = busyRanges.some((b) => overlaps(start, end, b.start, b.end));

    if (conflict) {
      return res.status(409).json({ error: "Time slot is already booked" });
    }

    // 2) Insert event (use ISO with offset, not toISOString())
    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `Sanadenta — ${service} — ${name}`,
        description: `Pacientas: ${name}\nTelefonas: ${phone}\nPaslauga: ${service}\nSukurta per web registraciją.`,
        start: { dateTime: startDT.toISO(), timeZone: TIME_ZONE },
        end: { dateTime: endDT.toISO(), timeZone: TIME_ZONE },
      },
    });

    return res.json({
      success: true,
      eventId: event.data.id,
      reservedUntil: endDT.toFormat("HH:mm"),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", details: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Sanadenta API running on port ${PORT}`);
});