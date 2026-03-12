// src/utils/cache.js
const freeSlotsCache = new Map();

const getFreeSlotsCacheKey = (date, service, durationMinutes) => {
  return `${date}__${service || ''}__${durationMinutes || ''}`;
};

const clearFreeSlotsCache = () => {
  freeSlotsCache.clear();
  console.log('🧹 Free slots cache cleared');
};

const getCachedFreeSlots = (key, ttl) => {
  const cached = freeSlotsCache.get(key);

  if (!cached) return null;

  const isFresh = Date.now() - cached.createdAt < ttl;

  if (!isFresh) {
    freeSlotsCache.delete(key);
    return null;
  }

  return cached.data;
};

const setCachedFreeSlots = (key, data) => {
  freeSlotsCache.set(key, {
    createdAt: Date.now(),
    data,
  });
};

module.exports = {
  freeSlotsCache,
  getFreeSlotsCacheKey,
  clearFreeSlotsCache,
  getCachedFreeSlots,
  setCachedFreeSlots,
};