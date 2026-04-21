const express = require("express");
const router = express.Router();

const {
  googleAuth,
  completeProfile,
  updateProfile,
  getProfile,
  deleteAccount,
  logout,
} = require("../controllers/authController");


router.post("/google", googleAuth);
router.post("/complete-profile", completeProfile);
router.put("/profile", updateProfile);
router.get("/profile", getProfile);
router.post("/logout", logout);
router.delete("/account", deleteAccount);

module.exports = router;