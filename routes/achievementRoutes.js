const express = require("express");
const router = express.Router();

const auth = require("../middleware/authMiddleware");

const {
  getAchievementsSummary,
} = require("../controllers/achievementController");

router.get("/summary", auth, getAchievementsSummary);

module.exports = router;