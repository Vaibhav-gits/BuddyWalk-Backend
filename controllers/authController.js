const db = require("../config/db");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const USER_SELECT =
  "SELECT id, name, email, country, gender, age, weight, goal_steps, timezone, photo_url FROM users WHERE id = ?";

const formatUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  country: row.country || "N/A",
  gender: row.gender || null,
  age: row.age || null,
  weight: row.weight || null,
  goal_steps: row.goal_steps || 10000,
  timezone: row.timezone || "UTC",
  photo_url: row.photo_url || null,
});

const findOrCreateGoogleUser = async (
  name,
  email,
  country = "N/A",
  timezone = "UTC",
  photoUrl = null,
) => {
  const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [email]);

  if (rows.length > 0) {
    const user = rows[0];

    const needsCountry =
      country &&
      country !== "N/A" &&
      (!user.country || user.country === "N/A" || user.country === "");
    const needsTimezone = !user.timezone || user.timezone === "UTC";

    const updates = [];
    const vals = [];

    if (photoUrl) {
      updates.push("photo_url = ?");
      vals.push(photoUrl);
    }
    if (needsCountry) {
      updates.push("country = ?");
      vals.push(country);
    }
    if (needsTimezone) {
      updates.push("timezone = ?");
      vals.push(timezone || "UTC");
    }

    if (updates.length === 0) return user;

    vals.push(user.id);
    await db.query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, vals);

    if (needsCountry) user.country = country;
    if (needsTimezone) user.timezone = timezone || "UTC";
    if (photoUrl) user.photo_url = photoUrl;

    return user;
  }

  const [result] = await db.query(
    "INSERT INTO users (name, email, country, timezone, photo_url, goal_steps) VALUES (?, ?, ?, ?, ?, ?)",
    [name, email, country || "N/A", timezone || "UTC", photoUrl, 10000],
  );

  return {
    id: result.insertId,
    name,
    email,
    country: country || "N/A",
    timezone: timezone || "UTC",
    photo_url: photoUrl,
    gender: null,
    age: null,
    weight: null,
    goal_steps: 10000,
  };
};

exports.googleAuth = async (req, res) => {
  try {
    const { idToken, timezone, photo_url } = req.body;

    if (!idToken)
      return res.status(400).json({ message: "ID token is required" });

    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { name, email } = payload;
    const photoUrl = photo_url || payload.picture || null;

    let detectedCountry = "N/A";
    try {
      const parts = (payload.locale || "").split(/[-_]/);
      const region = parts[1] || parts[0];
      if (region && region.length === 2) {
        try {
          detectedCountry =
            new Intl.DisplayNames(["en"], { type: "region" }).of(
              region.toUpperCase(),
            ) || "N/A";
        } catch {
          detectedCountry = region.toUpperCase();
        }
      }
    } catch {
      detectedCountry = "N/A";
    }

    if (!email)
      return res
        .status(400)
        .json({ message: "Could not retrieve email from Google" });

    const user = await findOrCreateGoogleUser(
      name,
      email,
      detectedCountry,
      timezone || "UTC",
      photoUrl,
    );
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET);

    return res.json({
      message: "Google sign-in successful",
      token,
      user: formatUser(user),
    });
  } catch (error) {
    console.error("Google auth error:", error);
    return res
      .status(401)
      .json({ message: error?.message || "Invalid or expired Google token" });
  }
};

