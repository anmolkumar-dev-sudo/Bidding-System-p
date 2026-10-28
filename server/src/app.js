const express = require("express");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const path = require("path");
const authRoutes = require("./controllers/authRoutes");
const biddingRoutes = require("./controllers/biddingRoutes");
const { uploadDirectory } = require("./middleware/imageUpload");

function parseCookies(header = "") {
  const cookies = Object.create(null);
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (Object.hasOwn(cookies, name)) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      continue;
    }
  }
  return cookies;
}

const app = express();
// Render terminates HTTPS at its proxy and forwards traffic to this process.
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));
app.use((req, res, next) => {
  req.cookies = parseCookies(req.headers.cookie);
  next();
});
app.use(morgan("combined"));

// Credentialed CORS: allow only the configured browser frontend, never '*'.
app.use((req, res, next) => {
  const origin = req.get("origin");
  const renderOrigin = process.env.RENDER_EXTERNAL_HOSTNAME
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
    : null;
  const allowedOrigin = process.env.APP_ORIGIN || renderOrigin || "http://127.0.0.1:5500";
  const sameOrigin = origin === `${req.protocol}://${req.get("host")}`;
  if (origin === allowedOrigin || sameOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    // Cross-origin bid/create requests include an idempotency key, so it must
    // be allowed during the browser's OPTIONS preflight.
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-CSRF-Token,Idempotency-Key,X-Idempotency-Key");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    if (origin !== allowedOrigin && !sameOrigin) return res.sendStatus(403);
    return res.sendStatus(204);
  }
  return next();
});

// Browsers send Origin on unsafe cross-site requests; reject origins outside our frontend.
app.use((req, res, next) => {
  if (["GET", "HEAD"].includes(req.method)) return next();
  const origin = req.get("origin");
  const renderOrigin = process.env.RENDER_EXTERNAL_HOSTNAME
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
    : null;
  const allowedOrigin = process.env.APP_ORIGIN || renderOrigin || "http://127.0.0.1:5500";
  const sameOrigin = origin === `${req.protocol}://${req.get("host")}`;
  if (origin && origin !== allowedOrigin && !sameOrigin) {
    return res.status(403).json({ message: "Request origin is not allowed" });
  }
  return next();
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many authentication requests; try again later" }
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many login attempts; try again in 15 minutes" }
});

app.use("/api/auth", authLimiter);
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth", authRoutes);
app.use("/api/biddings", biddingRoutes);
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.use("/uploads", express.static(uploadDirectory, { maxAge: "1d", immutable: true }));
app.get("/verify-email", (req, res) => {
  res.sendFile(path.join(__dirname, "../../client/index.html"));
});
app.use(express.static(path.join(__dirname, "../../client")));

app.use((error, req, res, next) => {
  console.error("Request error:", error.message);
  return res.status(500).json({ message: "The server could not complete the request" });
});

module.exports = app;
