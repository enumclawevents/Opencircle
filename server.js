const express = require("express");
const cors = require("cors");
const eventsRouter = require("./routes/events");
const adminRouter = require("./routes/admin");

const app = express();

// Allows other websites/apps to call this API
app.use(cors());

// Lets the API understand JSON bodies in POST/PUT requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Simple Admin Password (Basic Auth) ---
const ADMIN_USER = "admin";
const ADMIN_PASS = "opencircle";

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Basic" || !token) {
    res.setHeader("WWW-Authenticate", 'Basic realm="OpenCircle Admin"');
    return res.status(401).send("Authentication required.");
  }

  const decoded = Buffer.from(token, "base64").toString("utf8");
  const [user, pass] = decoded.split(":");

  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();

  res.setHeader("WWW-Authenticate", 'Basic realm="OpenCircle Admin"');
  return res.status(401).send("Invalid credentials.");
}

// Admin routes (protected)
app.use("/admin", requireAdmin, adminRouter);

// A simple test route so you can confirm the API is running
app.get("/", (req, res) => {
  res.json({
    name: "OpenCircle API",
    status: "ok",
    endpoints: ["/events", "/events/:id", "/admin"],
  });
});

// Public events endpoints
app.use("/events", eventsRouter);

// Start the server on port 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OpenCircle API running on port ${PORT}`);
});
