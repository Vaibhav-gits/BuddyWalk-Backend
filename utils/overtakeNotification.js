const db = require("../config/db");
const { sendPushNotification } = require("./sendPushNotification");

const STEP_GAP_THRESHOLD = 200;
const COOLDOWN_MINUTES = 30;

async function processOvertakeNotifications(groupId) {
  try {
    const [members] = await db.query(
      `SELECT gm.user_id, gm.previous_rank, gm.current_rank,
              gm.last_overtake_notified_at,
              s.steps,
              u.name,
              gns.notify_overtake_me,
              gns.notify_i_overtake
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       LEFT JOIN steps s ON s.user_id = gm.user_id AND s.date = CURDATE()
       LEFT JOIN group_notification_settings gns 
              ON gns.user_id = gm.user_id AND gns.group_id = gm.group_id
       WHERE gm.group_id = ?
       ORDER BY COALESCE(s.steps, 0) DESC`,
      [groupId],
    );

    if (!members.length) return;

    const newRanked = members.map((m, i) => ({
      ...m,
      newRank: i + 1,
      steps: Number(m.steps || 0),
    }));

    const overtakeEvents = [];

    for (const member of newRanked) {
      const prevRank = Number(member.previous_rank || 0);
      const newRank = member.newRank;

      if (prevRank > 0 && newRank < prevRank) {
        for (const other of newRanked) {
          const otherPrevRank = Number(other.previous_rank || 0);
          if (
            other.user_id !== member.user_id &&
            otherPrevRank > 0 &&
            otherPrevRank <= prevRank &&
            other.newRank >= newRank
          ) {
            const stepDiff = member.steps - other.steps;
            if (stepDiff >= STEP_GAP_THRESHOLD) {
              overtakeEvents.push({
                overtaker: member,
                overtaken: other,
                stepDiff,
              });
            }
          }
        }
      }
    }

    if (!overtakeEvents.length) {
      await updateRanks(newRanked, groupId);
      return;
    }

    const byOvertaken = {};
    for (const event of overtakeEvents) {
      const uid = event.overtaken.user_id;
      if (!byOvertaken[uid]) byOvertaken[uid] = [];
      byOvertaken[uid].push(event);
    }

    for (const [userId, events] of Object.entries(byOvertaken)) {
      const overtakenUser = events[0].overtaken;

      if (!overtakenUser.notify_overtake_me) continue;

      if (!isCooldownPassed(overtakenUser.last_overtake_notified_at)) continue;

      await db.query(
        `UPDATE group_members 
         SET last_overtake_notified_at = NOW()
         WHERE user_id = ? AND group_id = ?`,
        [userId, groupId],
      );

      let title, body;
      if (events.length === 1) {
        const e = events[0];
        title = "You got overtaken!";
        body = `${e.overtaker.name} overtook you by ${e.stepDiff} steps! Walk more to regain your rank.`;
      } else {
        title = "You got overtaken!";
        body = `${events.length} members overtook you! Time to walk more.`;
      }

      await sendPushNotification(userId, title, body);

      await logNotification(userId, groupId, "overtake_received", events[0]);
    }

    const byOvertaker = {};
    for (const event of overtakeEvents) {
      const uid = event.overtaker.user_id;
      if (!byOvertaker[uid]) byOvertaker[uid] = [];
      byOvertaker[uid].push(event);
    }

    for (const [userId, events] of Object.entries(byOvertaker)) {
      const overtakerUser = events[0].overtaker;

      if (!overtakerUser.notify_i_overtake) continue;
      if (!isCooldownPassed(overtakerUser.last_overtake_notified_at)) continue;

      await db.query(
        `UPDATE group_members 
         SET last_overtake_notified_at = NOW()
         WHERE user_id = ? AND group_id = ?`,
        [userId, groupId],
      );

      let title, body;
      if (events.length === 1) {
        title = "You overtook someone!";
        body = `You overtook ${events[0].overtaken.name} by ${events[0].stepDiff} steps! Keep going!`;
      } else {
        title = "You are on fire!";
        body = `You overtook ${events.length} members! Keep walking!`;
      }

      await sendPushNotification(userId, title, body);
    }

    await updateRanks(newRanked, groupId);
  } catch (err) {
    console.error("processOvertakeNotifications error:", err?.message);
  }
}

function isCooldownPassed(lastNotifiedAt) {
  if (!lastNotifiedAt) return true;
  const diff = Date.now() - new Date(lastNotifiedAt).getTime();
  return diff >= COOLDOWN_MINUTES * 60 * 1000;
}

async function updateRanks(rankedMembers, groupId) {
  for (const m of rankedMembers) {
    await db.query(
      `UPDATE group_members 
       SET previous_rank = current_rank,
           current_rank = ?
       WHERE user_id = ? AND group_id = ?`,
      [m.newRank, m.user_id, groupId],
    );
  }
}

async function logNotification(userId, groupId, type, event) {
  try {
    await db.query(
      `INSERT INTO notification_log 
       (user_id, group_id, notification_type, overtaker_id, overtaken_id, step_difference, sent_date)
       VALUES (?, ?, ?, ?, ?, ?, CURDATE())`,
      [
        userId,
        groupId,
        type,
        event.overtaker.user_id,
        event.overtaken.user_id,
        event.stepDiff,
      ],
    );
  } catch (err) {
    console.error("logNotification error:", err?.message);
  }
}

module.exports = { processOvertakeNotifications };
