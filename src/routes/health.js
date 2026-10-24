const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

/**
 * @route   GET /health
 * @desc    Health check endpoint reporting application and service connectivity
 * @access  Public
 */
router.get('/', (req, res) => {
  const isDbConnected = mongoose.connection.readyState === 1;

  res.status(200).json({
    status: 'ok',
    uptime: Number(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
    services: {
      database: isDbConnected ? 'connected' : 'disconnected',
    },
  });
});

module.exports = router;
