# Deploy Bidroom on Render

This project uses one Render Web Service for the Express API and client, a Render Key Value service for Redis caching, MongoDB Atlas for application data, and Cloudinary for uploaded listing photos.

## Before deploying

1. Put the project in a GitHub repository. The root `.gitignore` excludes local environment files, dependencies, and `server/uploads`.
2. In Cloudinary, copy the cloud name, API key, and API secret from the account dashboard. Keep the API secret private.
3. In MongoDB Atlas, confirm the database user works and that Atlas Network Access allows connections from Render. Prefer allowing Render's published outbound IP ranges for the service's region.
4. If using account verification and password reset, have valid Resend settings ready (`RESEND_API_KEY` and `EMAIL_FROM`).

## Create the Render services

1. In Render, create a **Blueprint** and connect the GitHub repository containing this project.
2. Render reads `render.yaml` and proposes `bidroom-app` (web) and `bidroom-cache` (Redis-compatible Key Value). Review the plan and create them.
3. When prompted for secret values, enter `MONGO_URI`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `RESEND_API_KEY`, and `EMAIL_FROM`. Never paste these values into `render.yaml` or GitHub.
4. Wait for the web service deploy to finish. Its health check is `/api/health`; open the service's `onrender.com` URL to load the app.

`REDIS_URL` is wired from the Render Key Value service by the Blueprint. Redis is only a cache here; if its free instance is restarted or its cache is cleared, MongoDB remains the source of truth and the cache repopulates.

## Move existing local uploads before deploying

Photos uploaded before Cloudinary was configured may still point to files in `server/uploads`, which Render will not retain. Before deploying, put the Cloudinary credentials and Atlas `MONGO_URI` in your local `server/.env`, then run this from PowerShell:

```powershell
cd "C:\COMPETITIVE PROGRAMING\server"
npm run migrate:images
```

The migration uploads only images with a local `storageKey`, updates their MongoDB URLs after successful uploads, and removes local files only after MongoDB saves the new Cloudinary URLs. It skips listings without local files. Review the migration summary before pushing the project.

Demo seed photos that already use external URLs do not need migration.

## After deployment

- Open `/api/health` on the Render URL; it should return `{"status":"ok"}`.
- Create a test listing with two or three photos and confirm its photos load after a redeploy.
- Confirm the server log reports Redis connected. If Redis is temporarily unavailable, the app can continue without caching.
- Verify email links use the deployed domain and that your Resend sender is accepted.

Render's free web service can sleep when idle and its local filesystem is ephemeral. Cloudinary keeps uploaded images outside that filesystem; MongoDB keeps listing data. Free Render services are intended for testing/hobby use and have availability and usage limits.
