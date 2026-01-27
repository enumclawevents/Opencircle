const express = require("express");
const cors = require("cors");
const eventsRouter = require("./routes/events");
const adminRouter = require("./routes/admin");

const app = express();

app.use(cors());
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

// Routes
app.get("/", (req, res) => {
  res.json({
    name: "OpenCircle API",
    status: "ok",
    endpoints: ["/events", "/events/:id", "/admin"]
  });
});

app.use("/events", eventsRouter);
app.use("/admin", requireAdmin, adminRouter);

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OpenCircle API running on port ${PORT}`);
});
