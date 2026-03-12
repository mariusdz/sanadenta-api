// src/routes/debug.js
const express = require('express');
const router = express.Router();

const {
  getAuth,
  getAuthInfo,
  getCalendarClient,
  CALENDAR_ID,
} = require('../services/googleCalendar');

const { TIME_ZONE } = require('../config');

if (process.env.NODE_ENV !== 'production') {
  router.get('/auth', async (req, res) => {
    try {
      const auth = getAuth();
      const authInfo = getAuthInfo();
      const calendar = getCalendarClient();

      const calendarInfo = await calendar.calendars.get({
        calendarId: CALENDAR_ID,
      });

      const now = new Date().toISOString();

      const events = await calendar.events.list({
        calendarId: CALENDAR_ID,
        maxResults: 10,
        timeMin: now,
        singleEvents: true,
        orderBy: 'startTime',
      });

      res.json({
        success: true,
        environment: process.env.NODE_ENV || 'development',
        auth: {
          email: authInfo.client_email || null,
          hasPrivateKey: Boolean(authInfo.private_key),
          scopes: auth.scopes || [],
        },
        calendar: {
          id: calendarInfo.data.id,
          summary: calendarInfo.data.summary,
          timeZone: calendarInfo.data.timeZone || TIME_ZONE,
        },
        upcomingEventsCount: events.data.items?.length || 0,
        sampleEvents: (events.data.items || []).map((event) => ({
          id: event.id,
          summary: event.summary,
          start: event.start,
          end: event.end,
          status: event.status,
          privateMeta: event.extendedProperties?.private || {},
        })),
      });
    } catch (error) {
      console.error('❌ DEBUG /auth ERROR:', error.message);

      res.status(500).json({
        success: false,
        error: error.message,
        response: error.response?.data || null,
      });
    }
  });
} else {
  router.all('*', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
}

module.exports = router;