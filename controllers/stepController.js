const db = require("../config/db");
const moment = require("moment-timezone");
const { sendPushNotification } = require("../utils/sendPushNotification");
const { canSendNotification } = require("../helpers/notificationLog");
const {
  processOvertakeNotifications,
} = require("../utils/overtakeNotification");
const { processDailyAchievements } = require("./achievementController");

function getTodayInTimezone(tz) {
  try {
    return moment.tz(tz || "Asia/Kolkata").format("YYYY-MM-DD");
  } catch {
    return moment.tz("Asia/Kolkata").format("YYYY-MM-DD");
  }
}

function getUserTimezone(userId, callback) {
  db.query(
    "SELECT timezone FROM users WHERE id=? LIMIT 1",
    [userId],
    (err, rows) => {
      if (err || !rows.length) return callback(null, "Asia/Kolkata");
      callback(null, rows[0].timezone || "Asia/Kolkata");
    },
  );
}

function getTimezone(req) {
  if (!req) return "UTC";
  if (req.query && (req.query.tz || req.query.timezone))
    return req.query.tz || req.query.timezone;
  if (req.headers) {
    if (req.headers.timezone) return req.headers.timezone;
    if (req.headers["x-timezone"]) return req.headers["x-timezone"];
  }
  if (req.user && req.user.timezone) return req.user.timezone;
  return "UTC";
}

function checkStepGoalMilestone(userId, oldCount, newCount) {
  const milestones = [
    {
      steps: 5000,
      type: "milestone_5000",
      title: "Halfway There!",
      body: "Great job! You've reached 5,000 steps today!",
    },
    {
      steps: 8000,
      type: "milestone_8000",
      title: "Almost There!",
      body: `Just ${(10000 - newCount).toLocaleString()} more steps to hit your daily goal!`,
    },
    {
      steps: 10000,
      type: "milestone_10000",
      title: "Daily Goal Completed!",
      body: "Amazing! You completed your 10,000 steps goal today!",
    },
  ];

  let i = 0;

  function next() {
    if (i >= milestones.length) return;
    const milestone = milestones[i++];

    if (oldCount >= milestone.steps || newCount < milestone.steps)
      return next();

    canSendNotification(userId, 0, milestone.type, (err, shouldSend) => {
      if (err || !shouldSend) return next();

      db.query(
        "SELECT token FROM device_tokens WHERE user_id = ?",
        [userId],
        (err2, results) => {
          if (err2) {
            console.error("milestone token error:", err2);
            return next();
          }
          const tokens = [
            ...new Set(results.map((r) => r.token).filter(Boolean)),
          ];
          if (!tokens.length) return next();

          sendPushNotification(
            tokens,
            milestone.title,
            milestone.body,
            (notifErr) => {
              if (notifErr)
                console.error(
                  "milestone push error:",
                  notifErr?.message || notifErr,
                );
              next();
            },
          );
        },
      );
    });
  }

  next();
}

function checkAndNotifyOvertake(userId, newStepCount, today) {
  const sql = `
    SELECT
      u.id AS member_id,
      u.name AS member_name,
      COALESCE(s.step_count, 0) AS member_steps,
      dt.token AS member_token,
      me.name AS my_name
    FROM group_members gm
    JOIN users u ON gm.user_id = u.id
    LEFT JOIN steps s ON s.user_id = u.id AND s.step_date = ?
    LEFT JOIN device_tokens dt ON dt.user_id = u.id
    JOIN users me ON me.id = ?
    WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
    AND u.id != ?
    AND COALESCE(s.step_count, 0) < ?
    AND COALESCE(s.step_count, 0) > 0
  `;

  db.query(
    sql,
    [today, userId, userId, userId, newStepCount],
    (err, results) => {
      if (err) {
        console.error("checkAndNotifyOvertake error:", err);
        return;
      }
      if (!results.length) return;

      const byMember = new Map();
      for (const member of results) {
        if (!member.member_token) continue;
        const set = byMember.get(member.member_id) || new Set();
        set.add(member.member_token);
        byMember.set(member.member_id, set);
      }

      const entries = [...byMember.entries()];
      let i = 0;

      function next() {
        if (i >= entries.length) return;
        const [memberId, tokensSet] = entries[i++];
        const tokens = [...tokensSet];
        if (!tokens.length) return next();

        canSendNotification(
          memberId,
          0,
          `overtaken_by_${userId}`,
          (err2, shouldSend) => {
            if (err2 || !shouldSend) return next();

            const memberData = results.find((r) => r.member_id === memberId);
            sendPushNotification(
              tokens,
              "You've been overtaken!",
              `${memberData.my_name} just passed you with ${newStepCount.toLocaleString()} steps today!`,
              (notifErr) => {
                if (notifErr)
                  console.error(
                    "overtake push error:",
                    notifErr?.message || notifErr,
                  );
                next();
              },
            );
          },
        );
      }

      next();
    },
  );
}

