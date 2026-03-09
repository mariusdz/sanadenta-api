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

const INFOBIP_API_KEY = process.env.INFOBIP_API_KEY || "";
const INFOBIP_BASE_URL = process.env.INFOBIP_BASE_URL || "";
const INFOBIP_SMS_FROM = process.env.INFOBIP_SMS_FROM || ""; // reply-capable number
const INFOBIP_CONFIRMATION_FROM =
  process.env.INFOBIP_CONFIRMATION_FROM || INFOBIP_SMS_FROM || "SANADENTA";
const ADMIN_PHONE = process.env.ADMIN_PHONE || "";
const REMINDER_CHECK_INTERVAL_MS = Number(process.env.REMINDER_CHECK_INTERVAL_MS || 300000);

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
let reminderJobStarted = false;

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

const normalizePhone = (phone) => {
  if (!phone) return "";
  const cleaned = String(phone).replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+")) return cleaned;

  if (cleaned.startsWith("370")) return `+${cleaned}`;

  if (cleaned.startsWith("8") && cleaned.length >= 9) {
    return `+370${cleaned.slice(1)}`;
  }

  return cleaned;
};

const normalizeSmsText = (text) => {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
};

const isYesReply = (text) => {
  const t = normalizeSmsText(text);
  return ["taip", "jo", "ok", "gerai", "tinka", "patvirtinu", "yes"].includes(t);
};

const isNoReply = (text) => {
  const t = normalizeSmsText(text);
  return ["ne", "negaliu", "neatvyksiu", "nebusiu", "netinka", "no"].includes(t);
};

const safeJsonParse = (value, fallback = {}) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const toPrivateMeta = (event) => {
  return event?.extendedProperties?.private || {};
};

const getReplyStatus = (event) => toPrivateMeta(event).replyStatus || "pending";
const getReminderSentAt = (event) => toPrivateMeta(event).reminderSentAt || "";
const getAdminNotifiedAt = (event) => toPrivateMeta(event).adminNotifiedAt || "";
const getPatientPhone = (event) => normalizePhone(toPrivateMeta(event).patientPhone || "");
const getReminderAt = (event) => toPrivateMeta(event).reminderAt || "";
const getServiceName = (event) => toPrivateMeta(event).service || "";

