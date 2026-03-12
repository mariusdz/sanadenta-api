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
  try {
    const {
      name,
      phone,
      date,
      time,
      durationMinutes,
      service = 'Vizitas',
    } = req.body;

    if (!name?.trim() || !phone?.trim() || !date || !time) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['name', 'phone', 'date', 'time'],
      });
    }

    if (!isValidDate(date)) {
      return res.status(400).json({
        error: 'Invalid date format',
        expected: 'YYYY-MM-DD',
      });
    }

    if (!isValidTime(time)) {
      return res.status(400).json({
        error: 'Invalid time format',
        expected: 'HH:mm',
      });
    }

    const duration = Number(durationMinutes || SERVICE_DURATIONS[service] || 60);

    if (Number.isNaN(duration) || duration <= 0) {
      return res.status(400).json({
        error: 'Invalid duration',
      });
    }

    const dayStart = DateTime.fromISO(date, { zone: TIME_ZONE }).startOf('day');

    if (!dayStart.isValid) {
      return res.status(400).json({
        error: 'Invalid booking date',
      });
    }

    if (!isWeekdayAllowed(dayStart) || isSurgeonDay(dayStart)) {
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

    if (!validSlots.includes(time)) {
      return res.status(400).json({
        error: 'Invalid appointment start time',
        allowedSlots: validSlots,
      });
    }

    // Saugus laiko kūrimas su Luxon ir aiškia klinikos timezone
    const startDT = DateTime.fromISO(`${date}T${time}`, { zone: TIME_ZONE });
    const endDT = startDT.plus({ minutes: duration });

    if (!startDT.isValid || !endDT.isValid) {
      return res.status(400).json({
        error: 'Invalid appointment date/time',
      });
    }

    const now = DateTime.now().setZone(TIME_ZONE);

    console.log('CREATE BOOKING CHECK', {
      requestBody: req.body,
      timeZone: TIME_ZONE,
      nowLocal: now.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ'),
      nowISO: now.toISO(),
      startLocal: startDT.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ'),
      startISO: startDT.toISO(),
      endLocal: endDT.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ'),
      endISO: endDT.toISO(),
      isPast: startDT.toMillis() < now.toMillis(),
    });

    if (startDT.toMillis() < now.toMillis()) {
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

    console.log(`📝 Creating booking: ${name} - ${date} ${time} (${duration}min)`);

    const calendar = getCalendarClient();

    const busySlots = await getBusySlots(
      calendar,
      startDT.toISO(),
      endDT.toISO()
    );

    const startDate = new Date(startDT.toUTC().toISO());
    const endDate = new Date(endDT.toUTC().toISO());

    const hasConflict = busySlots.some((busy) =>
      overlaps(startDate, endDate, busy.start, busy.end)
    );

    if (hasConflict) {
      return res.status(409).json({
        error: 'Time slot already booked',
        message: 'Selected time is no longer available',
      });
    }

    const normalizedPhone = normalizePhone(phone);
    const reminderAt = buildReminderSendTime(startDT);

    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
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
    clearFreeSlotsCache();

    try {
      await sendBookingConfirmationSms({
        phone: normalizedPhone,
        dateTime: startDT,
        service,
      });
    } catch (smsError) {
      console.error('⚠️ Confirmation SMS failed:', smsError.message);
    }

    return res.status(201).json({
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
    });
  } catch (error) {
    console.error('❌ CREATE-BOOKING ERROR:', error);

    if (error.response?.data?.error) {
      const googleError = error.response.data.error;

      console.error('Google API Error:', googleError);

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
