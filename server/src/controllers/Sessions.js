const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  csrfToken: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true, expires: 0 },
  revokedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model("Session", sessionSchema);