const buildReminderSendTime = (appointmentDT) => {
  const hour = appointmentDT.hour;

  // 08:00 / 09:00 / 10:00 -> iš vakaro 18:00
  if ([8, 9, 10].includes(hour)) {
    return appointmentDT.minus({ days: 1 }).set({
      hour: 18,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
  }

  // kitu atveju -> 3 valandos iki vizito
  return appointmentDT.minus({ hours: 3 });
};

const isMorningAppointment = (appointmentDT) => [8, 9, 10].includes(appointmentDT.hour);

const getEventDateTime = (event) => {
  const start = event?.start?.dateTime;
  if (!start) return null;
  return DateTime.fromISO(start, { zone: TIME_ZONE }).setZone(TIME_ZONE);
};

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
        if (!event.start.dateTime || !event.end.dateTime) return false;
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

// ===== INFOBIP SMS =====
const canSendSms = () => Boolean(INFOBIP_API_KEY && INFOBIP_BASE_URL);

const sendInfobipSms = async ({ from, to, text }) => {
  if (!canSendSms()) {
    console.warn("⚠️ SMS skipped: INFOBIP env vars missing");
    return { skipped: true, reason: "Missing Infobip config" };
  }

  const payload = {
    messages: [
      {
        from,
        destinations: [{ to: normalizePhone(to) }],
        text,
      },
    ],
  };

  const response = await fetch(`${INFOBIP_BASE_URL}/sms/2/text/advanced`, {
    method: "POST",
    headers: {
      Authorization: `App ${INFOBIP_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("❌ Infobip SMS error:", data);
    throw new Error(`Infobip SMS failed with status ${response.status}`);
  }

  console.log("✅ SMS sent:", JSON.stringify(data));
  return data;
};

const sendBookingConfirmationSms = async ({ phone, dateTime, service }) => {
  const text =
    `Sanadenta: Jusu vizitas patvirtintas ${formatHumanDateTime(dateTime)}.` +
    ` Paslauga: ${service}. Jei negalite atvykti, skambinkite klinikai.`;

  return sendInfobipSms({
    from: INFOBIP_CONFIRMATION_FROM,
    to: phone,
    text,
  });
};

const sendReminderQuestionSms = async ({ phone, dateTime }) => {
  const text =
    `Sanadenta: primename apie vizita ${formatHumanDateTime(dateTime)}.` +
    ` Ar atvyksite? Atsakykite: TAIP arba NE.`;

  return sendInfobipSms({
    from: INFOBIP_SMS_FROM,
    to: phone,
    text,
  });
};

const sendAdminCancellationSms = async ({ patientPhone, dateTime, service }) => {
  if (!ADMIN_PHONE) {
    console.warn("⚠️ ADMIN_PHONE not set, admin SMS skipped");
    return { skipped: true, reason: "Missing ADMIN_PHONE" };
  }

  const text =
    `Sanadenta: pacientas ${patientPhone} atsauke vizita ` +
    `${formatHumanDateTime(dateTime)} (${service}). Laikas atsilaisvino.`;

  return sendInfobipSms({
    from: INFOBIP_CONFIRMATION_FROM || INFOBIP_SMS_FROM,
    to: ADMIN_PHONE,
    text,
  });
};

// ===== CALENDAR EVENT METADATA =====
const patchEventPrivateMeta = async (calendar, eventId, patch) => {
  const existing = await calendar.events.get({
    calendarId: CALENDAR_ID,
    eventId,
  });

  const currentPrivate = existing.data.extendedProperties?.private || {};

  const updatedPrivate = {
    ...currentPrivate,
    ...patch,
  };

  const response = await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    requestBody: {
      extendedProperties: {
        private: updatedPrivate,
      },
    },
  });

  return response.data;
};

const buildEventPrivateMeta = ({
  name,
  phone,
  service,
  duration,
  reminderAt,
}) => ({
  patientName: name,
  patientPhone: normalizePhone(phone),
  service,
  durationMinutes: String(duration),
  reminderAt: reminderAt.toISO(),
  reminderSentAt: "",
  replyStatus: "pending",
  replyReceivedAt: "",
  adminNotifiedAt: "",
  createdBy: "sanadenta-api",
});

// ===== REMINDER ENGINE =====
const getUpcomingManagedEvents = async (calendar, daysAhead = 3) => {
  const now = DateTime.now().setZone(TIME_ZONE);
  const until = now.plus({ days: daysAhead });

  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.minus({ days: 1 }).toISO(),
    timeMax: until.toISO(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 2500,
  });

  const items = response.data.items || [];

  return items.filter((event) => {
    if (event.status === "cancelled") return false;
    if (!event.start?.dateTime) return false;

    const meta = toPrivateMeta(event);
    return meta.createdBy === "sanadenta-api" && meta.patientPhone;
  });
};

const processDueReminders = async () => {
  try {
    const calendar = getCalendarClient();
    const now = DateTime.now().setZone(TIME_ZONE);

    const events = await getUpcomingManagedEvents(calendar, 3);

    for (const event of events) {
      const eventDT = getEventDateTime(event);
      if (!eventDT) continue;
      if (eventDT <= now) continue;

      const meta = toPrivateMeta(event);
      const patientPhone = normalizePhone(meta.patientPhone || "");
      const reminderAtIso = meta.reminderAt || "";
      const reminderSentAt = meta.reminderSentAt || "";
      const replyStatus = meta.replyStatus || "pending";

      if (!patientPhone) continue;
      if (!reminderAtIso) continue;
      if (reminderSentAt) continue;
      if (replyStatus !== "pending") continue;

      const reminderAt = DateTime.fromISO(reminderAtIso, { zone: TIME_ZONE });
      if (!reminderAt.isValid) continue;

      if (reminderAt <= now) {
        console.log(`📨 Sending reminder for event ${event.id} at ${eventDT.toISO()}`);

        await sendReminderQuestionSms({
          phone: patientPhone,
          dateTime: eventDT,
        });

        await patchEventPrivateMeta(calendar, event.id, {
          reminderSentAt: now.toISO(),
        });
      }
    }
  } catch (error) {
    console.error("❌ Reminder processor error:", error.message);
  }
};

const startReminderJob = () => {
  if (reminderJobStarted) return;
  reminderJobStarted = true;

  console.log(`⏰ Reminder job started. Interval: ${REMINDER_CHECK_INTERVAL_MS} ms`);

  setInterval(async () => {
    await processDueReminders();
  }, REMINDER_CHECK_INTERVAL_MS);
};

// ===== ROOT =====
app.get("/", (req, res) =>
  res.json({
    service: "Sanadenta API",
    status: "running",
    version: "4.0",
    endpoints: [
      "/health",
      "/free-slots",
      "/create-booking",
      "/infobip/call-received",
      "/infobip/inbound-sms",
      "/run-reminders-now",
    ],
  })
);

// ===== HEALTH =====
app.get("/health", async (req, res) => {
  try {
    const calendar = getCalendarClient();

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
      sms: {
        configured: canSendSms(),
        from: INFOBIP_SMS_FROM || null,
        confirmationFrom: INFOBIP_CONFIRMATION_FROM || null,
        adminPhoneConfigured: Boolean(ADMIN_PHONE),
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

    const normalizedPhone = normalizePhone(phone);
    const reminderAt = buildReminderSendTime(startDT);

    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `Sanadenta — ${service} — ${name}`,
        description:
          `Pacientas: ${name}\n` +
          `Telefonas: ${normalizedPhone}\n` +
          `Paslauga: ${service}\n` +
          `Trukmė: ${duration} min\n` +
          `Rezervuota: ${new Date().toISOString()}\n` +
          `Reminder siuntimas: ${reminderAt.toISO()}`,
        start: {
          dateTime: startDT.toISO(),
          timeZone: TIME_ZONE,
        },
        end: {
          dateTime: endDT.toISO(),
          timeZone: TIME_ZONE,
        },
        extendedProperties: {
          private: buildEventPrivateMeta({
            name,
            phone: normalizedPhone,
            service,
            duration,
            reminderAt,
          }),
        },
      },
    });

    console.log(`✅ Booking created successfully: ${event.data.id}`);

    // 1 SMS iškart po registracijos
    try {
      await sendBookingConfirmationSms({
        phone: normalizedPhone,
        dateTime: startDT,
        service,
      });
    } catch (smsError) {
      console.error("⚠️ Confirmation SMS failed:", smsError.message);
    }

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
      reminderAt: reminderAt.toISO(),
      reminderAtDisplay: formatHumanDateTime(reminderAt),
      reminderRule: isMorningAppointment(startDT)
        ? "Iš vakaro 18:00"
        : "3 valandos iki vizito",
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

// ===== INFOBIP WEBHOOK - VOICE =====
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

// ===== INFOBIP WEBHOOK - INBOUND SMS =====
app.post("/infobip/inbound-sms", async (req, res) => {
  try {
    console.log("📩 Inbound SMS webhook:", JSON.stringify(req.body, null, 2));

    const messages = req.body?.results || req.body?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.json({ ok: true, message: "No SMS payload" });
    }

    const calendar = getCalendarClient();

    for (const sms of messages) {
      const from = normalizePhone(sms.from || sms.sender || "");
      const text = sms.text || sms.message || "";

      if (!from || !text) continue;

      const now = DateTime.now().setZone(TIME_ZONE);

      // Ieškom artimiausio būsimo arba ką tik atšaukto/laukiančio vizito pagal telefoną
      const response = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: now.minus({ days: 2 }).toISO(),
        timeMax: now.plus({ days: 30 }).toISO(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 2500,
      });

      const events = (response.data.items || []).filter((event) => {
        if (event.status === "cancelled") return false;
        if (!event.start?.dateTime) return false;
        return getPatientPhone(event) === from;
      });

      if (events.length === 0) {
        console.log(`⚠️ No matching event found for phone ${from}`);
        continue;
      }

      // Imame artimiausią būsimą vizitą
      const sorted = events.sort((a, b) => {
        const aDt = getEventDateTime(a)?.toMillis() || 0;
        const bDt = getEventDateTime(b)?.toMillis() || 0;
        return aDt - bDt;
      });

      const targetEvent = sorted.find((event) => {
        const eventDT = getEventDateTime(event);
        if (!eventDT) return false;
        return eventDT >= now.minus({ hours: 12 });
      }) || sorted[0];

      const eventDT = getEventDateTime(targetEvent);
      if (!eventDT) continue;

      const currentReplyStatus = getReplyStatus(targetEvent);
      if (currentReplyStatus === "no") {
        console.log(`ℹ️ Event ${targetEvent.id} already cancelled`);
        continue;
      }

      if (isYesReply(text)) {
        await patchEventPrivateMeta(calendar, targetEvent.id, {
          replyStatus: "yes",
          replyReceivedAt: now.toISO(),
        });

        console.log(`✅ Patient confirmed event ${targetEvent.id}`);
        continue;
      }

      if (isNoReply(text)) {
        await patchEventPrivateMeta(calendar, targetEvent.id, {
          replyStatus: "no",
          replyReceivedAt: now.toISO(),
        });

        await calendar.events.delete({
          calendarId: CALENDAR_ID,
          eventId: targetEvent.id,
        });

        console.log(`🗑️ Event deleted after patient cancellation: ${targetEvent.id}`);

        try {
          await sendAdminCancellationSms({
            patientPhone: from,
            dateTime: eventDT,
            service: getServiceName(targetEvent) || targetEvent.summary || "Vizitas",
          });
        } catch (adminSmsError) {
          console.error("⚠️ Admin SMS failed:", adminSmsError.message);
        }

        continue;
      }

      console.log(`ℹ️ Unknown SMS reply ignored from ${from}: "${text}"`);
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("❌ Inbound SMS processing error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

// ===== MANUAL REMINDER RUN =====
app.post("/run-reminders-now", requireApiKey, async (req, res) => {
  try {
    await processDueReminders();
    return res.json({ ok: true, message: "Reminder check completed" });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
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
        maxResults: 10,
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
          privateMeta: e.extendedProperties?.private || {},
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
  console.log(`📩 SMS configured: ${canSendSms() ? "YES" : "NO"}`);
  console.log(`📞 Reply-capable SMS from: ${INFOBIP_SMS_FROM || "NOT SET"}`);
  console.log(`👩‍💼 Admin phone configured: ${ADMIN_PHONE ? "YES" : "NO"}`);

  console.log(`\n📋 Endpoints:`);
  console.log(`   GET  /`);
  console.log(`   GET  /health`);
  console.log(`   GET  /free-slots?date=YYYY-MM-DD&service=...`);
  console.log(`   POST /create-booking`);
  console.log(`   POST /infobip/call-received (IVR webhook)`);
  console.log(`   POST /infobip/inbound-sms`);
  console.log(`   POST /run-reminders-now`);

  if (process.env.NODE_ENV !== "production") {
    console.log(`   GET  /debug/auth (development only)`);
  }

  console.log(`\n✅ Server ready\n`);

  startReminderJob();
});