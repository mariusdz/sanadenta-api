const express = require('express');
const router = express.Router();
const { DateTime } = require('luxon');

const {
  TIME_ZONE,
  WORK_HOURS,
  SERVICE_DURATIONS,
  CALENDAR_ID,
} = require('../config');

const {
  isValidDate,
  isValidTime,
  isWeekdayAllowed,
  isSurgeonDay,
  generateSlots,
  formatHumanDate,
  formatHumanDateTime,
  overlaps,
} = require('../utils/dateTime');

const { normalizePhone } = require('../utils/phone');
const { clearFreeSlotsCache } = require('../utils/cache');

const {
  getCalendarClient,
  getBusySlots,
} = require('../services/googleCalendar');

const { sendBookingConfirmationSms } = require('../services/sms');
const { buildReminderSendTime, isMorningAppointment } = require('../services/reminder');
const requireApiKey = require('../middleware/apiKey');

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
  reminderSentAt: '',
  replyStatus: 'pending',
  replyReceivedAt: '',
  adminNotifiedAt: '',
  createdBy: 'sanadenta-api',
});

router.post('/', requireApiKey, async (req, res) => {
  const requestStartedAt = Date.now();

  try {
    const {
      name,
      phone,
      date,
      time,
      durationMinutes,
      service = 'Vizitas',
    } = req.body;

    console.log('📥 CREATE-BOOKING REQUEST', {
      body: req.body,
      receivedAt: DateTime.now().setZone(TIME_ZONE).toISO(),
      timeZone: TIME_ZONE,
    });

    if (!name?.trim() || !phone?.trim() || !date || !time) {
      console.warn('⚠️ CREATE-BOOKING VALIDATION FAILED: missing required fields', {
        body: req.body,
      });

      return res.status(400).json({
        error: 'Missing required fields',
        required: ['name', 'phone', 'date', 'time'],
      });
    }

    if (!isValidDate(date)) {
      console.warn('⚠️ CREATE-BOOKING VALIDATION FAILED: invalid date format', {
        date,
        expected: 'YYYY-MM-DD',
      });

      return res.status(400).json({
        error: 'Invalid date format',
        expected: 'YYYY-MM-DD',
      });
    }

    if (!isValidTime(time)) {
      console.warn('⚠️ CREATE-BOOKING VALIDATION FAILED: invalid time format', {
        time,
        expected: 'HH:mm',
      });

      return res.status(400).json({
        error: 'Invalid time format',
        expected: 'HH:mm',
      });
    }

    const duration = Number(durationMinutes || SERVICE_DURATIONS[service] || 60);

    console.log('🧮 BOOKING DURATION RESOLVED', {
      requestedDurationMinutes: durationMinutes ?? null,
      service,
      mappedServiceDuration: SERVICE_DURATIONS[service] || null,
      finalDuration: duration,
    });

    if (Number.isNaN(duration) || duration <= 0) {
      console.warn('⚠️ CREATE-BOOKING VALIDATION FAILED: invalid duration', {
        durationMinutes,
        service,
        duration,
      });

      return res.status(400).json({
        error: 'Invalid duration',
      });
    }

    const dayStart = DateTime.fromISO(date, { zone: TIME_ZONE }).startOf('day');

    if (!dayStart.isValid) {
      console.warn('⚠️ CREATE-BOOKING VALIDATION FAILED: invalid booking date', {
        date,
        parsed: dayStart,
      });

      return res.status(400).json({
        error: 'Invalid booking date',
      });
    }

    const weekdayAllowed = isWeekdayAllowed(dayStart);
    const surgeonDay = isSurgeonDay(dayStart);

    console.log('📅 BOOKING DAY CHECK', {
      date,
      dayStartISO: dayStart.toISO(),
      weekdayAllowed,
      surgeonDay,
    });

    if (!weekdayAllowed || surgeonDay) {
      console.warn('⚠️ CREATE-BOOKING VALIDATION FAILED: selected date unavailable', {
        date,
        weekdayAllowed,
        surgeonDay,
      });

      return res.status(400).json({
        error: 'Selected date is not available for appointments',
      });
    }

    const validSlots = generateSlots(
      WORK_HOURS.start,
      WORK_HOURS.end,
      WORK_HOURS.stepMinutes,
      duration
    );

    console.log('🕒 VALID SLOTS GENERATED', {
      date,
      workHours: WORK_HOURS,
      duration,
      slotCount: validSlots.length,
      requestedTime: time,
      firstSlots: validSlots.slice(0, 8),
      lastSlots: validSlots.slice(-8),
    });

    if (!validSlots.includes(time)) {
      console.warn('⚠️ CREATE-BOOKING VALIDATION FAILED: invalid appointment start time', {
        requestedTime: time,
        allowedSlots: validSlots,
      });

      return res.status(400).json({
        error: 'Invalid appointment start time',
        allowedSlots: validSlots,
      });
    }

    const startDT = DateTime.fromISO(`${date}T${time}`, { zone: TIME_ZONE });
    const endDT = startDT.plus({ minutes: duration });

    if (!startDT.isValid || !endDT.isValid) {
      console.warn('⚠️ CREATE-BOOKING VALIDATION FAILED: invalid appointment date/time', {
        date,
        time,
        startValid: startDT.isValid,
        endValid: endDT.isValid,
        startInvalidReason: startDT.invalidReason || null,
        endInvalidReason: endDT.invalidReason || null,
      });

      return res.status(400).json({
        error: 'Invalid appointment date/time',
      });
    }

    const now = DateTime.now().setZone(TIME_ZONE);
    const isPast = startDT.toMillis() < now.toMillis();

    console.log('CREATE BOOKING CHECK', {
      requestBody: req.body,
      timeZone: TIME_ZONE,
      nowLocal: now.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ'),
      nowISO: now.toISO(),
      startLocal: startDT.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ'),
      startISO: startDT.toISO(),
      endLocal: endDT.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ'),
      endISO: endDT.toISO(),
      isPast,
    });

    if (isPast) {
      console.warn('⚠️ CREATE-BOOKING VALIDATION FAILED: appointment in the past', {
        nowISO: now.toISO(),
        startISO: startDT.toISO(),
        timeZone: TIME_ZONE,
      });

      return res.status(400).json({
        error: 'Cannot book appointments in the past',
        debug: process.env.NODE_ENV === 'development'
          ? {
              now: now.toISO(),
              start: startDT.toISO(),
              timeZone: TIME_ZONE,
            }
          : undefined,
      });
    }

    const normalizedPhone = normalizePhone(phone);

    console.log('📞 PHONE NORMALIZATION', {
      originalPhone: phone,
      normalizedPhone,
    });

    if (!normalizedPhone) {
      console.warn('⚠️ CREATE-BOOKING VALIDATION FAILED: invalid phone after normalization', {
        originalPhone: phone,
        normalizedPhone,
      });

      return res.status(400).json({
        error: 'Invalid phone number',
      });
    }

    console.log(`📝 Creating booking: ${name} - ${date} ${time} (${duration}min)`);

    const calendar = getCalendarClient();

    console.log('📡 FETCHING BUSY SLOTS', {
      startISO: startDT.toISO(),
      endISO: endDT.toISO(),
      calendarId: CALENDAR_ID,
    });

    const busySlots = await getBusySlots(
      calendar,
      startDT.toISO(),
      endDT.toISO()
    );

    console.log('📚 BUSY SLOTS RECEIVED', {
      count: busySlots.length,
      items: busySlots.map((busy) => ({
        start: busy.start,
        end: busy.end,
      })),
    });

    const startDate = new Date(startDT.toUTC().toISO());
    const endDate = new Date(endDT.toUTC().toISO());

    const hasConflict = busySlots.some((busy) =>
      overlaps(startDate, endDate, busy.start, busy.end)
    );

    console.log('🔍 CONFLICT CHECK', {
      requestedStartUtc: startDate.toISOString(),
      requestedEndUtc: endDate.toISOString(),
      hasConflict,
    });

    if (hasConflict) {
      console.warn('⚠️ CREATE-BOOKING CONFLICT: time slot already booked', {
        name,
        normalizedPhone,
        date,
        time,
        service,
        duration,
      });

      return res.status(409).json({
        error: 'Time slot already booked',
        message: 'Selected time is no longer available',
      });
    }

    const reminderAt = buildReminderSendTime(startDT);

    const privateMeta = buildEventPrivateMeta({
      name,
      phone: normalizedPhone,
      service,
      duration,
      reminderAt,
    });

    console.log('🧾 EVENT PRIVATE META', privateMeta);

    const eventRequestBody = {
      summary: `Sanadenta — ${service} — ${name}`,
      description: [
        `Pacientas: ${name}`,
        `Telefonas: ${normalizedPhone}`,
        `Paslauga: ${service}`,
        `Trukmė: ${duration} min`,
        `Rezervuota: ${DateTime.now().setZone(TIME_ZONE).toISO()}`,
        `Reminder siuntimas: ${reminderAt.toISO()}`,
      ].join('\n'),
      start: {
        dateTime: startDT.toISO(),
        timeZone: TIME_ZONE,
      },
      end: {
        dateTime: endDT.toISO(),
        timeZone: TIME_ZONE,
      },
      extendedProperties: {
        private: privateMeta,
      },
    };

    console.log('📤 GOOGLE CALENDAR INSERT REQUEST', {
      calendarId: CALENDAR_ID,
      summary: eventRequestBody.summary,
      start: eventRequestBody.start,
      end: eventRequestBody.end,
      privateMeta: eventRequestBody.extendedProperties.private,
    });

    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: eventRequestBody,
    });

    console.log('✅ Booking created successfully', {
      eventId: event.data.id,
      htmlLink: event.data.htmlLink,
      status: event.status,
      patientName: name,
      patientPhone: normalizedPhone,
      service,
      duration,
      startISO: startDT.toISO(),
      endISO: endDT.toISO(),
    });

    clearFreeSlotsCache();

    console.log('🧹 Free slots cache cleared');

    let smsStatus = {
      attempted: false,
      sent: false,
      error: null,
    };

    try {
      smsStatus.attempted = true;

      console.log('📤 SENDING BOOKING CONFIRMATION SMS', {
        eventId: event.data.id,
        to: normalizedPhone,
        service,
        appointmentDateTime: startDT.toISO(),
      });

      const smsResult = await sendBookingConfirmationSms({
  phone: normalizedPhone,
  dateTime: startDT,
  service,
  meta: {
    eventId: event.data.id,
    patientName: name,
    patientPhone: normalizedPhone,
  },
});

      smsStatus.sent = true;

      console.log('✅ BOOKING CONFIRMATION SMS SENT', {
        eventId: event.data.id,
        to: normalizedPhone,
        smsResult: smsResult || null,
      });
    } catch (smsError) {
      smsStatus.error = smsError.message;

      console.error('⚠️ Confirmation SMS failed', {
        eventId: event?.data?.id || null,
        to: normalizedPhone,
        message: smsError.message,
        stack: smsError.stack,
      });
    }

    const responseBody = {
      success: true,
      eventId: event.data.id,
      eventLink: event.data.htmlLink,
      service,
      duration,
      date: startDT.toFormat('yyyy-MM-dd'),
      time: startDT.toFormat('HH:mm'),
      reservedUntil: endDT.toFormat('HH:mm'),
      dateDisplay: formatHumanDate(startDT),
      dateTimeDisplay: formatHumanDateTime(startDT),
      reminderAt: reminderAt.toISO(),
      reminderAtDisplay: formatHumanDateTime(reminderAt),
      reminderRule: isMorningAppointment(startDT)
        ? 'Iš vakaro 18:00'
        : '3 valandos iki vizito',
      sms: smsStatus,
    };

    console.log('📤 CREATE-BOOKING RESPONSE', {
      eventId: responseBody.eventId,
      service: responseBody.service,
      duration: responseBody.duration,
      date: responseBody.date,
      time: responseBody.time,
      reservedUntil: responseBody.reservedUntil,
      sms: responseBody.sms,
      tookMs: Date.now() - requestStartedAt,
    });

    return res.status(201).json(responseBody);
  } catch (error) {
    console.error('❌ CREATE-BOOKING ERROR', {
      message: error.message,
      stack: error.stack,
      body: req.body,
      tookMs: Date.now() - requestStartedAt,
    });

    if (error.response?.data?.error) {
      const googleError = error.response.data.error;

      console.error('❌ Google Calendar API Error', {
        status: error.response.status || 500,
        code: googleError.code,
        message: googleError.message,
        details: googleError,
      });

      return res.status(error.response.status || 500).json({
        error: 'Google Calendar API error',
        message: googleError.message,
        code: googleError.code,
        details: process.env.NODE_ENV === 'development' ? googleError : undefined,
      });
    }

    return res.status(500).json({
      error: 'Server error',
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

module.exports = router;