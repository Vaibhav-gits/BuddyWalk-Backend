const db = require("../config/db");
const moment = require("moment-timezone");
const { sendPushNotification } = require("../utils/sendPushNotification");
const { canSendNotification } = require("../helpers/notificationLog");
const { processOvertakeNotifications } = require("../utils/overtakeNotification");

function getTodayInTimezone(tz) {
  try {
    return moment.tz(tz || "Asia/Kolkata").format("YYYY-MM-DD");
  } catch {
    return moment.tz("Asia/Kolkata").format("YYYY-MM-DD");
  }
}

async function getUserTimezone(userId) {
  return new Promise((resolve) => {
    db.query(
      "SELECT timezone FROM users WHERE id=? LIMIT 1",
      [userId],
      (err, res) => {
        if (err || !res.length) return resolve("Asia/Kolkata");
        resolve(res[0].timezone || "Asia/Kolkata");
      },
    );
  });
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

exports.saveSteps = async (req, res) => {
  const userId = req.user.id;
  const { step_count } = req.body;

  const tz = await getUserTimezone(userId);
  const today = getTodayInTimezone(tz);

  const findSql = `SELECT id, step_count FROM steps WHERE user_id=? AND step_date=? LIMIT 1`;

  const stepsNum = Number(step_count) || 0;

  db.query(findSql, [userId, today], (findErr, findRes) => {
    if (findErr) return res.status(500).json(findErr);

    if (findRes && findRes.length > 0) {
      const oldStepCount = findRes[0].step_count;
      const rowId = findRes[0].id;
      const updateSql = `UPDATE steps SET step_count=? WHERE id=?`;

      db.query(updateSql, [step_count, rowId], (upErr) => {
        if (upErr) return res.status(500).json(upErr);

        checkStepGoalMilestone(userId, oldStepCount, step_count);
        checkAndNotifyOvertake(userId, step_count, today);

        db.query(
          `SELECT group_id FROM group_members WHERE user_id = ?`,
          [userId],
          (gErr, gRes) => {
            if (gErr || !gRes || !gRes.length) return;
            for (const g of gRes) {
              processOvertakeNotifications(g.group_id).catch(console.error);
            }
          },
        );

        return res.json({
          message: "Steps updated",
          date: today,
          timezone: tz,
        });
      });
    } else {
      const insertSql = `INSERT INTO steps (user_id, step_count, step_date) VALUES (?, ?, ?)`;

      db.query(insertSql, [userId, step_count, today], (inErr) => {
        if (inErr) return res.status(500).json(inErr);

        checkStepGoalMilestone(userId, 0, step_count);
        checkAndNotifyOvertake(userId, step_count, today);

        // Trigger overtake processing for all groups the user belongs to (async, non-blocking)
        db.query(
          `SELECT group_id FROM group_members WHERE user_id = ?`,
          [userId],
          (gErr, gRes) => {
            if (gErr || !gRes || !gRes.length) return;
            for (const g of gRes) {
              processOvertakeNotifications(g.group_id).catch(console.error);
            }
          },
        );

        return res.json({
          message: "Steps saved",
          date: today,
          timezone: tz,
        });
      });
    }
  });
};

exports.getTodaySteps = (req, res) => {
  const userId = req.user.id;

  const tz = getTimezone(req);
  const today = getTodayInTimezone(tz);

  const sql = `SELECT step_count FROM steps WHERE user_id=? AND step_date=?`;

  db.query(sql, [userId, today], (err, result) => {
    if (err) return res.status(500).json(err);
    if (result.length === 0) return res.json({ step_count: 0, date: today });
    res.json({ ...result[0], date: today });
  });
};

exports.getWeeklySteps = (req, res) => {
  const userId = req.user.id;

  const tz = getTimezone(req);
  const nowInTz = moment.tz(tz);
  const today = nowInTz.format("YYYY-MM-DD");

  const weekStart = nowInTz.clone().startOf("isoWeek").format("YYYY-MM-DD");

  const sql = `
    SELECT step_date, step_count
    FROM steps
    WHERE user_id = ?
    AND step_date >= ?
    AND step_date <= ?
    ORDER BY step_date ASC
  `;

  db.query(sql, [userId, weekStart, today], (err, result) => {
    if (err) return res.status(500).json(err);

    const week = [0, 0, 0, 0, 0, 0, 0];

    result.forEach((r) => {
      const dayIndex = moment.tz(r.step_date, tz).isoWeekday() - 1;
      if (dayIndex >= 0 && dayIndex < 7) {
        week[dayIndex] = Number(r.step_count) || 0;
      }
    });

    const todayRow = result.find(
      (r) => moment.tz(r.step_date, tz).format("YYYY-MM-DD") === today,
    );
    const todaySteps = todayRow ? Number(todayRow.step_count) : 0;

    res.json({
      daily: week,
      today_steps: todaySteps,
      debug: { timezone: tz, today, weekStart },
    });
  });
};

// ✅ FIXED: Now fetches user's timezone from DB so dates match how steps were saved
exports.getUserStepsRange = async (req, res) => {
  const requestedUserId = req.params.userId;

  // ✅ Always use the requested user's saved timezone (same as saveSteps does)
  const tz = await getUserTimezone(requestedUserId);
  const today = moment.tz(tz).format("YYYY-MM-DD");

  let { start, end, days, date } = req.query;

  // ✅ Support explicit ?date=YYYY-MM-DD for single day lookup (Today tab)
  if (date) {
    if (!moment(date, "YYYY-MM-DD", true).isValid()) {
      return res
        .status(400)
        .json({ message: "Invalid date format. Use YYYY-MM-DD." });
    }
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
  ) {
    return res
      .status(400)
      .json({ message: "Invalid date format. Use YYYY-MM-DD." });
  }

  const sql = `
    SELECT step_date, step_count
    FROM steps
    WHERE user_id = ?
    AND step_date >= ?
    AND step_date <= ?
    ORDER BY step_date ASC
  `;

  db.query(sql, [requestedUserId, start, end], (err, result) => {
    if (err) return res.status(500).json(err);
    // Normalize DB result dates to the user's timezone and YYYY-MM-DD
    const normalized = (result || []).map((r) => ({
      step_date: moment.tz(r.step_date, tz).format("YYYY-MM-DD"),
      step_count: Number(r.step_count) || 0,
    }));

    const startM = moment.tz(start, tz);
    const endM = moment.tz(end, tz);
    const daysDiff = endM.diff(startM, "days");

    const out = [];
    for (let i = 0; i <= daysDiff; i++) {
      const d = startM.clone().add(i, "days").format("YYYY-MM-DD");
      out.push({ step_date: d, step_count: 0 });
    }

    normalized.forEach((r) => {
      const idx = out.findIndex((o) => o.step_date === r.step_date);
      if (idx >= 0) out[idx].step_count = r.step_count;
    });

    res.json({ user_id: requestedUserId, start, end, daily: out });
  });
};

async function checkStepGoalMilestone(userId, oldCount, newCount) {
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

  for (const milestone of milestones) {
    if (oldCount < milestone.steps && newCount >= milestone.steps) {
      const shouldSend = await canSendNotification(userId, 0, milestone.type);
      if (!shouldSend) continue;

      db.query(
        "SELECT token FROM device_tokens WHERE user_id = ?",
        [userId],
        async (err, results) => {
          if (!err && results.length > 0) {
            const tokens = [
              ...new Set(results.map((r) => r.token).filter(Boolean)),
            ];
            if (tokens.length > 0) {
              await sendPushNotification(
                tokens,
                milestone.title,
                milestone.body,
              );
            }
          }
        },
      );
    }
  }
}

async function checkAndNotifyOvertake(userId, newStepCount, today) {
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
    WHERE gm.group_id IN (
      SELECT group_id FROM group_members WHERE user_id = ?
    )
    AND u.id != ?
    AND COALESCE(s.step_count, 0) < ?
    AND COALESCE(s.step_count, 0) > 0
  `;

  db.query(
    sql,
    [today, userId, userId, userId, newStepCount],
    async (err, results) => {
      if (err || !results.length) return;

      const byMember = new Map();
      for (const member of results) {
        if (!member.member_token) continue;
        const set = byMember.get(member.member_id) || new Set();
        set.add(member.member_token);
        byMember.set(member.member_id, set);
      }

      for (const [memberId, tokensSet] of byMember.entries()) {
        const tokens = [...tokensSet];
        if (tokens.length === 0) continue;

        const shouldSend = await canSendNotification(
          memberId,
          0,
          `overtaken_by_${userId}`,
        );
        if (!shouldSend) continue;

        await sendPushNotification(
          tokens,
          "You've been overtaken!",
          `${results.find((r) => r.member_id === memberId).my_name} just passed you with ${newStepCount.toLocaleString()} steps today!`,
        );
      }
    },
  );
}

exports.getHistory = (req, res) => {
  const userId = req.user.id;
  const days = parseInt(req.query.days) || 30;

  const sql = `
  SELECT
    step_date,
    step_count
  FROM steps
  WHERE user_id = ?
  ORDER BY step_date DESC
`;

  db.query(sql, [userId, days], (err, result) => {
    if (err) return res.status(500).json(err);

    const totalSteps = result.reduce((s, r) => s + (r.step_count || 0), 0);

    const totalDistanceKm = Number((totalSteps * 0.000762).toFixed(2));
    const totalCalories = Math.round(totalSteps * 0.04);

    res.json({
      history: result,
      summary: {
        total_steps: totalSteps,
        total_distance_km: totalDistanceKm,
        total_calories: totalCalories,
        days_active: result.length,
      },
    });
  });
};

exports.getUserHistory = (req, res) => {
  const { userId } = req.params;
  const days = parseInt(req.query.days) || 7;

  const sql = `
    SELECT
      step_date,
      step_count
    FROM steps
    WHERE user_id = ?
      AND step_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    ORDER BY step_date DESC
  `;

  db.query(sql, [userId, days], (err, result) => {
    if (err) return res.status(500).json(err);
    res.json({ daily: result });
  });
};

exports.getGroupMemberSteps = async (req, res) => {
  const memberId = req.params.userId;
  const groupId = req.params.groupId;


  const tz = await getUserTimezone(memberId);

  const joinSql = `SELECT joined_at FROM group_members WHERE user_id=? AND group_id=? LIMIT 1`;
  db.query(joinSql, [memberId, groupId], (joinErr, joinRes) => {
    if (joinErr) return res.status(500).json(joinErr);
    if (!joinRes.length)
      return res.status(404).json({ message: "Member not found in group" });

    const startDate = moment.tz(joinRes[0].joined_at, tz).format("YYYY-MM-DD");
    const today = moment.tz(tz).format("YYYY-MM-DD");

    const stepsSql = `
      SELECT step_date, step_count
      FROM steps
      WHERE user_id=? AND step_date >= ? AND step_date <= ?
      ORDER BY step_date ASC
    `;
    db.query(stepsSql, [memberId, startDate, today], (err, result) => {
      if (err) return res.status(500).json(err);


      const normalized = (result || []).map((r) => ({
        step_date: moment.utc(r.step_date).format("YYYY-MM-DD"),
        step_count: Number(r.step_count) || 0,
      }));

      const out = [];
      const startM = moment.tz(startDate, tz);
      const endM = moment.tz(today, tz);
      const daysDiff = endM.diff(startM, "days");

      for (let i = 0; i <= daysDiff; i++) {
        const d = startM.clone().add(i, "days").format("YYYY-MM-DD");
        out.push({ step_date: d, step_count: 0 });
      }

      normalized.forEach((r) => {
        const idx = out.findIndex((o) => o.step_date === r.step_date);
        if (idx >= 0) out[idx].step_count = r.step_count;
      });

      res.json({ user_id: memberId, group_id: groupId, daily: out });
    });
  });
};
