// routes/godmessageRoutes.js
const express = require("express");
const router = express.Router();
const { getTodayMessage, getMessageHistory, generateMessageForNewUser } = require("../controllers/GodmessageController");

router.get("/:userId", getTodayMessage);
router.get("/:userId/history", getMessageHistory);
router.post("/:userId/generate", generateMessageForNewUser); // ✅ NEW

module.exports = router;