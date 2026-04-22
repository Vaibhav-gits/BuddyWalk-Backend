const express = require("express");
const router = express.Router();
const {
  sendNotification,
  saveToken,
  goalMilestone,
} = require("../controllers/notificationController");
const authMiddleware = require("../middleware/authMiddleware");

router.post("/send", authMiddleware, sendNotification);
router.post("/goal-milestone", authMiddleware, goalMilestone);

router.post("/save-token", authMiddleware, saveToken);

module.exports = router;
