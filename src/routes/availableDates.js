// src/routes/availableDates.js
const express = require('express');
const router = express.Router();

const { getAvailableDates } = require('../services/googleCalendar');

router.get('/', async (req, res) => {
  try {
    const service =
      String(req.query.service || req.query.serviceName || 'Vizitas').trim();

    const fromDate = req.query.fromDate
      ? String(req.query.fromDate).trim()
      : undefined;

    const daysAhead = Math.min(
      Math.max(Number(req.query.daysAhead || 60), 1),
      120
    );

    const dates = await getAvailableDates({
      serviceName: service,
      fromDate,
      daysAhead,
    });

    return res.json({
      ok: true,
      service,
      fromDate: fromDate || null,
      daysAhead,
      dates,
    });
  } catch (error) {
    console.error('❌ Available dates error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

module.exports = router;