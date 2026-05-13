const db = require("../config/db");
const moment = require("moment-timezone");

const MILESTONES = [
  { type: "5k", threshold: 5000 },
  { type: "7k", threshold: 7000 },
  { type: "10k", threshold: 10000 },
  { type: "15k", threshold: 15000 },
  { type: "20k", threshold: 20000 },
  { type: "25k", threshold: 25000 },
];

function getHighestMilestone(steps) {
  let matched = null;

  for (const m of MILESTONES) {
    if (steps >= m.threshold) {
      matched = m;
    }
  }

  return matched;
}

exports.processDailyAchievements = (userId, stepCount, stepDate, dailyGoal) => {
  const highest = getHighestMilestone(stepCount);

  if (highest) {
    db.query(
      `
      INSERT IGNORE INTO achievements
      (user_id, achievement_type, achievement_date)
      VALUES (?, ?, ?)
    `,
      [userId, highest.type, stepDate],
    );
  }

  if (stepCount >= dailyGoal) {
    db.query(
      `
      INSERT IGNORE INTO achievements
      (user_id, achievement_type, achievement_date)
      VALUES (?, 'goal_complete', ?)
    `,
      [userId, stepDate],
    );
  }
};

exports.getAchievementsSummary = (req, res) => {
  const userId = req.user.id;

  db.query(
    `
    SELECT achievement_type, COUNT(*) as total
    FROM achievements
    WHERE user_id=?
    GROUP BY achievement_type
  `,
    [userId],
    (err, result) => {
      if (err) {
        console.log(err);
        return res.status(500).json({
          message: "Server error",
        });
      }

      const data = {
        goalsCompleted: 0,
        milestones: {
          "5k": 0,
          "7k": 0,
          "10k": 0,
          "15k": 0,
          "20k": 0,
          "25k": 0,
        },
      };

      result.forEach((r) => {
        if (r.achievement_type === "goal_complete") {
          data.goalsCompleted = Number(r.total);
        } else {
          data.milestones[r.achievement_type] = Number(r.total);
        }
      });

      return res.json(data);
    },
  );
};
