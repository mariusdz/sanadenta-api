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

const CALENDAR_ID =
  process.env.CALENDAR_ID ||
  "10749b71d8c90e5386ee005cfbb1e2f88ab28329d7dfab9b4fe6281528af92e6@group.calendar.google.com";

const TIME_ZONE = process.env.TIME_ZONE || "Europe/Vilnius";
const API_KEY = process.env.API_KEY;
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// ===== Helpers =====
function pad2(n) {
  return String(n).padStart(2, "0");
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function isWeekdayAllowed(dt) {
  return dt.weekday === 1 || dt.weekday === 4 || dt.weekday === 5;
}

function getLastMondayOfMonth(dt) {
  const lastDay = dt.endOf("month");
  const diff = (lastDay.weekday - 1 + 7) % 7;
  return lastDay.minus({ days: diff }).startOf("day");
}

function isSurgeonDay(dt) {
  const lastMon = getLastMondayOfMonth(dt);
  return dt.hasSame(lastMon, "day");
}

function generateSlots(startHHMM, endHHMM, stepMinutes, durationMinutes) {
  const [sh, sm] = startHHMM.split(":").map(Number);
  const [eh, em] = endHHMM.split(":").map(Number);

  const startTotal = sh * 60 + sm;
  const endTotal = eh * 60 + em;
  const latestStart = endTotal - durationMinutes;

  const slots = [];
  for (let t = startTotal; t <= latestStart; t += stepMinutes) {
    slots.push(`${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`);
  }
  return slots;
}

function dtLocal(date, time) {
  // Force Europe/Vilnius zone even if server runs in UTC
  const dt = DateTime.fromFormat(`${date} ${time}`, "yyyy-MM-dd HH:mm", {
    zone: TIME_ZONE,
  });
  return dt.setZone(TIME_ZONE, { keepLocalTime: true });
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.header("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function getAuth() {
  if (!SERVICE_ACCOUNT_JSON) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var on Render");
  }

  let creds;
  try {
    creds = JSON.parse(SERVICE_ACCOUNT_JSON);
  } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  if (!creds.client_email || !creds.private_key) {
    throw new Error("Service account JSON missing client_email/private_key");
  }

  // ✅ Critical fix: Render env often stores newlines as \\n
  const fixedKey = String(creds.private_key).replace(/\\n/g, "\n");

  return new google.auth.JWT({
    email: creds.client_email,
    key: fixedKey,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}


async function getBusy(calendar, timeMin, timeMax) {
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      timeZone: TIME_ZONE,
      items: [{ id: CALENDAR_ID }],
    },
  });

  return (fb.data.calendars?.[CALENDAR_ID]?.busy || []).map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));
}

// ===== ROUTES =====
app.get("/", (req, res) =>
  res.send("Sanadenta API is running")
);

app.get("/health", (req, res) =>
  res.json({ ok: true })
);

app.get("/free-slots", requireApiKey, async (req, res) => {
  try {
    const date = req.query.date;
    const service = req.query.service;
    const durationRaw = req.query.durationMinutes;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Invalid date" });
    }

    const SERVICE_DURATIONS = {
      Konsultacija: 15,
      "Trumpas vizitas": 30,
      Vizitas: 60,
    };

    let duration = 60;
    if (service && SERVICE_DURATIONS[service]) {
      duration = SERVICE_DURATIONS[service];
    } else if (durationRaw) {
      duration = Number(durationRaw);
    }

    const dayStart = DateTime.fromISO(date, { zone: TIME_ZONE }).startOf("day");

    if (!isWeekdayAllowed(dayStart)) {
      return res.json({ ok: true, allowed: false, slots: [] });
    }

    if (isSurgeonDay(dayStart)) {
      return res.json({ ok: true, allowed: false, slots: [] });
    }

    const WORK_START = "08:00";
    const WORK_END = "17:00";
    const STEP = 15;

    const slots = generateSlots(WORK_START, WORK_END, STEP, duration);

    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const timeMin = dayStart.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    const timeMax = dayStart.plus({ days: 1 }).toFormat("yyyy-MM-dd'T'HH:mm:ss");

    const busy = await getBusy(calendar, timeMin, timeMax);

    const free = slots.filter((t) => {
      const start = dtLocal(date, t);
      const end = start.plus({ minutes: duration });

      const s = new Date(start.toUTC().toISO());
      const e = new Date(end.toUTC().toISO());

      return !busy.some((b) => overlaps(s, e, b.start, b.end));
    });

    res.json({
      ok: true,
      allowed: true,
      date,
      durationMinutes: duration,
      stepMinutes: STEP,
      slots: free,
    });

  } catch (err) {
  console.error("FREE-SLOTS ERROR:", err);
  return res.status(500).json({ error: "Server error", details: String(err.message || err) });
}
});

app.post("/create-booking", requireApiKey, async (req, res) => {
  try {
    const { name, phone, date, time, durationMinutes, service = "Vizitas" } = req.body;

    if (!name || !phone || !date || !time) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const duration = Number(durationMinutes || 60);
    const startDT = dtLocal(date, time);
    const endDT = startDT.plus({ minutes: duration });

    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });

    // Check conflict
    const fbMin = startDT.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    const fbMax = endDT.toFormat("yyyy-MM-dd'T'HH:mm:ss");

    const busy = await getBusy(calendar, fbMin, fbMax);

    const s = new Date(startDT.toUTC().toISO());
    const e = new Date(endDT.toUTC().toISO());

    if (busy.some((b) => overlaps(s, e, b.start, b.end))) {
      return res.status(409).json({ error: "Time slot already booked" });
    }

    console.log("DEBUG startDT:", startDT.toString(), "ISO:", startDT.toISO());
    console.log("DEBUG zone:", startDT.zoneName, "offset:", startDT.offset);

    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `Sanadenta — ${service} — ${name}`,
        description: `Pacientas: ${name}\nTelefonas: ${phone}`,
        start: { dateTime: startDT.toISO(), timeZone: TIME_ZONE },
        end: { dateTime: endDT.toISO(), timeZone: TIME_ZONE },
      },
    });

    res.json({
      success: true,
      eventId: event.data.id,
      reservedUntil: endDT.toFormat("HH:mm"),
    });

  } catch (err) {
  console.error("CREATE-BOOKING ERROR:", err);
  return res.status(500).json({ error: "Server error", details: String(err.message || err) });
}
});

app.listen(PORT, () => {
  console.log(`Sanadenta API running on port ${PORT}`);
});