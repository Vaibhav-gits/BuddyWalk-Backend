const express = require("express");
const router = express.Router();

const auth = require("../middleware/authMiddleware");

const {
  getChallenges,
  createChallenge,
  joinChallenge,
  challengeLeaderboard,
  getUserGroups,
} = require("../controllers/challengeController");

router.get("/", auth, getChallenges);

router.post("/join", auth, joinChallenge);

router.post("/create", auth, createChallenge);

router.get("/leaderboard/:id", auth, challengeLeaderboard);

router.get("/user-groups", auth, getUserGroups);

module.exports = router;
