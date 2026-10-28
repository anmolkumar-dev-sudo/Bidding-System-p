const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const multer = require("multer");
const { deleteImages } = require("../services/cloudinaryStorage");

const uploadDirectory = path.resolve(__dirname, "../../uploads");
const allowedTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
]);

fs.mkdirSync(uploadDirectory, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadDirectory),
  filename: (_req, file, callback) => {
    const extension = allowedTypes.get(file.mimetype);
    callback(null, `${crypto.randomUUID()}${extension}`);
  }
});

const receiveImages = multer({
  storage,
  limits: {
    files: 3,
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_req, file, callback) => {
    if (!allowedTypes.has(file.mimetype)) {
      return callback(new Error("Choose JPG, PNG, or WebP image files."));
    }
    return callback(null, true);
  }
}).array("images", 3);

function uploadImages(req, res, next) {
  receiveImages(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: "Each image must be 5 MB or smaller." });
      }
      if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({ message: "Choose no more than 3 images." });
      }
      return res.status(400).json({ message: "The selected images could not be uploaded." });
    }

    return res.status(400).json({ message: error.message || "The selected images could not be uploaded." });
  });
}

async function removeUploadedFiles(files = []) {
  await Promise.all(
    files.map((file) => fs.promises.rm(file.path, { force: true }).catch(() => {}))
  );
}

async function removeStoredImages(images = []) {
  const localRemovals = images.map((image) => {
      const key = image.storageKey;
      if (typeof key !== "string" || !/^[\da-f-]{36}\.(jpg|png|webp)$/i.test(key)) return Promise.resolve();
      return fs.promises.rm(path.join(uploadDirectory, key), { force: true }).catch(() => {});
  });
  await Promise.all(localRemovals);
  await deleteImages(images.map((image) => image.cloudinaryId));
}

async function hasValidImageSignature(file) {
  const handle = await fs.promises.open(file.path, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);

    if (file.mimetype === "image/jpeg") {
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (file.mimetype === "image/png") {
      return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    if (file.mimetype === "image/webp") {
      return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    }
    return false;
  } finally {
    await handle.close();
  }
}

module.exports = { uploadDirectory, uploadImages, removeUploadedFiles, removeStoredImages, hasValidImageSignature };
