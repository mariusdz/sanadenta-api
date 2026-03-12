// src/middleware/apiKey.js
const { API_KEY } = require('../config');

const requireApiKey = (req, res, next) => {
  if (!API_KEY) return next();

  const apiKey = req.header('x-api-key');
  if (!apiKey || apiKey !== API_KEY) {
    console.warn(`⚠️ Unauthorized access attempt from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized - invalid API key' });
  }

  next();
};

module.exports = requireApiKey;