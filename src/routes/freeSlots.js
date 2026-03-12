// src/routes/freeSlots.js
const express = require('express');
const router = express.Router();
const { DateTime } = require('luxon');

const {
  WORK_HOURS,
  SERVICE_DURATIONS,
  FREE_SLOTS_CACHE_MS,
  TIME_ZONE,
} = require('../config');

const {
  isValidDate,
  isWeekdayAllowed,
  isSurgeonDay,
  generateSlots,
  dtLocal,
  formatHumanDate,
  overlaps,
} = require('../utils/dateTime');

const {
  getFreeSlotsCacheKey,
  getCachedFreeSlots,
  setCachedFreeSlots,
} = require('../utils/cache');

const {
  getCalendarClient,
  getBusySlots,
} = require('../services/googleCalendar');

const requireApiKey = require('../middleware/apiKey');

router.get('/', requireApiKey, async (req, res) => {
  try {
    const { date, service, durationMinutes } = req.query;

    // 1. Datos validacija
    if (!isValidDate(date)) {
      return res.status(400).json({
        error: 'Invalid date format. Use YYYY-MM-DD',
      });
    }

    // 2. Trukmės nustatymas
    let duration = 60;

    if (service && SERVICE_DURATIONS[service]) {
      duration = SERVICE_DURATIONS[service];
    } else if (durationMinutes) {
      duration = Number(durationMinutes);

      if (Number.isNaN(duration) || duration <= 0) {
        return res.status(400).json({
          error: 'Invalid durationMinutes',
        });
      }
    }

    // 3. Cache raktas
    const cacheKey = getFreeSlotsCacheKey(date, service || '', duration);
    const cached = getCachedFreeSlots(cacheKey, FREE_SLOTS_CACHE_MS);

    if (cached) {
      console.log(`⚡ Returning cached free slots for ${cacheKey}`);
      return res.json({
        ...cached,
        cached: true,
      });
    }

    // 4. Dienos objektas
    const dayStart = DateTime.fromISO(date, { zone: TIME_ZONE }).startOf('day');

    if (!dayStart.isValid) {
      return res.status(400).json({
        error: 'Invalid date',
      });
    }

    // 5. Ar leidžiama registruoti tą dieną
    if (!isWeekdayAllowed(dayStart) || isSurgeonDay(dayStart)) {
      const responseData = {
        ok: true,
        allowed: false,
        date,
        dateDisplay: formatHumanDate(dayStart),
        durationMinutes: duration,
        slots: [],
        totalSlots: 0,
        cached: false,
        message: 'No appointments available on this date',
      };

      setCachedFreeSlots(cacheKey, responseData);
      return res.json(responseData);
    }

    // 6. Sugeneruojam teorinius slotus pagal darbo laiką
    const allSlots = generateSlots(
      WORK_HOURS.start,
      WORK_HOURS.end,
      WORK_HOURS.stepMinutes,
      duration
    );

    // 7. Pasiimam užimtus eventus iš Google Calendar
    const calendar = getCalendarClient();

    const timeMin = dayStart.toISO();
    const timeMax = dayStart.plus({ days: 1 }).toISO();

    const busySlots = await getBusySlots(calendar, timeMin, timeMax);

    // 8. Atfiltruojam tik realiai laisvus laikus
    const freeSlots = allSlots.filter((timeSlot) => {
      const start = dtLocal(date, timeSlot);
      const end = start.plus({ minutes: duration });

      const startDate = new Date(start.toUTC().toISO());
      const endDate = new Date(end.toUTC().toISO());

      return !busySlots.some((busy) =>
        overlaps(startDate, endDate, busy.start, busy.end)
      );
    });

    const responseData = {
      ok: true,
      allowed: true,
      date,
      dateDisplay: formatHumanDate(dayStart),
      service: service || null,
      durationMinutes: duration,
      workHours: {
        start: WORK_HOURS.start,
        end: WORK_HOURS.end,
        stepMinutes: WORK_HOURS.stepMinutes,
      },
      slots: freeSlots,
      totalSlots: freeSlots.length,
      cached: false,
    };

    setCachedFreeSlots(cacheKey, responseData);
    console.log(`✅ Free slots calculated and cached for ${cacheKey}`);

    return res.json(responseData);
  } catch (error) {
    console.error('❌ FREE-SLOTS ERROR:', error);

    let statusCode = 500;
    let errorMessage = error.message;

    if (String(error.message).includes('Authentication failed')) {
      statusCode = 503;
      errorMessage = 'Calendar service unavailable - authentication issue';
    } else if (String(error.message).toLowerCase().includes('permission')) {
      statusCode = 403;
      errorMessage = 'Calendar access denied - check service account permissions';
    }

    return res.status(statusCode).json({
      error: 'Server error',
      message: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

module.exports = router;