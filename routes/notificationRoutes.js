const express = require('express');
const router = express.Router();
const {
	sendNotification,
	saveToken,
} = require('../controllers/notificationController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/send', authMiddleware, sendNotification);

router.post('/save-token', authMiddleware, saveToken);

module.exports = router;