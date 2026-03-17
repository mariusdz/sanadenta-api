const dotenv = require('dotenv');
dotenv.config();

module.exports = {
  PORT: Number(process.env.PORT || 3000),
  NODE_ENV: process.env.NODE_ENV || 'development',

  TIME_ZONE: process.env.TIME_ZONE || 'Europe/Vilnius',
  API_KEY: process.env.API_KEY || '',

  CALENDAR_ID:
    process.env.CALENDAR_ID ||
    '10749b71d8c90e5386ee005cfbb1e2f88ab28329d7dfab9b4fe6281528af92e6@group.calendar.google.com',

  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',

  INFOBIP_API_KEY: process.env.INFOBIP_API_KEY || '',
  INFOBIP_BASE_URL: process.env.INFOBIP_BASE_URL || '',

  INFOBIP_SMS_FROM: process.env.INFOBIP_SMS_FROM || '',
  INFOBIP_CONFIRMATION_FROM:
    process.env.INFOBIP_CONFIRMATION_FROM ||
    process.env.INFOBIP_SMS_FROM ||
    'SANADENTA',

  INFOBIP_2WAY_FROM:
    process.env.INFOBIP_2WAY_FROM ||
    '37068000134',

  INFOBIP_DELIVERY_REPORT_URL:
    process.env.INFOBIP_DELIVERY_REPORT_URL ||
    'https://sanadenta-api.onrender.com/infobip/delivery-report',

  INFOBIP_CALLS_APPLICATION_ID:
    process.env.INFOBIP_CALLS_APPLICATION_ID || '',
  INFOBIP_CALLS_CONFIGURATION_ID:
    process.env.INFOBIP_CALLS_CONFIGURATION_ID || '',
  INFOBIP_VOICE_FROM: process.env.INFOBIP_VOICE_FROM || '',

  GOOGLE_TTS_VOICE: process.env.GOOGLE_TTS_VOICE || 'lt-LT-Standard-A',
  GOOGLE_TTS_LANGUAGE_CODE: process.env.GOOGLE_TTS_LANGUAGE_CODE || 'lt-LT',

  ADMIN_PHONE: process.env.ADMIN_PHONE || '',
  PUBLIC_WEB_URL: process.env.PUBLIC_WEB_URL || 'https://sanadenta-api.onrender.com',

  REMINDER_CHECK_INTERVAL_MS: Number(
    process.env.REMINDER_CHECK_INTERVAL_MS || 300000
  ),
  FREE_SLOTS_CACHE_MS: Number(process.env.FREE_SLOTS_CACHE_MS || 30000),

  WORK_HOURS: {
    start: '08:00',
    end: '17:00',
    stepMinutes: 15,
  },

  SERVICE_DURATIONS: {
    Konsultacija: 15,
    'Trumpas vizitas': 30,
    Vizitas: 60,
  },
};