exports.saveSteps = (req, res) => {
  const userId = req.user.id;
  const stepsNum = Number(req.body.step_count) || 0;

  getUserTimezone(userId, (err, tz) => {
    const today = getTodayInTimezone(tz);

    db.query(
      "SELECT id, step_count FROM steps WHERE user_id=? AND step_date=? LIMIT 1",
      [userId, today],
      (err2, findRes) => {
        if (err2) {
          console.error("saveSteps find error:", err2);
          return res.status(500).json({ message: "Server error" });
        }

        const afterSave = (message) => {
          db.query(
            "SELECT goal_steps FROM users WHERE id=? LIMIT 1",
            [userId],
            (gErr, gRes) => {
              const dailyGoal =
                gRes && gRes.length
                  ? Number(gRes[0].goal_steps) || 10000
                  : 10000;

              processDailyAchievements(userId, stepsNum, today, dailyGoal);
            },
          );
          checkStepGoalMilestone(
            userId,
            findRes.length ? findRes[0].step_count : 0,
            stepsNum,
          );
          checkAndNotifyOvertake(userId, stepsNum, today);

          db.query(
            "SELECT group_id FROM group_members WHERE user_id = ?",
            [userId],
            (e, groups) => {
              if (!e && groups.length) {
                groups.forEach((g) => {
                  processOvertakeNotifications(g.group_id, (overtakeErr) => {
                    if (overtakeErr)
                      console.error(
                        "processOvertakeNotifications error:",
                        overtakeErr?.message || overtakeErr,
                      );
                  });
                });
              }
            },
          );

          return res.json({ message, date: today, timezone: tz });
        };

        if (findRes.length > 0) {
          db.query(
            "UPDATE steps SET step_count=? WHERE id=?",
            [stepsNum, findRes[0].id],
            (err3) => {
              if (err3) {
                console.error("saveSteps update error:", err3);
                return res.status(500).json({ message: "Server error" });
              }
              afterSave("Steps updated");
            },
          );
        } else {
          db.query(
            "INSERT INTO steps (user_id, step_count, step_date) VALUES (?, ?, ?)",
            [userId, stepsNum, today],
            (err3) => {
              if (err3) {
                console.error("saveSteps insert error:", err3);
                return res.status(500).json({ message: "Server error" });
              }
              afterSave("Steps saved");
            },
          );
        }
      },
    );
  });
};

exports.getTodaySteps = (req, res) => {
  const userId = req.user.id;
  const tz = getTimezone(req);
  const today = getTodayInTimezone(tz);

  db.query(
    "SELECT step_count FROM steps WHERE user_id=? AND step_date=?",
    [userId, today],
    (err, result) => {
      if (err) {
        console.error("getTodaySteps error:", err);
        return res.status(500).json({ message: "Server error" });
      }
      if (!result.length) return res.json({ step_count: 0, date: today });
      return res.json({ ...result[0], date: today });
    },
  );
};

exports.getWeeklySteps = (req, res) => {
  const userId = req.user.id;
  const tz = getTimezone(req);
  const nowInTz = moment.tz(tz);
  const today = nowInTz.format("YYYY-MM-DD");
  const weekStart = nowInTz.clone().startOf("isoWeek").format("YYYY-MM-DD");

  db.query(
    `SELECT step_date, step_count FROM steps
     WHERE user_id = ? AND step_date >= ? AND step_date <= ?
     ORDER BY step_date ASC`,
    [userId, weekStart, today],
    (err, result) => {
      if (err) {
        console.error("getWeeklySteps error:", err);
        return res.status(500).json({ message: "Server error" });
      }

      const week = [0, 0, 0, 0, 0, 0, 0];
      result.forEach((r) => {
        const dayIndex = moment.tz(r.step_date, tz).isoWeekday() - 1;
        if (dayIndex >= 0 && dayIndex < 7)
          week[dayIndex] = Number(r.step_count) || 0;
      });

      const todayRow = result.find(
        (r) => moment.tz(r.step_date, tz).format("YYYY-MM-DD") === today,
      );
      const todaySteps = todayRow ? Number(todayRow.step_count) : 0;

      return res.json({
        daily: week,
        today_steps: todaySteps,
        debug: { timezone: tz, today, weekStart },
      });
    },
  );
};
exports.getMonthlySteps = (req, res) => {
  const userId = req.user.id;

  const now = moment();
  const start = now.clone().startOf("month").format("YYYY-MM-DD");
  const end = now.clone().endOf("month").format("YYYY-MM-DD");

  db.query(
    `
    SELECT SUM(step_count) as total
    FROM steps
    WHERE user_id=? 
    AND step_date BETWEEN ? AND ?
  `,
    [userId, start, end],
    (err, result) => {
      if (err) {
        console.log(err);
        return res.status(500).json({
          message: "Server error",
        });
      }

      return res.json({
        total: Number(result[0]?.total || 0),
      });
    },
  );
};

