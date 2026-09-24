const fs = require('fs');
const path = require('path');

// Single source of truth for data-ownership audit data.
//
// The board list, the on-screen permission view and the downloadable audit
// report are all derived from these queries, so they can never disagree:
//  - ownership comes from the exact query behind GET /api/boards
//  - only ACTIVE shares (revoked_at IS NULL) are ever reported, and the
//    GROUP BY collapses any conflicting duplicates into one row
//  - shares are read-only by definition, so a shared account is never
//    reported as able to modify the board

// Same SELECT/WHERE/ORDER as the board list route — the report's ownership
// section always matches the boards a user sees in the app.
function listOwnedBoards(db, userId) {
  return db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM columns WHERE board_id = b.id) AS column_count,
      (SELECT COUNT(*) FROM cards c JOIN columns col ON c.column_id = col.id WHERE col.board_id = b.id) AS card_count
    FROM boards b
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC, b.id DESC
  `).all(userId);
}

// Active read-only shares across all boards owned by userId.
function listActiveShares(db, userId) {
  return db.prepare(`
    SELECT s.board_id, b.name AS board_name, s.user_id, u.username,
      MAX(s.created_at) AS granted_at
    FROM board_shares s
    JOIN boards b ON b.id = s.board_id
    JOIN users u ON u.id = s.user_id
    WHERE b.user_id = ? AND s.revoked_at IS NULL
    GROUP BY s.board_id, s.user_id
    ORDER BY s.board_id ASC, u.username ASC
  `).all(userId);
}

// Active read-only shares for a single board (permission view).
function listBoardShares(db, boardId) {
  return db.prepare(`
    SELECT s.user_id, u.username, MAX(s.created_at) AS granted_at
    FROM board_shares s
    JOIN users u ON u.id = s.user_id
    WHERE s.board_id = ? AND s.revoked_at IS NULL
    GROUP BY s.board_id, s.user_id
    ORDER BY u.username ASC
  `).all(boardId);
}

// Recent permission changes on boards owned by userId, newest first.
function listRecentPermissionEvents(db, userId, limit = 50) {
  return db.prepare(`
    SELECT e.board_id, b.name AS board_name, e.action, e.created_at,
      target.username AS target_username, actor.username AS actor_username
    FROM permission_events e
    JOIN boards b ON b.id = e.board_id
    JOIN users target ON target.id = e.target_user_id
    JOIN users actor ON actor.id = e.actor_id
    WHERE b.user_id = ?
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ?
  `).all(userId, limit);
}

// Structured audit report for one owner, built entirely from the queries
// above. An owner with no boards/shares/events yields empty sections —
// a valid empty report, not a contradictory one.
function buildAuditReport(db, userId, username) {
  return {
    generatedAt: new Date().toISOString(),
    owner: username,
    ownership: listOwnedBoards(db, userId),
    readonlyScope: listActiveShares(db, userId),
    changes: listRecentPermissionEvents(db, userId)
  };
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

// Deterministic CSV: fixed section order, stable row ordering, so repeated
// exports of unchanged data produce identical content.
function renderAuditReportCsv(report) {
  const lines = [];
  lines.push(csvRow(['section', 'board_id', 'board_name', 'owner', 'account', 'permission', 'action', 'changed_by', 'changed_at']));

  for (const b of report.ownership) {
    lines.push(csvRow(['ownership', b.id, b.name, report.owner, report.owner, 'owner', '', '', '']));
  }
  for (const s of report.readonlyScope) {
    lines.push(csvRow(['readonly', s.board_id, s.board_name, report.owner, s.username, 'read', '', '', '']));
  }
  for (const e of report.changes) {
    lines.push(csvRow(['change', e.board_id, e.board_name, report.owner, e.target_username, 'read', e.action, e.actor_username, e.created_at]));
  }

  return lines.join('\n') + '\n';
}

// Write the report so the final file is never partial or contradictory:
// write to a temp file in the same directory, fsync, then atomically rename
// over the destination. Repeated exports overwrite the same file; a failure
// before the rename leaves the previous (consistent) file untouched.
function writeReportAtomic(dir, filename, content) {
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, filename);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* temp file may not exist */ }
    throw err;
  }
  return finalPath;
}

module.exports = {
  listOwnedBoards,
  listActiveShares,
  listBoardShares,
  listRecentPermissionEvents,
  buildAuditReport,
  renderAuditReportCsv,
  writeReportAtomic
};
