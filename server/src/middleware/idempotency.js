const IdempotencyKey = require("../models/IdempotencyKey");

/**
 * requireIdempotency Middleware
 * 
 * Inspects `Idempotency-Key` (or `X-Idempotency-Key`) header on mutating requests.
 * 
 * 1. If key was previously processed for this user:
 *    Returns the exact cached response (status & body) with header `X-Idempotent-Replay: true`.
 * 2. If key is new:
 *    Executes the request, intercepts `res.json()`, and persists the response in MongoDB.
 * 3. TTL: Keys expire automatically in 24 hours.
 */
function requireIdempotency(ttlHours = 24) {
  return async (req, res, next) => {
    // Only inspect mutating HTTP methods
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

    const idempotencyKey = (req.get("Idempotency-Key") || req.get("X-Idempotency-Key") || "").trim();

    // If client did not provide an idempotency key, proceed without caching
    if (!idempotencyKey) return next();

    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return res.status(400).json({ message: "Idempotency-Key must be between 8 and 128 characters" });
    }

    const userId = req.user?.id;
    if (!userId) return next();

    try {
      // Check for existing processed request
      const existing = await IdempotencyKey.findOne({
        key: idempotencyKey,
        userId
      }).lean();

      if (existing) {
        res.setHeader("X-Idempotent-Replay", "true");
        return res.status(existing.statusCode).json(existing.responseBody);
      }

      // Intercept res.json to capture response
      const originalJson = res.json.bind(res);

      res.json = (body) => {
        res.json = originalJson; // Restore original

        // Only store successful or 4xx responses, not 500 server crashes
        if (res.statusCode < 500) {
          IdempotencyKey.create({
            key: idempotencyKey,
            userId,
            endpoint: `${req.method} ${req.originalUrl || req.url}`,
            statusCode: res.statusCode,
            responseBody: body,
            expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000)
          }).catch((err) => {
            // E11000 duplicate key error means concurrent identical requests arrived
            if (err.code !== 11000) {
              console.error("[Idempotency] Failed to store idempotency record:", err.message);
            }
          });
        }

        return originalJson(body);
      };

      return next();
    } catch (error) {
      console.error("[Idempotency] Middleware error:", error.message);
      return next();
    }
  };
}

module.exports = { requireIdempotency };

