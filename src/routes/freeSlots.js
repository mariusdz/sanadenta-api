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

router.get('/', async (req, res) => {
  console.log('📥 FREE-SLOTS REQUEST', {
    query: req.query,
    origin: req.headers.origin || null,
    method: req.method,
  });

  // toliau tavo kodas


router.get('/', requireApiKey, async (req, res) => {
  try {
    const { date, service, durationMinutes } = req.query;

    if (!isValidDate(date)) {
      return res.status(400).json({
        error: 'Invalid date format. Use YYYY-MM-DD',
      });
    }

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

    const dayStart = DateTime.fromISO(date, { zone: TIME_ZONE }).startOf('day');

    if (!dayStart.isValid) {
      return res.status(400).json({
        error: 'Invalid date',
      });
    }

    if (!isWeekdayAllowed(dayStart) || isSurgeonDay(dayStart)) {
      const responseData = {
        ok: true,
        allowed: false,
        date,
        dateDisplay: formatHumanDate(dayStart),
        service: service || null,
        durationMinutes: duration,
        slots: [],
        totalSlots: 0,
        cached: false,
        message: 'No appointments available on this date',
      };

      return res.json(responseData);
    }

    const now = DateTime.now().setZone(TIME_ZONE);
    const isToday = dayStart.hasSame(now, 'day');

    const cacheKey = getFreeSlotsCacheKey(date, service || '', duration);
    const cached = getCachedFreeSlots(cacheKey, FREE_SLOTS_CACHE_MS);

    if (cached && !isToday) {
      console.log(`⚡ Returning cached free slots for ${cacheKey}`);
      return res.json({
        ...cached,
        cached: true,
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

      if (!start.isValid || !end.isValid) {
        return false;
      }

      // Jei data yra šiandien, neberodom praėjusių laikų
      if (isToday && start.toMillis() <= now.toMillis()) {
        return false;
      }

      const startDate = new Date(start.toUTC().toISO());
      const endDate = new Date(end.toUTC().toISO());

      const hasConflict = busySlots.some((busy) =>
        overlaps(startDate, endDate, busy.start, busy.end)
      );

      return !hasConflict;
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
      isToday,
      nowDisplay: now.toFormat('yyyy-MM-dd HH:mm'),
      timeZone: TIME_ZONE,
    };

    if (!isToday) {
      setCachedFreeSlots(cacheKey, responseData);
      console.log(`✅ Free slots calculated and cached for ${cacheKey}`);
    } else {
      console.log(`✅ Free slots calculated for today (not cached): ${cacheKey}`);
    }

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
});

module.exports = router;