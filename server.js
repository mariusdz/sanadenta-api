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

const CALENDAR_ID = process.env.CALENDAR_ID || 
  "10749b71d8c90e5386ee005cfbb1e2f88ab28329d7dfab9b4fe6281528af92e6@group.calendar.google.com";

// Darbo laikas
const WORK_HOURS = {
  start: "08:00",
  end: "17:00",
  stepMinutes: 15
};

// Paslaugų trukmės
const SERVICE_DURATIONS = {
  Konsultacija: 15,
  "Trumpas vizitas": 30,
  Vizitas: 60
};

// ===== HELPER FUNKCIJOS =====
const pad2 = (n) => String(n).padStart(2, "0");

const isValidDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date);

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

const isWeekdayAllowed = (dt) => [1, 4, 5].includes(dt.weekday); // Pirmadienis, Ketvirtadienis, Penktadienis

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
  return DateTime.fromFormat(`${date} ${time}`, "yyyy-MM-dd HH:mm", { zone: TIME_ZONE })
    .setZone(TIME_ZONE, { keepLocalTime: true });
};

// ===== AUTENTIFIKACIJA =====
const requireApiKey = (req, res, next) => {
  if (!API_KEY) return next();
  if (req.header("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

const getAuth = () => {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable");
  }

  try {
    const creds = JSON.parse(serviceAccountJson);
    
    if (!creds.client_email || !creds.private_key) {
      throw new Error("Service account JSON missing client_email or private_key");
    }

    // Render specifika - pataisome newlines
    const fixedKey = String(creds.private_key).replace(/\\n/g, "\n");

    return new google.auth.JWT({
      email: creds.client_email,
      key: fixedKey,
      scopes: ["https://www.googleapis.com/auth/calendar"]
    });
  } catch (error) {
    throw new Error(`Invalid service account JSON: ${error.message}`);
  }
};

const getCalendarClient = () => {
  try {
    const auth = getAuth();
    return google.calendar({ version: "v3", auth });
  } catch (error) {
    throw new Error(`Failed to initialize calendar client: ${error.message}`);
  }
};

const getBusySlots = async (calendar, timeMin, timeMax) => {
  try {
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: TIME_ZONE,
        items: [{ id: CALENDAR_ID }]
      }
    });

    return (response.data.calendars?.[CALENDAR_ID]?.busy || []).map(b => ({
      start: new Date(b.start),
      end: new Date(b.end)
    }));
  } catch (error) {
    console.error("FreeBusy API error:", error);
    throw new Error("Failed to fetch busy slots");
  }
};

const checkTimeSlotAvailable = async (calendar, startDT, endDT) => {
  const busy = await getBusySlots(calendar, startDT.toISO(), endDT.toISO());
  
  const start = new Date(startDT.toUTC().toISO());
  const end = new Date(endDT.toUTC().toISO());
  
  return !busy.some(b => overlaps(start, end, b.start, b.end));
};

// ===== ROUTES =====
app.get("/", (req, res) => res.send("Sanadenta API is running"));
app.get("/health", (req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

app.get("/free-slots", requireApiKey, async (req, res) => {
  try {
    const { date, service, durationMinutes } = req.query;

    // Validacija
    if (!isValidDate(date)) {
      return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
    }

    // Nustatome trukmę
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

    // Ar diena leistina?
    if (!isWeekdayAllowed(dayStart) || isSurgeonDay(dayStart)) {
      return res.json({ 
        ok: true, 
        allowed: false, 
        slots: [],
        message: "No appointments available on this date"
      });
    }

    // Generuojame laiko tarpus
    const allSlots = generateSlots(
      WORK_HOURS.start, 
      WORK_HOURS.end, 
      WORK_HOURS.stepMinutes, 
      duration
    );

    // Tikriname užimtumą
    const calendar = getCalendarClient();
    const timeMin = dayStart.toISO();
    const timeMax = dayStart.plus({ days: 1 }).toISO();
    
    const busySlots = await getBusySlots(calendar, timeMin, timeMax);

    const freeSlots = allSlots.filter(timeSlot => {
      const start = dtLocal(date, timeSlot);
      const end = start.plus({ minutes: duration });

      const startDate = new Date(start.toUTC().toISO());
      const endDate = new Date(end.toUTC().toISO());

      return !busySlots.some(busy => overlaps(startDate, endDate, busy.start, busy.end));
    });

    return res.json({
      ok: true,
      allowed: true,
      date,
      durationMinutes: duration,
      stepMinutes: WORK_HOURS.stepMinutes,
      slots: freeSlots,
      totalSlots: freeSlots.length
    });

  } catch (error) {
    console.error("FREE-SLOTS ERROR:", error);
    return res.status(500).json({ 
      error: "Server error", 
      message: error.message,
      ...(process.env.NODE_ENV === "development" && { stack: error.stack })
    });
  }
});

app.post("/create-booking", requireApiKey, async (req, res) => {
  try {
    const { name, phone, date, time, durationMinutes, service = "Vizitas" } = req.body;

    // Validacija
    if (!name?.trim() || !phone?.trim() || !date || !time) {
      return res.status(400).json({ 
        error: "Missing required fields",
        required: ["name", "phone", "date", "time"]
      });
    }

    if (!isValidDate(date)) {
      return res.status(400).json({ error: "Invalid date format" });
    }

    const duration = Number(durationMinutes || SERVICE_DURATIONS[service] || 60);
    const startDT = dtLocal(date, time);
    const endDT = startDT.plus({ minutes: duration });

    // Patikriname ar data ateityje
    if (startDT < DateTime.now().setZone(TIME_ZONE)) {
      return res.status(400).json({ error: "Cannot book appointments in the past" });
    }

    // Tikriname ar laisvas laikas
    const calendar = getCalendarClient();
    const isAvailable = await checkTimeSlotAvailable(calendar, startDT, endDT);
    
    if (!isAvailable) {
      return res.status(409).json({ 
        error: "Time slot already booked",
        message: "Selected time is no longer available"
      });
    }

    // Kuriame įvykį
    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `Sanadenta — ${service} — ${name}`,
        description: `Pacientas: ${name}\nTelefonas: ${phone}\nService: ${service}`,
        start: { 
          dateTime: startDT.toISO(), 
          timeZone: TIME_ZONE 
        },
        end: { 
          dateTime: endDT.toISO(), 
          timeZone: TIME_ZONE 
        },
        attendees: [{ email: phone, displayName: name }], // Optional
        reminders: {
          useDefault: true
        }
      }
    });

    return res.json({
      success: true,
      eventId: event.data.id,
      eventLink: event.data.htmlLink,
      reservedUntil: endDT.toFormat("HH:mm"),
      date: startDT.toFormat("yyyy-MM-dd"),
      time: startDT.toFormat("HH:mm"),
      service,
      duration
    });

  } catch (error) {
    console.error("CREATE-BOOKING ERROR:", error);
    
    // Google API specifinės klaidos
    if (error.response?.data?.error) {
      return res.status(error.response.status || 500).json({
        error: "Google Calendar API error",
        details: error.response.data.error.message
      });
    }

    return res.status(500).json({ 
      error: "Server error", 
      message: error.message,
      ...(process.env.NODE_ENV === "development" && { stack: error.stack })
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ 
    error: "Internal server error",
    message: process.env.NODE_ENV === "development" ? err.message : undefined
  });
});

app.listen(PORT, () => {
  console.log(`Sanadenta API running on port ${PORT}`);
  console.log(`Timezone: ${TIME_ZONE}`);
  console.log(`Calendar ID: ${CALENDAR_ID.substring(0, 20)}...`);
});