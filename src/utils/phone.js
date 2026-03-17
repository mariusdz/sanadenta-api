function normalizePhone(phone) {
  const raw = String(phone || '').trim();

  if (!raw) return '';

  if (raw.startsWith('+')) {
    return raw;
  }

  if (raw.startsWith('370')) {
    return `+${raw}`;
  }

  if (raw.startsWith('8') && raw.length === 9) {
    return `+370${raw.slice(1)}`;
  }

  return raw;
}

module.exports = {
  normalizePhone,
};