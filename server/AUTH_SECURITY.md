# Authentication and security: setup and code walkthrough

## Environment

Your existing `server/.env` can keep its current `MONGO_URI` and `JWT_SECRET`. Copy the names from `.env.example` when you are ready to configure email and the frontend origin. Never commit `.env` or share its values. Production requires `NODE_ENV=production`, a random `JWT_SECRET` of 32 or more characters, `APP_ORIGIN`, `RESEND_API_KEY`, and `EMAIL_FROM`. Set `ADMIN_EMAIL` to the email of a verified account to bootstrap the first admin; the server assigns that role at startup. Keep this environment variable private.

Email is sent through Resend's HTTPS API. In development, with no email credentials configured, register and password-reset responses return a one-time token so you can exercise the flow with Postman. The token is not returned in production. For production, verify the sender domain with your email provider before sending.

## Routes and how to use them

- `POST /api/auth/register` body: `{ "name": "Sam", "email": "sam@example.com", "password": "long passphrase here" }`. Passwords must be 12–128 characters. A new account has the buyer role and cannot log in until verified.
- `POST /api/auth/verify-email` body: `{ "token": "the verificationToken from development response" }`.
- `POST /api/auth/resend-verification` body: `{ "email": "sam@example.com" }`.
- `POST /api/auth/login` body: `{ "email": "sam@example.com", "password": "long passphrase here" }`. The response contains `csrfToken`; the JWT is in an HttpOnly cookie.
- `GET /api/auth/me` shows the signed-in account. `GET /api/auth/csrf` gives the current CSRF token again after a page refresh.
- For `POST /api/auth/logout`, `POST /api/auth/change-password`, and admin `PATCH` requests, send the cookie and `X-CSRF-Token: <csrfToken>`.
- `POST /api/auth/forgot-password` body: `{ "email": "sam@example.com" }`; use its development `resetToken` with `POST /api/auth/reset-password` body `{ "token": "...", "newPassword": "another long passphrase" }`.
- `GET /api/auth/users/:userId` lets a user read their own profile. An admin can read any profile. `PATCH /api/auth/users/:userId/status` disables/enables an account. `PATCH /api/auth/users/:userId/role` assigns `buyer`, `seller`, or `admin`; the first admin is bootstrapped from the verified `ADMIN_EMAIL` setting.

When calling the backend from a browser frontend, use `fetch(url, { credentials: "include" })` so the browser sends the cookie. For protected writes, also set the `X-CSRF-Token` header. `APP_ORIGIN` must exactly match the frontend origin (scheme, host, and port). Local Postman requests with no `Origin` header are permitted.

## Why the code is arranged this way

### `controllers/Users.js`

- `name`, normalized `email`, and bcrypt `password` are the account's core fields. `unique: true` asks MongoDB/Mongoose to enforce one account per email; the controller still handles a duplicate-key race.
- `select: false` on password and one-time-token hashes means ordinary user lookups omit those sensitive fields. Login and token-consuming handlers explicitly select the field they need.
- `role` is restricted to buyer/seller/admin and defaults to buyer. Registration never accepts a role from its request body.
- `isActive` allows administrators to disable an account. `emailVerified` blocks login until verification.
- The verification/reset hash and expiry fields hold only SHA-256 hashes of the random one-time tokens, plus their expiry timestamps.
- `passwordChangedAt` records when credentials changed. Sessions are revoked directly in the current implementation; this timestamp is also useful for auditing and future token policies.
- `timestamps: true` lets Mongoose maintain `createdAt` and `updatedAt`.

### `controllers/Sessions.js`

- A session row ties a user to one browser login. It stores a CSRF secret, an expiry, and `revokedAt`.
- `expires: 0` creates a MongoDB TTL index. MongoDB deletes expired rows eventually; `requireAuth` checks the date itself so authorization does not depend on cleanup timing.
- `revokedAt` is set on logout, password change/reset, and account disablement. A copied JWT then fails because its session row is revoked.

### `middleware/securityTokens.js`

- `makeToken()` uses Node's cryptographic random generator for 32 random bytes, encoded as hex. Verification/reset tokens and CSRF tokens are hard to guess.
- `hashToken()` stores a one-way SHA-256 digest instead of the raw email/reset token.
- `tokensMatch()` checks strings with `timingSafeEqual`; it first checks equal byte lengths because that function requires equal-length buffers.

### `controllers/emailService.js`

- It reads `RESEND_API_KEY` and `EMAIL_FROM` from the environment, never from the request.
- If those values are absent locally, it returns `false`; the controller may return a development-only token. In production it throws so the app cannot silently pretend it sent an email.
- `fetch()` sends the email to Resend over HTTPS with a bearer API key and JSON message fields. The provider's error body is not sent to the client.

### `controllers/authController.js`