exports.completeProfile = async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const tokenStr = auth.replace(/^Bearer\s+/i, "");
    if (!tokenStr)
      return res.status(401).json({ message: "No token provided" });

    let payload;
    try {
      payload = jwt.verify(tokenStr, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "Invalid token" });
    }

    const userId = payload.id;
    const { gender, age, country, timezone, goal_steps } = req.body;
    let { weight } = req.body;
    if (weight === undefined && req.body.weight_kg !== undefined)
      weight = req.body.weight_kg;

    const fields = [];
    const params = [];

    if (gender !== undefined) {
      fields.push("gender = ?");
      params.push(gender);
    }
    if (age !== undefined) {
      fields.push("age = ?");
      params.push(age || null);
    }
    if (weight !== undefined) {
      fields.push("weight = ?");
      params.push(weight || null);
    }
    if (country !== undefined) {
      fields.push("country = ?");
      params.push(country);
    }
    if (timezone !== undefined) {
      fields.push("timezone = ?");
      params.push(timezone || "UTC");
    }
    if (goal_steps !== undefined) {
      fields.push("goal_steps = ?");
      params.push(goal_steps || 10000);
    }

    if (fields.length === 0)
      return res
        .status(400)
        .json({ message: "No profile fields provided to update" });

    params.push(userId);
    await db.query(
      `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
      params,
    );

    const [rows] = await db.query(USER_SELECT, [userId]);
    if (!rows.length)
      return res.status(404).json({ message: "User not found" });

    return res.json({ message: "Profile updated", user: formatUser(rows[0]) });
  } catch (error) {
    console.error("completeProfile error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const tokenStr = auth.replace(/^Bearer\s+/i, "");
    if (!tokenStr)
      return res.status(401).json({ message: "No token provided" });

    let payload;
    try {
      payload = jwt.verify(tokenStr, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "Invalid token" });
    }

    const userId = payload.id;
    const { name, email, country, gender, age, timezone, goal_steps } =
      req.body;
    let { weight } = req.body;
    if (weight === undefined && req.body.weight_kg !== undefined)
      weight = req.body.weight_kg;

    if (email) {
      const [existing] = await db.query(
        "SELECT id FROM users WHERE email = ? AND id <> ?",
        [email, userId],
      );
      if (existing.length > 0)
        return res.status(400).json({ message: "Email already registered" });
    }

    const fields = [];
    const params = [];

    if (name !== undefined) {
      fields.push("name = ?");
      params.push(name);
    }
    if (email !== undefined) {
      fields.push("email = ?");
      params.push(email);
    }
    if (country !== undefined) {
      fields.push("country = ?");
      params.push(country);
    }
    if (gender !== undefined) {
      fields.push("gender = ?");
      params.push(gender);
    }
    if (age !== undefined) {
      fields.push("age = ?");
      params.push(age);
    }
    if (weight !== undefined) {
      fields.push("weight = ?");
      params.push(weight);
    }
    if (timezone !== undefined) {
      fields.push("timezone = ?");
      params.push(timezone || "UTC");
    }
    if (goal_steps !== undefined) {
      fields.push("goal_steps = ?");
      params.push(goal_steps || 10000);
    }

    if (fields.length === 0)
      return res.status(400).json({ message: "No fields provided to update" });

    params.push(userId);
    await db.query(
      `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
      params,
    );

    const [rows] = await db.query(USER_SELECT, [userId]);
    if (!rows.length)
      return res.status(404).json({ message: "User not found" });

    return res.json({ message: "Profile updated", user: formatUser(rows[0]) });
  } catch (error) {
    console.error("updateProfile error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getProfile = async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const tokenStr = auth.replace(/^Bearer\s+/i, "");
    if (!tokenStr)
      return res.status(401).json({ message: "No token provided" });

    let payload;
    try {
      payload = jwt.verify(tokenStr, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "Invalid token" });
    }

    const [rows] = await db.query(USER_SELECT, [payload.id]);
    if (!rows.length)
      return res.status(404).json({ message: "User not found" });

    return res.json({ user: formatUser(rows[0]) });
  } catch (error) {
    console.error("getProfile error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.logout = (req, res) => {
  res.json({ message: "Logged out successfully" });
};

exports.deleteAccount = async (req, res) => {
  const auth = req.headers.authorization || "";
  const tokenStr = auth.replace(/^Bearer\s+/i, "");
  if (!tokenStr) return res.status(401).json({ message: "No token provided" });

  let payload;
  try {
    payload = jwt.verify(tokenStr, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }

  const userId = payload.id;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    await conn.query("DELETE FROM device_tokens WHERE user_id = ?", [userId]);
    await conn.query("DELETE FROM steps WHERE user_id = ?", [userId]);
    await conn.query("DELETE FROM challenge_participants WHERE user_id = ?", [
      userId,
    ]);
    await conn.query("DELETE FROM group_members WHERE user_id = ?", [userId]);
    await conn.query(
      "DELETE FROM group_invitations WHERE invited_user_id = ? OR invited_by_user_id = ?",
      [userId, userId],
    );

    const [challRows] = await conn.query(
      "SELECT id FROM challenges WHERE created_by = ?",
      [userId],
    );
    const challIds = challRows.map((r) => r.id);
    if (challIds.length > 0) {
      await conn.query(
        "DELETE FROM challenge_participants WHERE challenge_id IN (?)",
        [challIds],
      );
      await conn.query("DELETE FROM challenges WHERE id IN (?)", [challIds]);
    }

    const [grpRows] = await conn.query(
      "SELECT id FROM grp WHERE created_by = ?",
      [userId],
    );
    const grpIds = grpRows.map((r) => r.id);
    if (grpIds.length > 0) {
      await conn.query("DELETE FROM group_members WHERE group_id IN (?)", [
        grpIds,
      ]);
      await conn.query("DELETE FROM group_invitations WHERE group_id IN (?)", [
        grpIds,
      ]);

      const [gcRows] = await conn.query(
        "SELECT id FROM challenges WHERE group_id IN (?)",
        [grpIds],
      );
      const gcIds = gcRows.map((r) => r.id);
      if (gcIds.length > 0) {
        await conn.query(
          "DELETE FROM challenge_participants WHERE challenge_id IN (?)",
          [gcIds],
        );
        await conn.query("DELETE FROM challenges WHERE id IN (?)", [gcIds]);
      }

      await conn.query("DELETE FROM grp WHERE id IN (?)", [grpIds]);
    }

    await conn.query("DELETE FROM users WHERE id = ?", [userId]);
    await conn.commit();

    return res.json({ message: "Account deleted successfully" });
  } catch (err) {
    console.error("deleteAccount rollback:", err);
    await conn.rollback();
    return res.status(500).json({ message: "Failed to delete account" });
  } finally {
    conn.release();
  }
};