exports.getUserStepsRange = (req, res) => {
  const requestedUserId = req.params.userId;

  getUserTimezone(requestedUserId, (err, tz) => {
    const today = moment.tz(tz).format("YYYY-MM-DD");
    let { start, end, days, date } = req.query;

    if (date) {
      if (!moment(date, "YYYY-MM-DD", true).isValid())
        return res
          .status(400)
          .json({ message: "Invalid date format. Use YYYY-MM-DD." });
      start = date;
      end = date;
    } else if (days) {
      const d = parseInt(days, 10) || 1;
      start = moment
        .tz(tz)
        .clone()
        .subtract(d - 1, "days")
        .format("YYYY-MM-DD");
      end = today;
    }

    if (!start && !end) {
      start = today;
      end = today;
    }
    start = start || end;
    end = end || start;

    if (
      !moment(start, "YYYY-MM-DD", true).isValid() ||
      !moment(end, "YYYY-MM-DD", true).isValid()
    )
      return res
        .status(400)
        .json({ message: "Invalid date format. Use YYYY-MM-DD." });

    db.query(
      `SELECT step_date, step_count FROM steps
       WHERE user_id = ? AND step_date >= ? AND step_date <= ?
       ORDER BY step_date ASC`,
      [requestedUserId, start, end],
      (err2, result) => {
        if (err2) {
          console.error("getUserStepsRange error:", err2);
          return res.status(500).json({ message: "Server error" });
        }

        const normalized = result.map((r) => ({
          step_date: moment.tz(r.step_date, tz).format("YYYY-MM-DD"),
          step_count: Number(r.step_count) || 0,
        }));

        const startM = moment.tz(start, tz);
        const endM = moment.tz(end, tz);
        const daysDiff = endM.diff(startM, "days");

        const out = [];
        for (let i = 0; i <= daysDiff; i++) {
          out.push({
            step_date: startM.clone().add(i, "days").format("YYYY-MM-DD"),
            step_count: 0,
          });
        }
        normalized.forEach((r) => {
          const idx = out.findIndex((o) => o.step_date === r.step_date);
          if (idx >= 0) out[idx].step_count = r.step_count;
        });

        return res.json({ user_id: requestedUserId, start, end, daily: out });
      },
    );
  });
};

exports.getHistory = (req, res) => {
  const userId = req.user.id;

  db.query(
    "SELECT step_date, step_count FROM steps WHERE user_id = ? ORDER BY step_date DESC",
    [userId],
    (err, result) => {
      if (err) {
        console.error("getHistory error:", err);
        return res.status(500).json({ message: "Server error" });
      }

      const totalSteps = result.reduce((s, r) => s + (r.step_count || 0), 0);

      return res.json({
        history: result,
        summary: {
          total_steps: totalSteps,
          total_distance_km: Number((totalSteps * 0.000762).toFixed(2)),
          total_calories: Math.round(totalSteps * 0.04),
          days_active: result.length,
        },
      });
    },
  );
};

exports.getUserHistory = (req, res) => {
  const { userId } = req.params;
  const days = parseInt(req.query.days) || 7;

  db.query(
    `SELECT step_date, step_count FROM steps
     WHERE user_id = ? AND step_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY step_date DESC`,
    [userId, days],
    (err, result) => {
      if (err) {
        console.error("getUserHistory error:", err);
        return res.status(500).json({ message: "Server error" });
      }
      return res.json({ daily: result });
    },
  );
};

exports.getGroupMemberSteps = (req, res) => {
  const memberId = req.params.userId;
  const groupId = req.params.groupId;

  getUserTimezone(memberId, (err, tz) => {
    db.query(
      "SELECT joined_at FROM group_members WHERE user_id=? AND group_id=? LIMIT 1",
      [memberId, groupId],
      (err2, joinRes) => {
        if (err2) {
          console.error("getGroupMemberSteps error:", err2);
          return res.status(500).json({ message: "Server error" });
        }
        if (!joinRes.length)
          return res.status(404).json({ message: "Member not found in group" });

        const startDate = moment
          .tz(joinRes[0].joined_at, tz)
          .format("YYYY-MM-DD");
        const today = moment.tz(tz).format("YYYY-MM-DD");

        db.query(
          `SELECT step_date, step_count FROM steps
           WHERE user_id=? AND step_date >= ? AND step_date <= ?
           ORDER BY step_date ASC`,
          [memberId, startDate, today],
          (err3, result) => {
            if (err3) {
              console.error("getGroupMemberSteps query error:", err3);
              return res.status(500).json({ message: "Server error" });
            }

            const normalized = result.map((r) => ({
              step_date: moment.utc(r.step_date).format("YYYY-MM-DD"),
              step_count: Number(r.step_count) || 0,
            }));

            const startM = moment.tz(startDate, tz);
            const endM = moment.tz(today, tz);
            const daysDiff = endM.diff(startM, "days");

            const out = [];
            for (let i = 0; i <= daysDiff; i++) {
              out.push({
                step_date: startM.clone().add(i, "days").format("YYYY-MM-DD"),
                step_count: 0,
              });
            }
            normalized.forEach((r) => {
              const idx = out.findIndex((o) => o.step_date === r.step_date);
              if (idx >= 0) out[idx].step_count = r.step_count;
            });

            return res.json({
              user_id: memberId,
              group_id: groupId,
              daily: out,
            });
          },
        );
      },
    );
  });
};
