const jwt = require("jsonwebtoken");

module.exports = (req, res, next) => {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  const cleanedToken =
    token && typeof token === "string" ? token.trim() : token;
  if (
    !cleanedToken ||
    cleanedToken === "null" ||
    cleanedToken === "undefined"
  ) {
    return res.status(401).json({ message: "No token provided" });
  }
  try {
    const decoded = jwt.verify(cleanedToken, process.env.JWT_SECRET);
    req.user = { id: decoded.id };

    next();
  } catch (err) {
    console.log(" Invalid token:", err.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};
