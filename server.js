const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { google } = require("googleapis");
const { DateTime } = require("luxon");

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// ===== KONFIGŪRACIJA =====
const PORT = process.env.PORT || 3000;
const TIME_ZONE = process.env.TIME_ZONE || "Europe/Vilnius";
const API_KEY = process.env.API_KEY;

const CALENDAR_ID =
  process.env.CALENDAR_ID ||
  "10749b71d8c90e5386ee005cfbb1e2f88ab28329d7dfab9b4fe6281528af92e6@group.calendar.google.com";

// Darbo laikas
const WORK_HOURS = {
  start: "08:00",
  end: "17:00",
  stepMinutes: 15,
};

// Paslaugų trukmės
const SERVICE_DURATIONS = {
  Konsultacija: 15,
  "Trumpas vizitas": 30,
  Vizitas: 60,
};

// ===== CACHE AUTH / CALENDAR =====
let cachedAuth = null;
let cachedCalendar = null;

// ===== HELPER FUNKCIJOS =====
const pad2 = (n) => String(n).padStart(2, "0");
const isValidDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date);
const isValidTime = (time) => /^\d{2}:\d{2}$/.test(time);

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

const isWeekdayAllowed = (dt) => [1, 4, 5].includes(dt.weekday);
// 1 = pirmadienis, 4 = ketvirtadienis, 5 = penktadienis

const getLastMondayOfMonth = (dt) => {
  const lastDay = dt.endOf("month");
  const diff = (lastDay.weekday - 1 + 7) % 7;
  return lastDay.minus({ days: diff }).startOf("day");
};

const isSurgeonDay = (dt) => {
  const lastMon = getLastMondayOfMonth(dt);
  return dt.hasSame(lastMon, "day");
};

const generateSlots = (startHHMM, endHHMM, stepMinutes, durationMinutes) => {
  const [startHour, startMin] = startHHMM.split(":").map(Number);
  const [endHour, endMin] = endHHMM.split(":").map(Number);

  const startTotal = startHour * 60 + startMin;
  const endTotal = endHour * 60 + endMin;
  const latestStart = endTotal - durationMinutes;

  const slots = [];
  for (let t = startTotal; t <= latestStart; t += stepMinutes) {
    slots.push(`${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`);
  }
  return slots;
};

const dtLocal = (date, time) => {
  return DateTime.fromFormat(`${date} ${time}`, "yyyy-MM-dd HH:mm", {
    zone: TIME_ZONE,
  }).setZone(TIME_ZONE, { keepLocalTime: true });
};

const formatHumanDate = (dt) => dt.setLocale("lt").toFormat("dd/MM/yyyy");
const formatHumanDateTime = (dt) => dt.setLocale("lt").toFormat("dd/MM/yyyy HH:mm");

// ===== API KEY MIDDLEWARE =====
const requireApiKey = (req, res, next) => {
  if (!API_KEY) return next();

  const apiKey = req.header("x-api-key");
  if (!apiKey || apiKey !== API_KEY) {
    console.warn(`⚠️ Unauthorized access attempt from ${req.ip}`);
    return res.status(401).json({ error: "Unauthorized - invalid API key" });
  }

  next();
};

