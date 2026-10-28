const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("./Users");
const Session = require("./Sessions");
const { makeToken, hashToken } = require("../middleware/securityTokens");
const { sendAccountEmail } = require("./emailService");

const TOKEN_MINUTES = 30;
const COOKIE_NAME = "token";
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: TOKEN_MINUTES * 60 * 1000
};

function accountLink(path, token) {
  const renderUrl = process.env.RENDER_EXTERNAL_HOSTNAME
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
    : null;
  const localUrl = `${process.env.APP_ORIGIN || "http://127.0.0.1:5500"}/client/index.html`;
  const appUrl = (process.env.FRONTEND_URL || renderUrl || localUrl).replace(/\/$/, "");
  const route = path.replace(/^\//, "");
  return `${appUrl}#/${route}?token=${encodeURIComponent(token)}`;
}

function tokenInDevelopment(token) {
  return ["development", "test"].includes(process.env.NODE_ENV) ? token : undefined;
}

function emailIsValid(email) {
  return typeof email === "string" && email.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function passwordIsValid(password) {
  return typeof password === "string" && password.length >= 12 && password.length <= 128;
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: undefined });
}

async function sendOneTimeEmail({ user, rawToken, route, subject, purpose }) {
  const link = accountLink(route, rawToken);
  const delivered = await sendAccountEmail({
    to: user.email,
    subject,
    text: `Use this one-time link to ${purpose}: ${link}\nIt expires in 30 minutes.`
  });
  return delivered ? undefined : tokenInDevelopment(rawToken);
}

async function registerUser(req, res) {
  try {
    const { name, email, password } = req.body;
    if (typeof name !== "string" || !emailIsValid(email) || !name.trim() || !passwordIsValid(password)) {
      return res.status(400).json({ message: "Name, email, and a 12–128 character password are required" });
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (await User.exists({ email: normalizedEmail })) {
      return res.status(409).json({ message: "This email is already registered" });
    }

    const rawToken = makeToken();
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: await bcrypt.hash(password, 12),
      emailVerificationTokenHash: hashToken(rawToken),
      emailVerificationExpires: new Date(Date.now() + 30 * 60 * 1000)
    });
    const developmentToken = await sendOneTimeEmail({
      user, rawToken, route: "/verify-email", subject: "Verify your email", purpose: "verify your email"
    });
    return res.status(201).json({
      message: "Account created. Verify your email before logging in.",
      ...(developmentToken ? { verificationToken: developmentToken } : {})
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: "This email is already registered" });
    console.error("Registration error:", error.message);
    return res.status(500).json({ message: "Could not register user" });
  }
}

async function verifyEmail(req, res) {
  const { token } = req.body;
  if (typeof token !== "string") return res.status(400).json({ message: "Verification token is required" });
  const user = await User.findOne({
    emailVerificationTokenHash: hashToken(token),
    emailVerificationExpires: { $gt: new Date() }
  }).select("+emailVerificationTokenHash +emailVerificationExpires");
  if (!user) return res.status(400).json({ message: "Verification token is invalid or expired" });
  user.emailVerified = true;
  user.emailVerificationTokenHash = undefined;
  user.emailVerificationExpires = undefined;
  await user.save();
  return res.json({ message: "Email verified. You can now log in." });
}

async function resendVerification(req, res) {
  const generic = { message: "If an unverified account exists, a new verification token was sent" };
  const email = req.body.email;
  if (!emailIsValid(email)) return res.status(400).json({ message: "Email is required" });
  const user = await User.findOne({ email: email.trim().toLowerCase(), emailVerified: { $ne: true }, isActive: true });
  if (!user) return res.status(202).json(generic);
  const rawToken = makeToken();
  user.emailVerificationTokenHash = hashToken(rawToken);
  user.emailVerificationExpires = new Date(Date.now() + 30 * 60 * 1000);
  await user.save();
  try {
    const developmentToken = await sendOneTimeEmail({
      user, rawToken, route: "/verify-email", subject: "Verify your email", purpose: "verify your email"
    });
    return res.status(202).json({ ...generic, ...(developmentToken ? { verificationToken: developmentToken } : {}) });
  } catch (error) {
    console.error("Verification email delivery failed");
    return res.status(202).json(generic);
  }
}

