const express = require('express');
const cors = require('cors');
const path = require('path');

const healthRoutes = require('./routes/health');
const freeSlotsRoutes = require('./routes/freeSlots');
const createBookingRoutes = require('./routes/createBooking');
const availableDatesRoutes = require('./routes/availableDates');
const infobipRoutes = require('./routes/infobip');
const infobipVoiceRoutes = require('./routes/infobipVoice');

const { testCalendarAccess } = require('./services/googleCalendar');

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

app.use(cors({
  origin: [
    'https://sanadenta.lt',
    'https://www.sanadenta.lt',
    'https://sanadenta-api.onrender.com',
    'http://localhost:3000',
    'http://localhost:3001',
  ],
  credentials: true,
}));

app.use('/health', healthRoutes);
app.use('/free-slots', freeSlotsRoutes);
app.use('/create-booking', createBookingRoutes);
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
  res.status(404).json({ error: 'Route not found' });
});

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

testCalendarAccess().catch((err) => {
  console.error('❌ Calendar access test failed:', err?.message || err);
});

module.exports = app;