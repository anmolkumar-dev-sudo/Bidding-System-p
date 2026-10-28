const jwt = require("jsonwebtoken");
const User = require("../controllers/Users");
const Session = require("../controllers/Sessions");
const { tokensMatch } = require("./securityTokens");

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ message: "Please log in" });

    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: "bidding-app",
      audience: "bidding-app-users"
    });
    const session = await Session.findOne({
      _id: payload.sessionId,
      user: payload.userId,
      revokedAt: null,
      expiresAt: { $gt: new Date() }
    }).select("+csrfToken");
    if (!session) return res.status(401).json({ message: "Session is expired or revoked" });

    const user = await User.findById(payload.userId).select("name email role isActive emailVerified");
    if (!user || !user.isActive || !user.emailVerified) {
      return res.status(401).json({ message: "Account is unavailable" });
    }
    req.authSession = session;
    req.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired session" });
  }
}

function requireCsrf(req, res, next) {
  if (!tokensMatch(req.get("x-csrf-token"), req.authSession?.csrfToken)) {
    return res.status(403).json({ message: "Missing or invalid CSRF token" });
  }
  return next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user?.role)) {
      return res.status(403).json({ message: "You do not have permission for this action" });
    }
    return next();
  };
}

function requireResourceOwner(findResource, getOwnerId) {
  return async (req, res, next) => {
    try {
      const resource = await findResource(req);
      if (!resource) return res.status(404).json({ message: "Resource not found" });
      const ownerId = getOwnerId(resource).toString();
      if (ownerId !== req.user.id && req.user.role !== "admin") {
        return res.status(403).json({ message: "You do not own this resource" });
      }
      req.authorizedResource = resource;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requireSelfOrAdmin(req, res, next) {
  if (req.user?.id !== req.params.userId && req.user?.role !== "admin") {
    return res.status(403).json({ message: "You may access only your own account" });
  }
  return next();
}

module.exports = { requireAuth, requireCsrf, requireRole, requireResourceOwner, requireSelfOrAdmin };

