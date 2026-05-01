const db = require("../config/db");
const moment = require("moment-timezone");
const { sendPushNotification } = require("../utils/sendPushNotification");
const { canSendNotification } = require("../helpers/notificationLog");
const {
  processOvertakeNotifications,
} = require("../utils/overtakeNotification");

function getTodayInTimezone(tz) {
  try {
    return moment.tz(tz || "Asia/Kolkata").format("YYYY-MM-DD");
  } catch {
    return moment.tz("Asia/Kolkata").format("YYYY-MM-DD");
  }
}

async function getUserTimezone(userId) {
  const [rows] = await db.query(
    "SELECT timezone FROM users WHERE id=? LIMIT 1",
    [userId],
  );
  return rows.length ? rows[0].timezone || "Asia/Kolkata" : "Asia/Kolkata";
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
  try {
    const userId = req.user.id;
    const { step_count } = req.body;
    const stepsNum = Number(step_count) || 0;

    const tz = await getUserTimezone(userId);
    const today = getTodayInTimezone(tz);

    const [findRes] = await db.query(
      `SELECT id, step_count FROM steps WHERE user_id=? AND step_date=? LIMIT 1`,
      [userId, today],
    );

    if (findRes.length > 0) {
      const oldStepCount = findRes[0].step_count;
      const rowId = findRes[0].id;

      await db.query(`UPDATE steps SET step_count=? WHERE id=?`, [
        stepsNum,
        rowId,
      ]);

      checkStepGoalMilestone(userId, oldStepCount, stepsNum);
      checkAndNotifyOvertake(userId, stepsNum, today);

      const [groups] = await db.query(
        `SELECT group_id FROM group_members WHERE user_id = ?`,
        [userId],
      );
      for (const g of groups) {
        processOvertakeNotifications(g.group_id).catch(console.error);
      }

      return res.json({ message: "Steps updated", date: today, timezone: tz });
    } else {
      await db.query(
        `INSERT INTO steps (user_id, step_count, step_date) VALUES (?, ?, ?)`,
        [userId, stepsNum, today],
      );

      checkStepGoalMilestone(userId, 0, stepsNum);
      checkAndNotifyOvertake(userId, stepsNum, today);

      const [groups] = await db.query(
        `SELECT group_id FROM group_members WHERE user_id = ?`,
        [userId],
      );
      for (const g of groups) {
        processOvertakeNotifications(g.group_id).catch(console.error);
      }

      return res.json({ message: "Steps saved", date: today, timezone: tz });
    }
  } catch (err) {
    console.error("saveSteps error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getTodaySteps = async (req, res) => {
  try {
    const userId = req.user.id;
    const tz = getTimezone(req);
    const today = getTodayInTimezone(tz);

    const [result] = await db.query(
      `SELECT step_count FROM steps WHERE user_id=? AND step_date=?`,
      [userId, today],
    );

    if (!result.length) return res.json({ step_count: 0, date: today });
    return res.json({ ...result[0], date: today });
  } catch (err) {
    console.error("getTodaySteps error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getWeeklySteps = async (req, res) => {
  try {
    const userId = req.user.id;
    const tz = getTimezone(req);
    const nowInTz = moment.tz(tz);
    const today = nowInTz.format("YYYY-MM-DD");
    const weekStart = nowInTz.clone().startOf("isoWeek").format("YYYY-MM-DD");

    const [result] = await db.query(
      `SELECT step_date, step_count FROM steps
       WHERE user_id = ? AND step_date >= ? AND step_date <= ?
       ORDER BY step_date ASC`,
      [userId, weekStart, today],
    );

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
  } catch (err) {
    console.error("getWeeklySteps error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getUserStepsRange = async (req, res) => {
  try {
    const requestedUserId = req.params.userId;
    const tz = await getUserTimezone(requestedUserId);
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

    const [result] = await db.query(
      `SELECT step_date, step_count FROM steps
       WHERE user_id = ? AND step_date >= ? AND step_date <= ?
       ORDER BY step_date ASC`,
      [requestedUserId, start, end],
    );

    const normalized = result.map((r) => ({
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

    return res.json({ user_id: requestedUserId, start, end, daily: out });
  } catch (err) {
    console.error("getUserStepsRange error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

async function checkStepGoalMilestone(userId, oldCount, newCount) {
  try {
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

        const [results] = await db.query(
          "SELECT token FROM device_tokens WHERE user_id = ?",
          [userId],
        );
        const tokens = [
          ...new Set(results.map((r) => r.token).filter(Boolean)),
        ];
        if (tokens.length > 0) {
          await sendPushNotification(tokens, milestone.title, milestone.body);
        }
      }
    }
  } catch (err) {
    console.error("checkStepGoalMilestone error:", err);
  }
}

async function checkAndNotifyOvertake(userId, newStepCount, today) {
  try {
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

    const [results] = await db.query(sql, [
      today,
      userId,
      userId,
      userId,
      newStepCount,
    ]);
    if (!results.length) return;

    const byMember = new Map();
    for (const member of results) {
      if (!member.member_token) continue;
      const set = byMember.get(member.member_id) || new Set();
      set.add(member.member_token);
      byMember.set(member.member_id, set);
    }

    for (const [memberId, tokensSet] of byMember.entries()) {
      const tokens = [...tokensSet];
      if (!tokens.length) continue;

      const shouldSend = await canSendNotification(
        memberId,
        0,
        `overtaken_by_${userId}`,
      );
      if (!shouldSend) continue;

      const memberData = results.find((r) => r.member_id === memberId);
      await sendPushNotification(
        tokens,
        "You've been overtaken!",
        `${memberData.my_name} just passed you with ${newStepCount.toLocaleString()} steps today!`,
      );
    }
  } catch (err) {
    console.error("checkAndNotifyOvertake error:", err);
  }
}

exports.getHistory = async (req, res) => {
  try {
    const userId = req.user.id;

    const [result] = await db.query(
      `SELECT step_date, step_count FROM steps WHERE user_id = ? ORDER BY step_date DESC`,
      [userId],
    );

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
  } catch (err) {
    console.error("getHistory error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getUserHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const days = parseInt(req.query.days) || 7;

    const [result] = await db.query(
      `SELECT step_date, step_count FROM steps
       WHERE user_id = ? AND step_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       ORDER BY step_date DESC`,
      [userId, days],
    );

    return res.json({ daily: result });
  } catch (err) {
    console.error("getUserHistory error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getGroupMemberSteps = async (req, res) => {
  try {
    const memberId = req.params.userId;
    const groupId = req.params.groupId;

    const tz = await getUserTimezone(memberId);

    const [joinRes] = await db.query(
      `SELECT joined_at FROM group_members WHERE user_id=? AND group_id=? LIMIT 1`,
      [memberId, groupId],
    );

    if (!joinRes.length)
      return res.status(404).json({ message: "Member not found in group" });

    const startDate = moment.tz(joinRes[0].joined_at, tz).format("YYYY-MM-DD");
    const today = moment.tz(tz).format("YYYY-MM-DD");

    const [result] = await db.query(
      `SELECT step_date, step_count FROM steps
       WHERE user_id=? AND step_date >= ? AND step_date <= ?
       ORDER BY step_date ASC`,
      [memberId, startDate, today],
    );

    const normalized = result.map((r) => ({
      step_date: moment.utc(r.step_date).format("YYYY-MM-DD"),
      step_count: Number(r.step_count) || 0,
    }));

    const startM = moment.tz(startDate, tz);
    const endM = moment.tz(today, tz);
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

    return res.json({ user_id: memberId, group_id: groupId, daily: out });
  } catch (err) {
    console.error("getGroupMemberSteps error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};
