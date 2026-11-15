"use strict";

const crypto = require("node:crypto");
const { hashToken } = require("./auth");
const { normalizeStoredRole } = require("./roles");
const { withRedemptionTransaction } = require("./auth-recovery");

async function ensureSessionIdentitySchema({ all, run }) {
  const sessions = new Set((await all("PRAGMA table_info(auth_sessions)")).map(({ name }) => name));
  if (!sessions.has("userId")) await run("ALTER TABLE auth_sessions ADD COLUMN userId INTEGER");
  if (!sessions.has("principalType")) await run("ALTER TABLE auth_sessions ADD COLUMN principalType TEXT");
  await run("CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(userId)");

  const users = new Set((await all("PRAGMA table_info(users)")).map(({ name }) => name));
  if (!users.has("bootstrapIdentity")) await run("ALTER TABLE users ADD COLUMN bootstrapIdentity TEXT");
  await run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_bootstrap_identity ON users(bootstrapIdentity) WHERE bootstrapIdentity IS NOT NULL");
}

function revokeAccountSessions(run, userId) {
  return run("DELETE FROM auth_sessions WHERE userId = ?", [userId]);
}

function createSessionStore({ get, filename, bootstrapUser, ttlMs }) {
  const bootstrapIdentity = hashToken(bootstrapUser);

  async function createAccountSession(account, upgradedHash = null) {
    const token = crypto.randomUUID();
    // A stale credential snapshot can neither overwrite a reset password nor
    // issue a new session. Upgrade and session issuance commit together.
    const changed = await withRedemptionTransaction(filename, async ({ run }) => {
      if (upgradedHash) {
        const upgraded = await run(
          "UPDATE users SET passwordHash = ? WHERE id = ? AND passwordHash = ? AND bootstrapIdentity IS NULL",
          [upgradedHash, account.id, account.passwordHash]
        );
        if (!upgraded) return 0;
      }
      const issued = await run(
        `INSERT INTO auth_sessions (tokenHash, user, role, city, exp, userId, principalType)
         SELECT ?, COALESCE(NULLIF(username, ''), email, 'user'), COALESCE(role, 'organizer'),
                COALESCE(city, 'Enumclaw'), ?, id, 'account'
           FROM users WHERE id = ? AND passwordHash = ? AND bootstrapIdentity IS NULL`,
        [hashToken(token), Date.now() + ttlMs, account.id, upgradedHash || account.passwordHash]
      );
      if (upgradedHash && issued !== 1) throw new Error("Upgraded session could not be issued");
      return issued;
    });
    return changed === 1 ? token : null;
  }

  async function createBootstrapSession() {
    const token = crypto.randomUUID();
    return withRedemptionTransaction(filename, async ({ get, run }) => {
      let profile = await get("SELECT id, role, city FROM users WHERE bootstrapIdentity = ?", [bootstrapIdentity]);
      if (!profile) {
        // A passwordless Developer with this exact username and no email is
        // the old bootstrap profile, provided no other account uses its alias.
        const aliases = [bootstrapUser, bootstrapUser];
        const oldProfile = await get(
          `SELECT id, role, city FROM users
            WHERE username = ? AND role = 'developer' AND COALESCE(passwordHash, '') = ''
              AND COALESCE(email, '') = '' AND bootstrapIdentity IS NULL
              AND (SELECT COUNT(*) FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?)) = 1`,
          [bootstrapUser, ...aliases]
        );
        if (oldProfile) {
          await run("UPDATE users SET bootstrapIdentity = ? WHERE id = ?", [bootstrapIdentity, oldProfile.id]);
          profile = oldProfile;
        } else {
          const occupied = await get(
            "SELECT id FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?) LIMIT 1",
            aliases
          );
          const username = occupied ? `${bootstrapUser} (bootstrap ${crypto.randomUUID()})` : bootstrapUser;
          await run(
            "INSERT INTO users (username, passwordHash, role, city, bootstrapIdentity) VALUES (?, '', 'developer', 'Enumclaw', ?)",
            [username, bootstrapIdentity]
          );
          profile = await get("SELECT id, role, city FROM users WHERE bootstrapIdentity = ?", [bootstrapIdentity]);
        }
      }
      if (normalizeStoredRole(profile.role) !== "developer") return null;
      await run(
        `INSERT INTO auth_sessions (tokenHash, user, role, city, exp, userId, principalType)
         VALUES (?, ?, 'developer', ?, ?, ?, 'bootstrap')`,
        [hashToken(token), bootstrapUser, profile.city || "Enumclaw", Date.now() + ttlMs, profile.id]
      );
      return token;
    });
  }

  async function restore(token) {
    if (!token) return null;
    // SQLite is authoritative on every request so no worker can resurrect a
    // revoked session from an identity cached before the transaction committed.
    const row = await get(
      `SELECT u.id, u.username, u.email, u.role, u.city, s.principalType
         FROM auth_sessions s JOIN users u ON u.id = s.userId
        WHERE s.tokenHash = ? AND s.exp > ? AND (
          (s.principalType = 'account' AND u.bootstrapIdentity IS NULL)
          OR (s.principalType = 'bootstrap' AND u.bootstrapIdentity = ? AND s.user = ? AND u.role = 'developer')
        )`,
      [hashToken(token), Date.now(), bootstrapIdentity, bootstrapUser]
    );
    if (!row) return null;
    return {
      userId: row.id,
      principalType: row.principalType,
      user: row.username || row.email || "user",
      role: normalizeStoredRole(row.role),
      city: row.city || "Enumclaw",
    };
  }

  return {
    createAccountSession,
    createBootstrapSession,
    restore,
    destroy: (token) => token && withRedemptionTransaction(filename, ({ run }) =>
      run("DELETE FROM auth_sessions WHERE tokenHash = ?", [hashToken(token)])),
  };
}

module.exports = { createSessionStore, ensureSessionIdentitySchema, revokeAccountSessions };
