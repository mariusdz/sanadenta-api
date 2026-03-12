// src/routes/reminders.js
const express = require('express');
const router = express.Router();
const { processDueReminders } = require('../services/reminder');
const requireApiKey = require('../middleware/apiKey');

router.post('/run-reminders-now', requireApiKey, async (req, res) => {
  try {
    await processDueReminders();
    return res.json({ ok: true, message: 'Reminder check completed' });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

module.exports = router;