// src/routes/health.js
const express = require('express');
const router = express.Router();

const { getCalendarClient } = require('../services/googleCalendar');
const { canSendSms } = require('../services/sms');

const {
  FREE_SLOTS_CACHE_MS,
  CALENDAR_ID,
  TIME_ZONE,
  INFOBIP_SMS_FROM,
  INFOBIP_CONFIRMATION_FROM,
  ADMIN_PHONE,
} = require('../config');

const { freeSlotsCache } = require('../utils/cache');

router.get('/', async (req, res) => {
  try {
    const calendar = getCalendarClient();

    const calendarInfo = await calendar.calendars.get({
      calendarId: CALENDAR_ID,
    });

    return res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      calendar: {
        connected: true,
        calendarId: CALENDAR_ID.substring(0, 20) + '...',
        summary: calendarInfo.data.summary || 'Unknown',
        timezone: calendarInfo.data.timeZone || TIME_ZONE,
      },
      sms: {
        configured: canSendSms(),
        from: INFOBIP_SMS_FROM || null,
        confirmationFrom: INFOBIP_CONFIRMATION_FROM || null,
        adminPhoneConfigured: Boolean(ADMIN_PHONE),
      },
      cache: {
        freeSlotsCacheMs: FREE_SLOTS_CACHE_MS,
        freeSlotsEntries: freeSlotsCache.size,
      },
    });
  } catch (error) {
    console.error('❌ HEALTH ERROR:', error.message);

    return res.status(500).json({
      ok: false,
      timestamp: new Date().toISOString(),
      calendar: {
        connected: false,
        calendarId: CALENDAR_ID ? CALENDAR_ID.substring(0, 20) + '...' : null,
        timezone: TIME_ZONE,
      },
      sms: {
        configured: canSendSms(),
        from: INFOBIP_SMS_FROM || null,
        confirmationFrom: INFOBIP_CONFIRMATION_FROM || null,
        adminPhoneConfigured: Boolean(ADMIN_PHONE),
      },
      cache: {
        freeSlotsCacheMs: FREE_SLOTS_CACHE_MS,
        freeSlotsEntries: freeSlotsCache.size,
      },
      error: 'Calendar connection failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

module.exports = router;