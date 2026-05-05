const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();

const authRoutes = require("./routes/authRoutes");
const stepRoutes = require("./routes/stepRoutes");
const groupRoutes = require("./routes/groupRoutes");
const challengeRoutes = require("./routes/challengeRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const godMessagesRoutes = require("./routes/Godmessagesroutes");
const {
  deleteAccount,
  updateProfile,
  getProfile,
} = require("./controllers/authController");

require("./cron/yesterdaySteps");
require("./cron/randomMessages");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api/steps", stepRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/groups", groupRoutes);
app.use("/api/challenges", challengeRoutes);
app.use("/api/notifications", notificationRoutes);
app.delete("/api/users/me", deleteAccount);
app.put("/api/users/me", updateProfile);
app.get("/api/users/me", getProfile);
app.use("/api/god-messages", godMessagesRoutes);

const PORT = process.env.PORT || 4000;

app.get("/", (req, res) => {
  res.send("Welcome to group step app ");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
