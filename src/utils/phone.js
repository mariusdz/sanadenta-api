// src/utils/phone.js

function normalizePhone(input = '') {
  if (!input) return '';

  let phone = String(input).trim();

  // paliekam tik + ir skaičius
  phone = phone.replace(/[^\d+]/g, '');

  // +37060880418 -> 37060880418
  if (phone.startsWith('+370')) {
    return phone.slice(1);
  }

  // 37060880418 -> 37060880418
  if (phone.startsWith('370') && phone.length === 11) {
    return phone;
  }

  // 860880418 -> 37060880418
  if (phone.startsWith('8') && phone.length === 9) {
    return `370${phone.slice(1)}`;
  }

  // 60880418 -> 37060880418
  if (phone.startsWith('6') && phone.length === 8) {
    return `370${phone}`;
  }

  // bet koks kitas tarptautinis numeris su +
  if (phone.startsWith('+')) {
    return phone.slice(1);
  }

  return phone;
}

function toDisplayPhone(input = '') {
  const normalized = normalizePhone(input);

  if (normalized.startsWith('370') && normalized.length === 11) {
    return `+${normalized}`;
  }

  return normalized ? `+${normalized}` : '';
}

function isYesReply(text = '') {
  const value = String(text).trim().toLowerCase();

  return [
    'taip',
    't',
    'yes',
    'y',
    'ok',
    'gerai',
    'patvirtinu',
    'patvirtinta',
  ].includes(value);
}

function isNoReply(text = '') {
  const value = String(text).trim().toLowerCase();

  return [
    'ne',
    'n',
    'no',
    'cancel',
    'atsaukiu',
    'atšaukiu',
    'atsaukti',
    'atšaukti',
  ].includes(value);
}

module.exports = {
  normalizePhone,
  toDisplayPhone,
  isYesReply,
  isNoReply,
};