// ===== GOOGLE AUTH =====
const getAuth = () => {
  if (cachedAuth) return cachedAuth;

  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!serviceAccountJson) {
    console.error("❌ Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable");
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable");
  }

  try {
    let creds;

    try {
      creds = JSON.parse(serviceAccountJson);
    } catch (e) {
      try {
        const decoded = Buffer.from(serviceAccountJson, "base64").toString();
        creds = JSON.parse(decoded);
        console.log("✅ Successfully decoded base64 service account");
      } catch (e2) {
        throw new Error("Service account JSON is not valid JSON or base64");
      }
    }

    if (!creds.client_email) {
      throw new Error("Service account JSON missing client_email");
    }

    if (!creds.private_key) {
      throw new Error("Service account JSON missing private_key");
    }

    let privateKey = creds.private_key;

    if (privateKey.includes("\\n")) {
      privateKey = privateKey.replace(/\\n/g, "\n");
      console.log("✅ Fixed private_key newlines");
    }

    if (!privateKey.includes("-----BEGIN PRIVATE KEY-----")) {
      privateKey = `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`;
      console.log("✅ Added PEM headers to private_key");
    }

    cachedAuth = new google.auth.JWT({
      email: creds.client_email,
      key: privateKey,
      scopes: [
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/calendar.events",
      ],
    });

    console.log(`✅ Google auth initialized for ${creds.client_email}`);
    return cachedAuth;
  } catch (error) {
    console.error("❌ Auth initialization error:", error.message);
    throw new Error(`Failed to initialize Google Auth: ${error.message}`);
  }
};

// ===== CALENDAR CLIENT =====
const getCalendarClient = () => {
  if (cachedCalendar) return cachedCalendar;

  const auth = getAuth();
  cachedCalendar = google.calendar({ version: "v3", auth });

  console.log("✅ Google Calendar client created");
  return cachedCalendar;
};

// ===== BUSY EVENTS =====
const getBusySlots = async (calendar, timeMin, timeMax) => {
  try {
    console.log(`🔍 Checking calendar events from ${timeMin} to ${timeMax}`);

    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 2500,
    });

    const items = response.data.items || [];

    const busyEvents = items
      .filter((event) => {
        if (event.status === "cancelled") return false;
        if (event.transparency === "transparent") return false;
        if (!event.start || !event.end) return false;
        if (!event.start.dateTime || !event.end.dateTime) return false; // ignoruojam all-day
        return true;
      })
      .map((event) => ({
        start: new Date(event.start.dateTime),
        end: new Date(event.end.dateTime),
        summary: event.summary || "",
        id: event.id || "",
      }));

    console.log(`📊 Found ${busyEvents.length} busy events`);
    return busyEvents;
  } catch (error) {
    console.error("❌ Events.list API error:", error.response?.data || error.message);

    if (error.code === 401 || String(error.message).toLowerCase().includes("auth")) {
      throw new Error("Authentication failed - check service account permissions");
    }

    throw new Error(`Failed to fetch busy slots: ${error.message}`);
  }
};

// ===== ROOT =====
app.get("/", (req, res) =>
  res.json({
    service: "Sanadenta API",
    status: "running",
    version: "3.0",
    endpoints: ["/health", "/free-slots", "/create-booking", "/infobip/call-received"],
  })
);

// ===== HEALTH =====
app.get("/health", async (req, res) => {
  try {
    const calendar = getCalendarClient();

    // Tik health route testuoja ryšį
    const test = await calendar.calendarList.list({ maxResults: 1 });

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      calendar: {
        connected: true,
        calendarId: CALENDAR_ID.substring(0, 20) + "...",
        timezone: TIME_ZONE,
        firstCalendar: test.data.items?.[0]?.summary || "Unknown",
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Calendar connection failed",
      details: error.message,
    });
  }
});

