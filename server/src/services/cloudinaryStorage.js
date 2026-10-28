const crypto = require("node:crypto");
const fs = require("node:fs/promises");

function getCloudinaryConfig() {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) return null;
  return { cloudName: CLOUDINARY_CLOUD_NAME, apiKey: CLOUDINARY_API_KEY, apiSecret: CLOUDINARY_API_SECRET };
}

function signParameters(parameters, apiSecret) {
  const payload = Object.keys(parameters)
    .sort()
    .map((key) => `${key}=${parameters[key]}`)
    .join("&");
  return crypto.createHash("sha1").update(`${payload}${apiSecret}`).digest("hex");
}

async function cloudinaryRequest(action, parameters, file) {
  const config = getCloudinaryConfig();
  if (!config) throw new Error("Cloudinary image storage is not configured");

  const timestamp = Math.floor(Date.now() / 1000);
  const signedParameters = { ...parameters, timestamp };
  const form = new FormData();
  for (const [key, value] of Object.entries(signedParameters)) form.append(key, String(value));
  form.append("api_key", config.apiKey);
  form.append("signature", signParameters(signedParameters, config.apiSecret));

  if (file) {
    const bytes = await fs.readFile(file.path);
    form.append("file", new Blob([bytes], { type: file.mimetype }), file.originalname);
  }

  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/image/${action}`;
  const response = await fetch(endpoint, { method: "POST", body: form });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result.error?.message || `Cloudinary request failed (${response.status})`;
    throw new Error(message);
  }
  return result;
}

async function uploadImage(file) {
  const folder = process.env.CLOUDINARY_FOLDER || "bidroom/listings";
  const publicId = file.filename.replace(/\.[^.]+$/, "");
  const result = await cloudinaryRequest("upload", { folder, public_id: publicId }, file);
  if (!result.secure_url || !result.public_id) throw new Error("Cloudinary returned an incomplete upload result");
  return { url: result.secure_url, cloudinaryId: result.public_id };
}

async function deleteImage(publicId) {
  if (!publicId || !getCloudinaryConfig()) return;
  const result = await cloudinaryRequest("destroy", { public_id: publicId, invalidate: true });
  if (! ["ok", "not found"].includes(result.result)) {
    throw new Error(`Cloudinary could not delete image ${publicId}`);
  }
}

async function deleteImages(publicIds = []) {
  const results = await Promise.allSettled(publicIds.filter(Boolean).map(deleteImage));
  for (const result of results) {
    if (result.status === "rejected") console.error("Cloudinary cleanup failed:", result.reason.message);
  }
}

module.exports = { getCloudinaryConfig, uploadImage, deleteImage, deleteImages };
