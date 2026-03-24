const express = require('express');
const cors = require('cors');
const path = require('path');

const healthRoutes = require('./routes/health');
const freeSlotsRoutes = require('./routes/freeSlots');
const bookingRoutes = require('./routes/booking');
const availableDatesRoutes = require('./routes/availableDates');
const infobipRoutes = require('./routes/infobip');
const infobipVoiceRoutes = require('./routes/infobipVoice');

const { testCalendarAccess } = require('./services/googleCalendar');

const app = express();

const allowedOrigins = [
  'https://sanadenta.lt',
  'https://www.sanadenta.lt',
  'https://sanadenta-api.onrender.com',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const corsOptions = {
  origin(origin, callback) {
    console.log('🌍 CORS CHECK', {
      origin: origin || null,
    });

    // Leisti server-to-server, curl, cron, webhooks ir pan.
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn('❌ CORS BLOCKED', {
      origin,
      allowedOrigins,
    });

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use((req, res, next) => {
  console.log('➡️ REQUEST', {
    method: req.method,
    path: req.path,
    origin: req.headers.origin || null,
    acrMethod: req.headers['access-control-request-method'] || null,
    acrHeaders: req.headers['access-control-request-headers'] || null,
  });
  next();
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

app.use('/health', healthRoutes);
app.use('/free-slots', freeSlotsRoutes);
app.use('/create-booking', bookingRoutes);
app.use('/available-dates', availableDatesRoutes);
app.use('/infobip', infobipRoutes);
app.use('/infobip', infobipVoiceRoutes);

app.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'sanadenta-api',
  });
});

app.use((req, res) => {
  console.warn('⚠️ ROUTE NOT FOUND', {
    method: req.method,
    path: req.path,
    origin: req.headers.origin || null,
  });

  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', {
    message: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    origin: req.headers.origin || null,
  });

  if (err.message?.startsWith('CORS blocked')) {
    return res.status(403).json({
      error: 'CORS blocked',
      message: err.message,
    });
  }

  res.status(500).json({
    error: 'Internal server error',
    message:
      process.env.NODE_ENV === 'development'
        ? err.message
        : 'Something went wrong',
  });
});

testCalendarAccess().catch((err) => {
  console.error('❌ Calendar access test failed:', err?.message || err);
});

module.exports = app;