async function loginUser(req, res) {
  try {
    const { email, password } = req.body;
    if (!emailIsValid(email) || typeof password !== "string" || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }
    const user = await User.findOne({ email: email.trim().toLowerCase() }).select("+password");
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    if (!user.isActive) return res.status(403).json({ message: "This account is disabled" });
    if (!user.emailVerified) return res.status(403).json({ message: "Verify your email before logging in" });

    const csrfToken = makeToken();
    const expiresAt = new Date(Date.now() + TOKEN_MINUTES * 60 * 1000);
    const session = await Session.create({ user: user._id, csrfToken, expiresAt });
    const token = jwt.sign(
      { userId: user._id.toString(), sessionId: session._id.toString() },
      process.env.JWT_SECRET,
      { expiresIn: `${TOKEN_MINUTES}m`, issuer: "bidding-app", audience: "bidding-app-users" }
    );
    res.cookie(COOKIE_NAME, token, cookieOptions);
    return res.json({
      message: "Login successful",
      csrfToken,
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch (error) {
    console.error("Login error:", error.message);
    return res.status(500).json({ message: "Could not log in" });
  }
}

async function logoutUser(req, res) {
  await Session.updateOne({ _id: req.authSession.id }, { $set: { revokedAt: new Date() } });
  clearAuthCookie(res);
  return res.json({ message: "Logged out" });
}

async function requestPasswordReset(req, res) {
  const generic = { message: "If that account exists, a reset link will be sent" };
  const email = req.body.email;
  if (!emailIsValid(email)) return res.status(400).json({ message: "Email is required" });
  const user = await User.findOne({ email: email.trim().toLowerCase(), isActive: true });
  if (!user) return res.status(202).json(generic);
  const rawToken = makeToken();
  user.passwordResetTokenHash = hashToken(rawToken);
  user.passwordResetExpires = new Date(Date.now() + 30 * 60 * 1000);
  await user.save();
  try {
    const developmentToken = await sendOneTimeEmail({
      user, rawToken, route: "/reset-password", subject: "Reset your password", purpose: "reset your password"
    });
    if (developmentToken) {
      user.passwordResetTokenHash = undefined;
      user.passwordResetExpires = undefined;
      await user.save();
      return res.status(503).json({ message: "Password reset email is not configured. Add RESEND_API_KEY and EMAIL_FROM to server/.env, then restart the server." });
    }
    return res.status(202).json(generic);
  } catch (error) {
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpires = undefined;
    await user.save();
    console.error("Password reset email delivery failed:", error.message);
    return res.status(502).json({ message: "Password reset email could not be sent. Check your Resend API key and sender address." });
  }
}

async function resetPassword(req, res) {
  const { token, newPassword } = req.body;
  if (typeof token !== "string" || !passwordIsValid(newPassword)) {
    return res.status(400).json({ message: "Token and a 12–128 character new password are required" });
  }
  const user = await User.findOne({
    passwordResetTokenHash: hashToken(token),
    passwordResetExpires: { $gt: new Date() }
  }).select("+passwordResetTokenHash +passwordResetExpires");
  if (!user) return res.status(400).json({ message: "Reset token is invalid or expired" });
  user.password = await bcrypt.hash(newPassword, 12);
  user.passwordChangedAt = new Date();
  user.passwordResetTokenHash = undefined;
  user.passwordResetExpires = undefined;
  await user.save();
  await Session.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  clearAuthCookie(res);
  return res.json({ message: "Password reset. Please log in again." });
}

async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  if (typeof currentPassword !== "string" || !passwordIsValid(newPassword)) {
    return res.status(400).json({ message: "Current password and a 12–128 character new password are required" });
  }
  const user = await User.findById(req.user.id).select("+password");
  if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
    return res.status(401).json({ message: "Current password is incorrect" });
  }
  user.password = await bcrypt.hash(newPassword, 12);
  user.passwordChangedAt = new Date();
  await user.save();
  await Session.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  clearAuthCookie(res);
  return res.json({ message: "Password changed. Please log in again." });
}

async function setAccountStatus(req, res) {
  const { isActive } = req.body;
  if (typeof isActive !== "boolean") return res.status(400).json({ message: "isActive must be true or false" });
  const user = await User.findByIdAndUpdate(req.params.userId, { isActive }, { new: true }).select("name email role isActive");
  if (!user) return res.status(404).json({ message: "User not found" });
  if (!isActive) await Session.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  return res.json({ user });
}

async function setUserRole(req, res) {
  const { role } = req.body;
  if (!["buyer", "seller", "admin"].includes(role)) {
    return res.status(400).json({ message: "role must be buyer, seller, or admin" });
  }
  const user = await User.findByIdAndUpdate(req.params.userId, { role }, { new: true }).select("name email role");
  if (!user) return res.status(404).json({ message: "User not found" });
  return res.json({ user });
}

async function getUserProfile(req, res) {
  const user = await User.findById(req.params.userId).select("name email role emailVerified isActive");
  if (!user) return res.status(404).json({ message: "User not found" });
  return res.json({ user });
}

module.exports = {
  registerUser, verifyEmail, resendVerification, loginUser, logoutUser,
  requestPasswordReset, resetPassword, changePassword, setAccountStatus,
  setUserRole, getUserProfile
};