// ===== FREE SLOTS =====
app.get("/free-slots", requireApiKey, async (req, res) => {
  try {
    // No cache
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      "Surrogate-Control": "no-store",
    });

    const { date, service, durationMinutes } = req.query;

    if (!isValidDate(date)) {
      return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
    }

    let duration = 60;
    if (service && SERVICE_DURATIONS[service]) {
      duration = SERVICE_DURATIONS[service];
    } else if (durationMinutes) {
      duration = Number(durationMinutes);
      if (isNaN(duration) || duration <= 0) {
        return res.status(400).json({ error: "Invalid durationMinutes" });
      }
    }

    const dayStart = DateTime.fromISO(date, { zone: TIME_ZONE }).startOf("day");

    if (!isWeekdayAllowed(dayStart) || isSurgeonDay(dayStart)) {
      return res.json({
        ok: true,
        allowed: false,
        date,
        dateDisplay: formatHumanDate(dayStart),
        slots: [],
        message: "No appointments available on this date",
      });
    }

    const allSlots = generateSlots(
      WORK_HOURS.start,
      WORK_HOURS.end,
      WORK_HOURS.stepMinutes,
      duration
    );

    const calendar = getCalendarClient();
    const timeMin = dayStart.toISO();
    const timeMax = dayStart.plus({ days: 1 }).toISO();

    const busySlots = await getBusySlots(calendar, timeMin, timeMax);

    const freeSlots = allSlots.filter((timeSlot) => {
      const start = dtLocal(date, timeSlot);
      const end = start.plus({ minutes: duration });

      const startDate = new Date(start.toUTC().toISO());
      const endDate = new Date(end.toUTC().toISO());

      return !busySlots.some((busy) => overlaps(startDate, endDate, busy.start, busy.end));
    });

    return res.json({
      ok: true,
      allowed: true,
      date,
      dateDisplay: formatHumanDate(dayStart),
      durationMinutes: duration,
      stepMinutes: WORK_HOURS.stepMinutes,
      slots: freeSlots,
      totalSlots: freeSlots.length,
    });
  } catch (error) {
    console.error("❌ FREE-SLOTS ERROR:", error);

    let statusCode = 500;
    let errorMessage = error.message;

    if (error.message.includes("Authentication failed")) {
      statusCode = 503;
      errorMessage = "Calendar service unavailable - authentication issue";
    } else if (error.message.includes("permissions")) {
      statusCode = 403;
      errorMessage = "Calendar access denied - check service account permissions";
    }

    return res.status(statusCode).json({
      error: "Server error",
      message: errorMessage,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// ===== CREATE BOOKING =====
app.post("/create-booking", requireApiKey, async (req, res) => {
  try {
    const { name, phone, date, time, durationMinutes, service = "Vizitas" } = req.body;

    if (!name?.trim() || !phone?.trim() || !date || !time) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["name", "phone", "date", "time"],
      });
    }

    if (!isValidDate(date)) {
      return res.status(400).json({ error: "Invalid date format" });
    }

    if (!isValidTime(time)) {
      return res.status(400).json({ error: "Invalid time format. Use HH:mm" });
    }

    const duration = Number(durationMinutes || SERVICE_DURATIONS[service] || 60);
    if (isNaN(duration) || duration <= 0) {
      return res.status(400).json({ error: "Invalid duration" });
    }

    const dayStart = DateTime.fromISO(date, { zone: TIME_ZONE }).startOf("day");

    if (!isWeekdayAllowed(dayStart) || isSurgeonDay(dayStart)) {
      return res.status(400).json({
        error: "Selected date is not available for appointments",
      });
    }

    const validSlots = generateSlots(
      WORK_HOURS.start,
      WORK_HOURS.end,
      WORK_HOURS.stepMinutes,
      duration
    );

    if (!validSlots.includes(time)) {
      return res.status(400).json({
        error: "Invalid appointment start time",
      });
    }

    const startDT = dtLocal(date, time);
    const endDT = startDT.plus({ minutes: duration });

    if (!startDT.isValid || !endDT.isValid) {
      return res.status(400).json({ error: "Invalid appointment date/time" });
    }

    if (startDT < DateTime.now().setZone(TIME_ZONE)) {
      return res.status(400).json({ error: "Cannot book appointments in the past" });
    }

    console.log(`📝 Creating booking: ${name} - ${date} ${time} (${duration}min)`);

    const calendar = getCalendarClient();

    // Prieš kuriant dar kartą tikriname konfliktą
    const timeMin = startDT.toISO();
    const timeMax = endDT.toISO();

    const busySlots = await getBusySlots(calendar, timeMin, timeMax);

    const startDate = new Date(startDT.toUTC().toISO());
    const endDate = new Date(endDT.toUTC().toISO());

    if (busySlots.some((b) => overlaps(startDate, endDate, b.start, b.end))) {
      return res.status(409).json({
        error: "Time slot already booked",
        message: "Selected time is no longer available",
      });
    }

    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `Sanadenta — ${service} — ${name}`,
        description:
          `Pacientas: ${name}\n` +
          `Telefonas: ${phone}\n` +
          `Paslauga: ${service}\n` +
          `Trukmė: ${duration} min\n` +
          `Rezervuota: ${new Date().toISOString()}`,
        start: {
          dateTime: startDT.toISO(),
          timeZone: TIME_ZONE,
        },
        end: {
          dateTime: endDT.toISO(),
          timeZone: TIME_ZONE,
        },
      },
    });

    console.log(`✅ Booking created successfully: ${event.data.id}`);

    return res.json({
      success: true,
      eventId: event.data.id,
      eventLink: event.data.htmlLink,
      reservedUntil: endDT.toFormat("HH:mm"),
      date: startDT.toFormat("yyyy-MM-dd"),
      dateDisplay: formatHumanDate(startDT),
      dateTimeDisplay: formatHumanDateTime(startDT),
      time: startDT.toFormat("HH:mm"),
      service,
      duration,
    });
  } catch (error) {
    console.error("❌ CREATE-BOOKING ERROR:", error);

    if (error.response?.data?.error) {
      const googleError = error.response.data.error;
      console.error("Google API Error:", googleError);

      return res.status(error.response.status || 500).json({
        error: "Google Calendar API error",
        message: googleError.message,
        code: googleError.code,
        details: process.env.NODE_ENV === "development" ? googleError : undefined,
      });
    }

    return res.status(500).json({
      error: "Server error",
      message: error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// ===== INFOBIP WEBHOOK =====
app.post("/infobip/call-received", (req, res) => {
  console.log("🚀 Gautas skambutis!");
  console.log("Body:", JSON.stringify(req.body, null, 2));

  res.json({
    action: {
      name: "say",
      text: "Sveiki, čia Sanadenta.",
      language: "lt",
    },
  });
});

// ===== DEBUG ENDPOINT =====
if (process.env.NODE_ENV !== "production") {
  app.get("/debug/auth", async (req, res) => {
    try {
      const auth = getAuth();
      const calendar = getCalendarClient();

      const calendarList = await calendar.calendarList.list();
      const now = new Date().toISOString();

      const events = await calendar.events.list({
        calendarId: CALENDAR_ID,
        maxResults: 5,
        timeMin: now,
        singleEvents: true,
        orderBy: "startTime",
      });

      res.json({
        success: true,
        auth: {
          email: auth.email,
          scopes: auth.scopes,
        },
        calendars: calendarList.data.items?.map((c) => ({
          id: c.id,
          summary: c.summary,
          accessRole: c.accessRole,
        })),
        sampleEvents: events.data.items?.map((e) => ({
          id: e.id,
          summary: e.summary,
          start: e.start,
          end: e.end,
          status: e.status,
        })),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        response: error.response?.data,
      });
    }
  });
}

// ===== 404 =====
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ===== GLOBAL ERROR =====
app.use((err, req, res, next) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: process.env.NODE_ENV === "development" ? err.message : "Something went wrong",
  });
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`\n🚀 Sanadenta API running on port ${PORT}`);
  console.log(`📍 Timezone: ${TIME_ZONE}`);
  console.log(`📅 Calendar ID: ${CALENDAR_ID.substring(0, 20)}...`);
  console.log(`🔑 API Key protection: ${API_KEY ? "ON" : "OFF"}`);

  console.log(`\n📋 Endpoints:`);
  console.log(`   GET  /`);
  console.log(`   GET  /health`);
  console.log(`   GET  /free-slots?date=YYYY-MM-DD&service=...`);
  console.log(`   POST /create-booking`);
  console.log(`   POST /infobip/call-received (IVR webhook)`);

  if (process.env.NODE_ENV !== "production") {
    console.log(`   GET  /debug/auth (development only)`);
  }

  console.log(`\n✅ Server ready\n`);
});