- Imports load bcrypt, JWT, the User and Session models, token helpers, and email delivery.
- `TOKEN_MINUTES`, `COOKIE_NAME`, and `cookieOptions` keep JWT expiration and cookie lifetime aligned at 30 minutes. `httpOnly` hides the cookie from page JavaScript, `secure` requires HTTPS in production, and `sameSite: "lax"` is one CSRF defense layer.
- `accountLink()` builds a frontend link using the configured origin. `tokenInDevelopment()` ensures raw tokens are only returned outside production.
- `passwordIsValid()` centralizes the 12–128 character rule. `clearAuthCookie()` expires the browser cookie on logout/password change.
- `sendOneTimeEmail()` builds the link and sends an email; if local email delivery is not configured it hands the token back to the controller for development testing.
- `registerUser()` checks input types and required values, normalizes email, hashes the password with bcrypt cost 12, creates an unverified buyer, stores only the verification token hash and expiry, then sends the verification email. Duplicate-key handling covers two concurrent registrations for the same address.
- `verifyEmail()` hashes the supplied token and looks for an exact, unexpired match. It then marks the account verified and clears both token fields, making the token one-use.
- `resendVerification()` rotates the old token and expiration. Its generic response avoids telling callers whether an address has an account; delivery failures return the same generic status.
- `loginUser()` validates inputs, finds the normalized email, compares the password to the bcrypt hash, then rejects disabled or unverified users. It creates a database session, signs a JWT containing the user and session IDs, sets the HttpOnly cookie, and returns the CSRF token and safe user fields. The password is never returned.
- `logoutUser()` revokes that exact session row and clears the cookie. Clearing only the cookie would not invalidate a copied JWT.
- `requestPasswordReset()` always gives the same response for an existing or missing email. For a real active user it stores a hashed, expiring reset token and sends it.
- `resetPassword()` checks the one-time token and new password, hashes the replacement, clears the reset token, and revokes every session for the account.
- `changePassword()` requires the signed-in user's current password before hashing a new one. It revokes all sessions, including the current one, and clears the current cookie.
- `setAccountStatus()` and `setUserRole()` validate admin-supplied values. Disabling a user also revokes their sessions. The routes require the admin role and CSRF token.
- `getUserProfile()` returns a deliberate safe-field projection; it never returns the password or token hashes.

### `middleware/authMiddleware.js`

- `requireAuth()` reads the JWT cookie, verifies signature/issuer/audience/expiry, finds an unexpired non-revoked session, and reloads the user's active status and role. It attaches only safe user data and the session to `req` for later middleware/controllers.
- `requireCsrf()` compares the `X-CSRF-Token` header to the token stored in that session. It is attached to cookie-authenticated write routes.
- `requireRole("admin")` blocks requests unless the authenticated role is allowed; it is used for role and account-status changes. Listing routes can use `requireRole("seller", "admin")` for seller actions.
- `requireSelfOrAdmin()` prevents a user from reading another user's profile.
- `requireResourceOwner(findResource, getOwnerId)` is a reusable owner check for future listing routes: load the listing, compare its seller ID with `req.user.id`, allow admins, and attach the loaded resource to `req.authorizedResource`. There is no listing model or listing edit route in this backend yet, so this helper is not wired to a listing action.

### `controllers/authRoutes.js`

Each `router.post/get/patch` maps an HTTP method and URL suffix to middleware and a controller. `requireAuth` runs before private actions; `requireCsrf` protects cookie-authenticated writes; role/owner checks then decide which user may perform the action. `server.js` mounts this router at `/api/auth`, so `/login` becomes `/api/auth/login`.

### `app.js` and `server.js`

- `app.js` builds and exports the Express application without opening a database connection; this lets the test file start an isolated HTTP server.
- `express.json({ limit: "10kb" })` parses JSON request bodies and bounds their size.
- The cookie parser reads the request's `Cookie` header into `req.cookies`; the app uses this so it doesn't need an extra package.
- Credentialed CORS returns headers only for the exact frontend origin; it never combines credentials with `*`. The separate Origin check rejects unsafe browser requests from other sites.
- The general authentication limiter allows 100 requests per IP per 15 minutes. The login limiter allows only 5 login requests per IP in that same window. The included memory store is for one process; a multi-instance deployment needs a shared store such as Redis and correct proxy/IP configuration.
- The final Express error handler logs the internal message on the server and sends a generic response to the client.
- `server.js` loads `.env`, checks secret/origin configuration, connects MongoDB, and only then starts listening.

### `test/auth.test.js`

- It uses Node's built-in test runner and real HTTP requests, with MongoDB database `bidding_app_test` by default.
- The `_test` database-name guard prevents the setup/cleanup from dropping a development database by mistake. `after` drops only that test database.
- The tests cover a wrong password, an expired JWT, CSRF rejection and valid logout, replay of the old cookie after logout, access to another user's profile, and repeated login attempts hitting the 429 limit.
- Run them with `npm test` inside `server` when MongoDB is running. They were added but have not been run here.

## Bidding-specific authorization still to wire

The current backend has no listing/auction model or listing routes. The role fields, `requireRole`, and generic resource-owner middleware are ready, but the eventual create/edit/delete listing endpoints must use them. For example, listing creation should require `seller`; editing/deleting should require `seller` or `admin` and then check the listing's stored seller ID with `requireResourceOwner`. Do not accept a seller ID from the request body as proof of ownership.

