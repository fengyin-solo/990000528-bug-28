const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  listAccessibleBoards,
  listIncomingGrants,
  listRecentEvents,
  detectConflicts
} = require('./permissions');

// Deterministic ordering so repeated exports of the same data produce the
// exact same file (same content hash, same filename -> overwrite, no copies).
function sortByKey(rows, keyFn) {
  return [...rows].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

// Build the report purely from the canonical permission queries. Nothing here
// reads raw share/event rows, so the report cannot drift from the UI.
function buildAuditReport(db, user) {
  const boards = listAccessibleBoards(db, user.id);
  const grants = listIncomingGrants(db, user.id);
  const recentChanges = listRecentEvents(db, user.id);

  const ownership = sortByKey(
    boards.map(b => ({
      board_id: b.id,
      board_name: b.name,
      owner_id: b.owner_id,
      owner_username: b.owner_username,
      created_at: b.created_at,
      column_count: b.column_count,
      card_count: b.card_count
    })),
    b => b.board_id
  );

  const readonlyScope = sortByKey(
    grants
      .filter(g => g.access_level === 'readonly')
      .map(g => ({
        board_id: g.board_id,
        board_name: g.board_name,
        grantee_id: g.grantee_id,
        grantee_username: g.grantee_username,
        granted_by: g.granted_by_username,
        granted_at: g.granted_at
      })),
    g => `${g.board_id}:${g.grantee_id}`
  );

  const editScope = sortByKey(
    grants
      .filter(g => g.access_level === 'edit')
      .map(g => ({
        board_id: g.board_id,
        board_name: g.board_name,
        grantee_id: g.grantee_id,
        grantee_username: g.grantee_username,
        granted_by: g.granted_by_username,
        granted_at: g.granted_at
      })),
    g => `${g.board_id}:${g.grantee_id}`
  );

  const changes = recentChanges.map(e => ({
    event_id: e.id,
    board_id: e.board_id,
    board_name: e.board_name,
    grantee_id: e.grantee_id,
    grantee_username: e.grantee_username,
    actor_username: e.actor_username,
    action: e.action,
    access_level: e.access_level, // null on revoke
    changed_at: e.created_at
  })); // already newest-first from the audit log

  return {
    report_type: 'cross_account_audit',
    account: { id: user.id, username: user.username },
    ownership,
    readonly_scope: readonlyScope,
    edit_scope: editScope,
    recent_permission_changes: changes
  };
}

// Cross-check the assembled sections against one another. Any disagreement
// means the export aborts BEFORE a file is created, so callers never receive
// a contradictory report.
function validateReport(report) {
  const conflicts = [];

  const ownedIds = new Set(report.ownership.map(b => b.board_id));
  for (const g of [...report.readonly_scope, ...report.edit_scope]) {
    if (!ownedIds.has(g.board_id)) {
      conflicts.push(`grant on board ${g.board_id} not found in ownership list`);
    }
  }

  const activeKeys = new Set();
  for (const g of [...report.readonly_scope, ...report.edit_scope]) {
    const key = `${g.board_id}:${g.grantee_id}`;
    if (activeKeys.has(key)) conflicts.push(`duplicate active grant ${key}`);
    activeKeys.add(key);
  }

  // Revoke events must not have a surviving active grant.
  for (const e of report.recent_permission_changes) {
    if (e.action === 'revoke' && activeKeys.has(`${e.board_id}:${e.grantee_id}`)) {
      conflicts.push(`revoked access still active for ${e.board_id}:${e.grantee_id}`);
    }
  }

  return conflicts;
}

function serializeReport(report) {
  return JSON.stringify(report, null, 2);
}

// Filename is stable per account: repeat exports overwrite the same result
// rather than accumulating timestamped copies.
function reportFilename(user) {
  const safe = String(user.username).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `cross-account-audit-${user.id}-${safe}.json`;
}

// Write to a temp file in the same directory, fsync, then atomically rename.
// A failed/interrupted export leaves no partial file at the final path, and a
// successful one replaces the previous result wholesale.
function atomicWrite(targetDir, filename, content) {
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, filename);
  const tmp = path.join(targetDir, `.${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);

  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* temp already gone */ }
    throw err;
  }
  return target;
}

// Full guarded export: conflicts -> throw (no file); otherwise one atomic
// replace. Returns the report plus the written path and a content hash.
function exportAuditReport(db, user, targetDir) {
  const conflictsInDb = detectConflicts(db, user.id);
  const report = buildAuditReport(db, user);
  const inconsistencies = conflictsInDb.map(
    c => `conflicting active grants for board ${c.board_name} (${c.board_id}) account ${c.grantee_username}: ${c.active_rows} rows`
  );
  inconsistencies.push(...validateReport(report));

  if (inconsistencies.length > 0) {
    const err = new Error('Conflicting permission records; export refused');
    err.statusCode = 409;
    err.conflicts = inconsistencies;
    throw err;
  }

  const content = serializeReport(report);
  const filename = reportFilename(user);
  const filePath = atomicWrite(targetDir, filename, content);

  return {
    report,
    filename,
    filePath,
    content,
    sha256: crypto.createHash('sha256').update(content).digest('hex')
  };
}

module.exports = {
  buildAuditReport,
  validateReport,
  serializeReport,
  reportFilename,
  atomicWrite,
  exportAuditReport
};
