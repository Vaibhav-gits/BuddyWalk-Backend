const express = require("express");
const router = express.Router();

const {
  saveSteps,
  getTodaySteps,
  getWeeklySteps,
  getUserStepsRange,
  getHistory,
  getGroupMemberSteps,
  getMonthlySteps,
} = require("../controllers/stepController");

const auth = require("../middleware/authMiddleware");

router.post("/save", auth, saveSteps);

router.get("/today", auth, getTodaySteps);

router.get("/weekly", auth, getWeeklySteps);

router.get("/monthly", auth, getMonthlySteps);

router.get("/history", auth, getHistory);

router.get("/user/:userId/history", auth, getUserStepsRange);

router.get("/group/:groupId/member/:userId", auth, getGroupMemberSteps);

module.exports = router;
