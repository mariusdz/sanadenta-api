// src/utils/dateTime.js
const { DateTime } = require('luxon');
const { TIME_ZONE } = require('../config');

const pad2 = (n) => String(n).padStart(2, '0');

const isValidDate = (date) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return false;

  const dt = DateTime.fromISO(date, { zone: TIME_ZONE });
  return dt.isValid;
};

const isValidTime = (time) => {
  if (!/^\d{2}:\d{2}$/.test(String(time || ''))) return false;

  const dt = DateTime.fromFormat(time, 'HH:mm', { zone: TIME_ZONE });
  return dt.isValid;
};

const overlaps = (aStart, aEnd, bStart, bEnd) => {
  return aStart < bEnd && aEnd > bStart;
};

// 1 = pirmadienis, 4 = ketvirtadienis, 5 = penktadienis
const isWeekdayAllowed = (dt) => [1, 4, 5].includes(dt.weekday);

const getLastMondayOfMonth = (dt) => {
  const lastDay = dt.endOf('month');
  const diff = (lastDay.weekday - 1 + 7) % 7;
  return lastDay.minus({ days: diff }).startOf('day');
};

const isSurgeonDay = (dt) => {
  const lastMon = getLastMondayOfMonth(dt);
  return dt.hasSame(lastMon, 'day');
};

const generateSlots = (startHHMM, endHHMM, stepMinutes, durationMinutes) => {
  const [startHour, startMin] = startHHMM.split(':').map(Number);
  const [endHour, endMin] = endHHMM.split(':').map(Number);

  const startTotal = startHour * 60 + startMin;
  const endTotal = endHour * 60 + endMin;
  const latestStart = endTotal - durationMinutes;

  const slots = [];

  for (let t = startTotal; t <= latestStart; t += stepMinutes) {
    slots.push(`${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`);
  }

  return slots;
};

const dtLocal = (date, time) => {
  return DateTime.fromFormat(`${date} ${time}`, 'yyyy-MM-dd HH:mm', {
    zone: TIME_ZONE,
  });
};

const formatHumanDate = (dt) => {
  if (!dt || !dt.isValid) return '';
  return dt.setLocale('lt').toFormat('dd/MM/yyyy');
};

const formatHumanDateTime = (dt) => {
  if (!dt || !dt.isValid) return '';
  return dt.setLocale('lt').toFormat('dd/MM/yyyy HH:mm');
};

module.exports = {
  pad2,
  isValidDate,
  isValidTime,
  overlaps,
  isWeekdayAllowed,
  isSurgeonDay,
  generateSlots,
  dtLocal,
  formatHumanDate,
  formatHumanDateTime,
};