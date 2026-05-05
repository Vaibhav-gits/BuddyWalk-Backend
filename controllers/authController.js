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

const findOrCreateGoogleUser = (
  name,
  email,
  country,
  timezone,
  photoUrl,
  callback,
) => {
  country = country || "N/A";
  timezone = timezone || "UTC";

  db.query("SELECT * FROM users WHERE email = ?", [email], (err, rows) => {
    if (err) return callback(err);

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
        vals.push(timezone);
      }

      if (updates.length === 0) return callback(null, user);

      vals.push(user.id);
      db.query(
        `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
        vals,
        (err2) => {
          if (err2) return callback(err2);

          if (needsCountry) user.country = country;
          if (needsTimezone) user.timezone = timezone;
          if (photoUrl) user.photo_url = photoUrl;

          return callback(null, user);
        },
      );
    } else {
      db.query(
        "INSERT INTO users (name, email, country, timezone, photo_url, goal_steps) VALUES (?, ?, ?, ?, ?, ?)",
        [name, email, country, timezone, photoUrl, 10000],
        (err2, result) => {
          if (err2) return callback(err2);
          return callback(null, {
            id: result.insertId,
            name,
            email,
            country,
            timezone,
            photo_url: photoUrl,
            gender: null,
            age: null,
            weight: null,
            goal_steps: 10000,
          });
        },
      );
    }
  });
};

exports.googleAuth = (req, res) => {
  const { idToken, timezone, photo_url } = req.body;

  if (!idToken)
    return res.status(400).json({ message: "ID token is required" });

  client
    .verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID })
    .then((ticket) => {
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

      findOrCreateGoogleUser(
        name,
        email,
        detectedCountry,
        timezone || "UTC",
        photoUrl,
        (err, user) => {
          if (err) {
            console.error("Google auth DB error:", err);
            return res.status(500).json({ message: "Database error" });
          }
          const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET);
          return res.json({
            message: "Google sign-in successful",
            token,
            user: formatUser(user),
          });
        },
      );
    })
    .catch((error) => {
      console.error("Google auth error:", error);
      return res
        .status(401)
        .json({ message: error?.message || "Invalid or expired Google token" });
    });
};

exports.completeProfile = (req, res) => {
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
  db.query(
    `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
    params,
    (err) => {
      if (err) {
        console.error("completeProfile update error:", err);
        return res.status(500).json({ message: "Server error" });
      }
      db.query(USER_SELECT, [userId], (err2, rows) => {
        if (err2) {
          console.error("completeProfile select error:", err2);
          return res.status(500).json({ message: "Server error" });
        }
        if (!rows.length)
          return res.status(404).json({ message: "User not found" });
        return res.json({
          message: "Profile updated",
          user: formatUser(rows[0]),
        });
      });
    },
  );
};

exports.updateProfile = (req, res) => {
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
  const { name, email, country, gender, age, timezone, goal_steps } = req.body;
  let { weight } = req.body;
  if (weight === undefined && req.body.weight_kg !== undefined)
    weight = req.body.weight_kg;

  const checkAndUpdate = () => {
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
    db.query(
      `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
      params,
      (err) => {
        if (err) {
          console.error("updateProfile error:", err);
          return res.status(500).json({ message: "Server error" });
        }
        db.query(USER_SELECT, [userId], (err2, rows) => {
          if (err2) {
            console.error("updateProfile select error:", err2);
            return res.status(500).json({ message: "Server error" });
          }
          if (!rows.length)
            return res.status(404).json({ message: "User not found" });
          return res.json({
            message: "Profile updated",
            user: formatUser(rows[0]),
          });
        });
      },
    );
  };

  if (email) {
    db.query(
      "SELECT id FROM users WHERE email = ? AND id <> ?",
      [email, userId],
      (err, existing) => {
        if (err) {
          console.error("updateProfile email check error:", err);
          return res.status(500).json({ message: "Server error" });
        }
        if (existing.length > 0)
          return res.status(400).json({ message: "Email already registered" });
        checkAndUpdate();
      },
    );
  } else {
    checkAndUpdate();
  }
};

exports.getProfile = (req, res) => {
  const auth = req.headers.authorization || "";
  const tokenStr = auth.replace(/^Bearer\s+/i, "");
  if (!tokenStr) return res.status(401).json({ message: "No token provided" });

  let payload;
  try {
    payload = jwt.verify(tokenStr, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }

  db.query(USER_SELECT, [payload.id], (err, rows) => {
    if (err) {
      console.error("getProfile error:", err);
      return res.status(500).json({ message: "Server error" });
    }
    if (!rows.length)
      return res.status(404).json({ message: "User not found" });
    return res.json({ user: formatUser(rows[0]) });
  });
};

exports.logout = (req, res) => {
  res.json({ message: "Logged out successfully" });
};

exports.deleteAccount = (req, res) => {
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

  db.getConnection((err, conn) => {
    if (err) return res.status(500).json({ message: "DB connection error" });

    conn.beginTransaction((txErr) => {
      if (txErr) {
        conn.release();
        return res.status(500).json({ message: "Transaction error" });
      }

      const rollback = (e) => {
        console.error("deleteAccount rollback:", e);
        conn.rollback(() => {
          conn.release();
        });
        return res.status(500).json({ message: "Failed to delete account" });
      };

      conn.query(
        "DELETE FROM device_tokens WHERE user_id = ?",
        [userId],
        (e) => {
          if (e) return rollback(e);

          conn.query("DELETE FROM steps WHERE user_id = ?", [userId], (e) => {
            if (e) return rollback(e);

            conn.query(
              "DELETE FROM challenge_participants WHERE user_id = ?",
              [userId],
              (e) => {
                if (e) return rollback(e);

                conn.query(
                  "DELETE FROM group_members WHERE user_id = ?",
                  [userId],
                  (e) => {
                    if (e) return rollback(e);

                    conn.query(
                      "DELETE FROM group_invitations WHERE invited_user_id = ? OR invited_by_user_id = ?",
                      [userId, userId],
                      (e) => {
                        if (e) return rollback(e);

                        conn.query(
                          "SELECT id FROM challenges WHERE created_by = ?",
                          [userId],
                          (e, challRows) => {
                            if (e) return rollback(e);

                            const challIds = challRows.map((r) => r.id);

                            const deleteGroups = () => {
                              conn.query(
                                "SELECT id FROM grp WHERE created_by = ?",
                                [userId],
                                (e, grpRows) => {
                                  if (e) return rollback(e);

                                  const grpIds = grpRows.map((r) => r.id);

                                  const deleteUser = () => {
                                    conn.query(
                                      "DELETE FROM users WHERE id = ?",
                                      [userId],
                                      (e) => {
                                        if (e) return rollback(e);

                                        conn.commit((commitErr) => {
                                          if (commitErr)
                                            return rollback(commitErr);
                                          conn.release();
                                          return res.json({
                                            message:
                                              "Account deleted successfully",
                                          });
                                        });
                                      },
                                    );
                                  };

                                  if (grpIds.length === 0) return deleteUser();

                                  conn.query(
                                    "DELETE FROM group_members WHERE group_id IN (?)",
                                    [grpIds],
                                    (e) => {
                                      if (e) return rollback(e);

                                      conn.query(
                                        "DELETE FROM group_invitations WHERE group_id IN (?)",
                                        [grpIds],
                                        (e) => {
                                          if (e) return rollback(e);

                                          conn.query(
                                            "SELECT id FROM challenges WHERE group_id IN (?)",
                                            [grpIds],
                                            (e, gcRows) => {
                                              if (e) return rollback(e);

                                              const gcIds = gcRows.map(
                                                (r) => r.id,
                                              );

                                              const deleteGrp = () => {
                                                conn.query(
                                                  "DELETE FROM grp WHERE id IN (?)",
                                                  [grpIds],
                                                  (e) => {
                                                    if (e) return rollback(e);
                                                    deleteUser();
                                                  },
                                                );
                                              };

                                              if (gcIds.length === 0)
                                                return deleteGrp();

                                              conn.query(
                                                "DELETE FROM challenge_participants WHERE challenge_id IN (?)",
                                                [gcIds],
                                                (e) => {
                                                  if (e) return rollback(e);
                                                  conn.query(
                                                    "DELETE FROM challenges WHERE id IN (?)",
                                                    [gcIds],
                                                    (e) => {
                                                      if (e) return rollback(e);
                                                      deleteGrp();
                                                    },
                                                  );
                                                },
                                              );
                                            },
                                          );
                                        },
                                      );
                                    },
                                  );
                                },
                              );
                            };

                            if (challIds.length === 0) return deleteGroups();

                            conn.query(
                              "DELETE FROM challenge_participants WHERE challenge_id IN (?)",
                              [challIds],
                              (e) => {
                                if (e) return rollback(e);
                                conn.query(
                                  "DELETE FROM challenges WHERE id IN (?)",
                                  [challIds],
                                  (e) => {
                                    if (e) return rollback(e);
                                    deleteGroups();
                                  },
                                );
                              },
                            );
                          },
                        );
                      },
                    );
                  },
                );
              },
            );
          });
        },
      );
    });
  });
};
