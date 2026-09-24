// Canonical cross-account permission data layer.
//
// Root-cause note: the permission view, the board list, and the exported audit
// report must ALL read effective permissions through this module. Effective
// access is the latest active (revoked_at IS NULL) grant; revoked rows are
// history only and never surface as current access. Keeping one query path
// here prevents the three symptoms: revoked grants lingering in the view,
// every account appearing editable, and the report disagreeing with the list.

const RECENT_EVENT_LIMIT = 50;

// Effective access a user has to one board:
//   { level: 'owner' | 'edit' | 'readonly' } or null
function getBoardAccess(db, boardId, userId) {
  const owned = db.prepare('SELECT id FROM boards WHERE id = ? AND user_id = ?').get(boardId, userId);
  if (owned) return { level: 'owner' };

  const share = db.prepare(`
    SELECT access_level FROM board_shares
    WHERE board_id = ? AND grantee_id = ? AND revoked_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(boardId, userId);
  return share ? { level: share.access_level } : null;
}

function canView(db, boardId, userId) {
  return getBoardAccess(db, boardId, userId) !== null;
}

function canEdit(db, boardId, userId) {
  const access = getBoardAccess(db, boardId, userId);
  return access && (access.level === 'owner' || access.level === 'edit');
}

function isOwner(db, boardId, userId) {
  return db.prepare('SELECT id FROM boards WHERE id = ? AND user_id = ?').get(boardId, userId) !== undefined;
}

// Boards a user can open: owned boards plus actively-shared boards.
// This is the same row set the audit report's ownership section uses, so the
// on-screen list and a downloaded report can never disagree.
function listAccessibleBoards(db, userId) {
  return db.prepare(`
    SELECT b.id, b.name, b.description, b.user_id AS owner_id,
           ou.username AS owner_username,
           b.created_at,
           (SELECT COUNT(*) FROM columns WHERE board_id = b.id) AS column_count,
           (SELECT COUNT(*) FROM cards c
              JOIN columns col ON c.column_id = col.id
             WHERE col.board_id = b.id) AS card_count,
           CASE
             WHEN b.user_id = @uid THEN 'owner'
             ELSE (
               SELECT access_level FROM board_shares
                WHERE board_id = b.id AND grantee_id = @uid AND revoked_at IS NULL
                ORDER BY id DESC LIMIT 1
             )
           END AS access_level
      FROM boards b
      JOIN users ou ON ou.id = b.user_id
     WHERE b.user_id = @uid
        OR EXISTS (
             SELECT 1 FROM board_shares s
              WHERE s.board_id = b.id AND s.grantee_id = @uid AND s.revoked_at IS NULL
           )
     ORDER BY b.created_at DESC
  `).all({ uid: userId });
}

// Active grants on every board the user owns. Revoked rows are excluded;
// duplicates are treated as conflicts and surfaced by detectConflicts().
function listIncomingGrants(db, ownerId) {
  return db.prepare(`
    SELECT s.id, s.board_id, b.name AS board_name,
           s.grantee_id, gu.username AS grantee_username,
           s.access_level, s.granted_by, au.username AS granted_by_username,
           s.granted_at
      FROM board_shares s
      JOIN boards b ON b.id = s.board_id
      JOIN users gu ON gu.id = s.grantee_id
      JOIN users au ON au.id = s.granted_by
     WHERE b.user_id = @uid AND s.revoked_at IS NULL
     ORDER BY s.board_id ASC, s.granted_at ASC
  `).all({ uid: ownerId });
}

// Boards currently shared WITH the requesting user (read-only scope etc.).
// One row per board even if legacy duplicate grants exist; duplicates are
// reported separately by detectConflicts() and block export.
function listSharedWithMe(db, userId) {
  return db.prepare(`
    SELECT s.id AS share_id, s.board_id, b.name AS board_name,
           b.user_id AS owner_id, ou.username AS owner_username,
           s.access_level, s.granted_at
      FROM board_shares s
      JOIN boards b ON b.id = s.board_id
      JOIN users ou ON ou.id = b.user_id
     WHERE s.grantee_id = @uid AND s.revoked_at IS NULL
       AND s.id = (
         SELECT MAX(id) FROM board_shares
          WHERE board_id = s.board_id AND grantee_id = @uid AND revoked_at IS NULL
       )
     ORDER BY s.granted_at DESC
  `).all({ uid: userId });
}

function listRecentEvents(db, ownerId, limit = RECENT_EVENT_LIMIT) {
  return db.prepare(`
    SELECT e.id, e.board_id, b.name AS board_name,
           e.grantee_id, gu.username AS grantee_username,
           e.actor_id, au.username AS actor_username,
           e.action, e.access_level, e.created_at
      FROM permission_events e
      JOIN boards b ON b.id = e.board_id
      JOIN users gu ON gu.id = e.grantee_id
      JOIN users au ON au.id = e.actor_id
     WHERE b.user_id = @uid
     ORDER BY e.id DESC
     LIMIT @limit
  `).all({ uid: ownerId, limit });
}

// A conflict is two or more *active* grant rows for the same (board, grantee).
// The partial unique index normally prevents this, but pre-existing bad data
// can still exist; the export must refuse to write a contradictory file.
function detectConflicts(db, ownerId) {
  return db.prepare(`
    SELECT s.board_id, b.name AS board_name,
           s.grantee_id, gu.username AS grantee_username,
           COUNT(*) AS active_rows
      FROM board_shares s
      JOIN boards b ON b.id = s.board_id
      JOIN users gu ON gu.id = s.grantee_id
     WHERE b.user_id = @uid AND s.revoked_at IS NULL
     GROUP BY s.board_id, s.grantee_id
    HAVING COUNT(*) > 1
     ORDER BY s.board_id ASC, s.grantee_id ASC
  `).all({ uid: ownerId });
}

// ---- Mutations: every grant change writes the share row AND an audit event
// ---- inside one transaction, so effective access and history cannot diverge.

function grantAccess(db, { boardId, granteeId, accessLevel, actorId }) {
  return db.transaction(() => {
    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
    if (!board) return { error: 404, message: 'Board not found' };
    if (board.user_id !== actorId) return { error: 403, message: 'Only the board owner can manage access' };
    if (granteeId === actorId) return { error: 400, message: 'Cannot share a board with its owner' };
    if (!['readonly', 'edit'].includes(accessLevel)) return { error: 400, message: 'access_level must be readonly or edit' };
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(granteeId)) {
      return { error: 404, message: 'Target account not found' };
    }

    const active = db.prepare(`
      SELECT * FROM board_shares WHERE board_id = ? AND grantee_id = ? AND revoked_at IS NULL
    `).get(boardId, granteeId);
    if (active) return { error: 409, message: 'Account already has access; update or revoke it first' };

    const result = db.prepare(`
      INSERT INTO board_shares (board_id, grantee_id, access_level, granted_by)
      VALUES (?, ?, ?, ?)
    `).run(boardId, granteeId, accessLevel, actorId);

    db.prepare(`
      INSERT INTO permission_events (board_id, grantee_id, actor_id, action, access_level)
      VALUES (?, ?, ?, 'grant', ?)
    `).run(boardId, granteeId, actorId, accessLevel);

    return { shareId: result.lastInsertRowid };
  })();
}

function updateAccess(db, { boardId, granteeId, accessLevel, actorId }) {
  return db.transaction(() => {
    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
    if (!board) return { error: 404, message: 'Board not found' };
    if (board.user_id !== actorId) return { error: 403, message: 'Only the board owner can manage access' };
    if (!['readonly', 'edit'].includes(accessLevel)) return { error: 400, message: 'access_level must be readonly or edit' };

    const active = db.prepare(`
      SELECT * FROM board_shares WHERE board_id = ? AND grantee_id = ? AND revoked_at IS NULL
      ORDER BY id DESC
    `).get(boardId, granteeId);
    if (!active) return { error: 404, message: 'No active access for that account' };
    if (active.access_level === accessLevel) return { error: 400, message: 'Access level unchanged' };

    db.prepare('UPDATE board_shares SET access_level = ? WHERE id = ?').run(accessLevel, active.id);
    db.prepare(`
      INSERT INTO permission_events (board_id, grantee_id, actor_id, action, access_level)
      VALUES (?, ?, ?, 'update', ?)
    `).run(boardId, granteeId, actorId, accessLevel);

    return { shareId: active.id };
  })();
}

function revokeAccess(db, { boardId, granteeId, actorId }) {
  return db.transaction(() => {
    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
    if (!board) return { error: 404, message: 'Board not found' };
    if (board.user_id !== actorId) return { error: 403, message: 'Only the board owner can manage access' };

    const active = db.prepare(`
      SELECT * FROM board_shares WHERE board_id = ? AND grantee_id = ? AND revoked_at IS NULL
      ORDER BY id DESC
    `).get(boardId, granteeId);
    if (!active) return { error: 404, message: 'No active access for that account' };

    db.prepare(`
      UPDATE board_shares SET revoked_at = datetime('now'), revoked_by = ? WHERE id = ?
    `).run(actorId, active.id);
    db.prepare(`
      INSERT INTO permission_events (board_id, grantee_id, actor_id, action, access_level)
      VALUES (?, ?, ?, 'revoke', NULL)
    `).run(boardId, granteeId, actorId);

    return { shareId: active.id };
  })();
}

module.exports = {
  RECENT_EVENT_LIMIT,
  getBoardAccess,
  canView,
  canEdit,
  isOwner,
  listAccessibleBoards,
  listIncomingGrants,
  listSharedWithMe,
  listRecentEvents,
  detectConflicts,
  grantAccess,
  updateAccess,
  revokeAccess
};
