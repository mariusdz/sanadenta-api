// src/app.js
const express = require('express');
const cors = require('cors');

const healthRoutes = require('./routes/health');
const freeSlotsRoutes = require('./routes/freeSlots');
const bookingRoutes = require('./routes/booking');
const infobipRoutes = require('./routes/infobip');
const remindersRoutes = require('./routes/reminders');

const { testCalendarAccess } = require('./services/googleCalendar');

const app = express();

app.use(cors({
  origin: [
    'https://sanadenta.lt',
    'https://www.sanadenta.lt',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
}));
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
  res.json({
    service: 'Sanadenta API',
    status: 'running',
    version: '4.1',
    endpoints: [
      '/health',
      '/free-slots',
      '/create-booking',
      '/infobip/call-received',
      '/infobip/inbound-sms',
      '/run-reminders-now',
      '/test-calendar',
      ...(process.env.NODE_ENV !== 'production' ? ['/debug/auth'] : []),
    ],
  });
});

// Pagrindiniai route'ai
app.use('/health', healthRoutes);
app.use('/free-slots', freeSlotsRoutes);
app.use('/create-booking', bookingRoutes);
app.use('/infobip', infobipRoutes);
app.use('/', remindersRoutes);

// Debug route'ai tik development aplinkoje
if (process.env.NODE_ENV !== 'production') {
  const debugRoutes = require('./routes/debug');
  app.use('/debug', debugRoutes);
}

// Test route Google Calendar prieigai
app.get('/test-calendar', async (req, res) => {
  try {
    const result = await testCalendarAccess();

    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null,
    });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);

  res.status(500).json({
    error: 'Internal server error',
    message:
      process.env.NODE_ENV === 'development'
        ? err.message
        : 'Something went wrong',
  });
});

module.exports = app;