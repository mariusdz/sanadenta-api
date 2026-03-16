// src/services/sms.js
const axios = require('axios');
const { DateTime } = require('luxon');
const { normalizePhone } = require('../utils/phone');
const { TIME_ZONE } = require('../config');

const INFOBIP_BASE_URL = process.env.INFOBIP_BASE_URL;
const INFOBIP_API_KEY = process.env.INFOBIP_API_KEY;

// šitą naudok priminimams, į kuriuos pacientas gali atrašyti
const INFOBIP_2WAY_FROM = process.env.INFOBIP_2WAY_FROM || '37068000134';

// jei turi atskirą senderį one-way žinutėms
const INFOBIP_1WAY_FROM = process.env.INFOBIP_1WAY_FROM || 'Sanadenta';

async function sendSms({ to, text, from }) {
  const normalizedTo = normalizePhone(to);

  if (!normalizedTo) {
    throw new Error(`Invalid destination phone: ${to}`);
  }

  const payload = {
    messages: [
      {
        from: from || INFOBIP_2WAY_FROM,
        destinations: [{ to: normalizedTo }],
        text,
      },
    ],
  };

  const response = await axios.post(
    `${INFOBIP_BASE_URL}/sms/2/text/advanced`,
    payload,
    {
      headers: {
        Authorization: `App ${INFOBIP_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 15000,
    }
  );

  console.log('📤 Infobip SMS response:', JSON.stringify(response.data, null, 2));
  return response.data;
}

async function sendAppointmentReminderSms({ patientPhone, dateTime, service }) {
  const dt = DateTime.fromISO(dateTime, { zone: TIME_ZONE });

  const formatted = dt.toFormat('yyyy-LL-dd HH:mm');

  const text =
    `Sanadenta: primename apie Jusu vizita ${formatted}` +
    (service ? ` (${service})` : '') +
    `. Atsakykite TAIP patvirtinimui arba NE atsaukimui.`;

  return sendSms({
    to: patientPhone,
    from: INFOBIP_2WAY_FROM, // svarbu dėl inbound reply
    text,
  });
}

async function sendAdminCancellationSms({ patientPhone, dateTime, service }) {
  const dtText =
    typeof dateTime?.toFormat === 'function'
      ? dateTime.toFormat('yyyy-LL-dd HH:mm')
      : String(dateTime);

  const adminPhone = normalizePhone(process.env.ADMIN_PHONE || '');

  if (!adminPhone) {
    console.warn('⚠️ ADMIN_PHONE not configured, skipping admin SMS');
    return;
  }

  const text =
    `Pacientas atsauke vizita. Tel: ${patientPhone}, laikas: ${dtText}` +
    (service ? `, paslauga: ${service}` : '');

  return sendSms({
    to: adminPhone,
    from: INFOBIP_1WAY_FROM,
    text,
  });
}

module.exports = {
  sendSms,
  sendAppointmentReminderSms,
  sendAdminCancellationSms,
};