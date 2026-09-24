const express = require('express');
const path = require('path');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const audit = require('../services/audit');

const router = express.Router();

router.use(authMiddleware);

const REPORTS_DIR = path.join(__dirname, '..', 'data', 'reports');

function getOwnedBoard(db, boardId, userId) {
  return db.prepare('SELECT * FROM boards WHERE id = ? AND user_id = ?').get(boardId, userId);
}

// GET /api/boards/:boardId/shares - Permission view for a board (owner only).
// Lists only ACTIVE read-only shares; revoked grants never appear and no
// account is ever reported as able to modify the board.
router.get('/boards/:boardId/shares', (req, res) => {
  const db = getDb();
  try {
    const board = getOwnedBoard(db, req.params.boardId, req.user.id);
    if (!board) {
      db.close();
      return res.status(404).json({ error: 'Board not found' });
    }

    const shares = audit.listBoardShares(db, board.id).map(s => ({
      user_id: s.user_id,
      username: s.username,
      permission: 'read',
      read_only: true,
      granted_at: s.granted_at
    }));
    db.close();
    res.json(shares);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to fetch shares' });
  }
});

// POST /api/boards/:boardId/shares - Grant read-only access (owner only).
// Re-granting a revoked share revives the same row, so conflicting
// duplicate records are never created.
router.post('/boards/:boardId/shares', (req, res) => {
  const { username } = req.body;
  if (!username || !username.trim()) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const db = getDb();
  try {
    const board = getOwnedBoard(db, req.params.boardId, req.user.id);
    if (!board) {
      db.close();
      return res.status(404).json({ error: 'Board not found' });
    }

    const target = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username.trim());
    if (!target) {
      db.close();
      return res.status(404).json({ error: 'User not found' });
    }
    if (target.id === req.user.id) {
      db.close();
      return res.status(400).json({ error: 'Cannot share a board with its owner' });
    }

    const grant = db.transaction(() => {
      const existing = db.prepare(
        'SELECT * FROM board_shares WHERE board_id = ? AND user_id = ?'
      ).get(board.id, target.id);

      if (existing && existing.revoked_at === null) {
        return { conflict: true };
      }

      if (existing) {
        // Revive the previously revoked row instead of inserting a duplicate.
        db.prepare(`
          UPDATE board_shares
          SET revoked_at = NULL, granted_by = ?, created_at = datetime('now')
          WHERE id = ?
        `).run(req.user.id, existing.id);
      } else {
        db.prepare(
          'INSERT INTO board_shares (board_id, user_id, granted_by) VALUES (?, ?, ?)'
        ).run(board.id, target.id, req.user.id);
      }

      db.prepare(
        'INSERT INTO permission_events (board_id, actor_id, target_user_id, action) VALUES (?, ?, ?, ?)'
      ).run(board.id, req.user.id, target.id, 'granted');

      return { conflict: false };
    });

    const result = grant();
    if (result.conflict) {
      db.close();
      return res.status(409).json({ error: 'Board is already shared with this user' });
    }

    const shares = audit.listBoardShares(db, board.id).map(s => ({
      user_id: s.user_id,
      username: s.username,
      permission: 'read',
      read_only: true,
      granted_at: s.granted_at
    }));
    db.close();
    res.status(201).json(shares);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to share board' });
  }
});

// DELETE /api/boards/:boardId/shares/:userId - Revoke read-only access.
// Soft delete: the share disappears from every view/report immediately,
// while the grant/revoke history stays in permission_events.
router.delete('/boards/:boardId/shares/:userId', (req, res) => {
  const db = getDb();
  try {
    const board = getOwnedBoard(db, req.params.boardId, req.user.id);
    if (!board) {
      db.close();
      return res.status(404).json({ error: 'Board not found' });
    }

    const share = db.prepare(
      'SELECT * FROM board_shares WHERE board_id = ? AND user_id = ? AND revoked_at IS NULL'
    ).get(board.id, req.params.userId);
    if (!share) {
      db.close();
      return res.status(404).json({ error: 'Share not found' });
    }

    const revoke = db.transaction(() => {
      db.prepare("UPDATE board_shares SET revoked_at = datetime('now') WHERE id = ?").run(share.id);
      db.prepare(
        'INSERT INTO permission_events (board_id, actor_id, target_user_id, action) VALUES (?, ?, ?, ?)'
      ).run(board.id, req.user.id, share.user_id, 'revoked');
    });
    revoke();

    db.close();
    res.json({ message: 'Share revoked' });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to revoke share' });
  }
});

// GET /api/audit/permissions - Cross-account permission view (JSON).
// Same data source as the downloadable report.
router.get('/audit/permissions', (req, res) => {
  const db = getDb();
  try {
    const report = audit.buildAuditReport(db, req.user.id, req.user.username);
    db.close();
    res.json({
      generated_at: report.generatedAt,
      owner: report.owner,
      boards: report.ownership.map(b => ({ id: b.id, name: b.name, created_at: b.created_at })),
      readonly_scope: report.readonlyScope,
      recent_changes: report.changes
    });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to build permission view' });
  }
});

// GET /api/audit/report - Downloadable cross-account audit report (CSV).
// The file is generated atomically under a deterministic name: repeated
// exports overwrite the same result, an interrupted download never leaves
// a partial file behind, and an empty report is still a valid CSV.
router.get('/audit/report', (req, res) => {
  const db = getDb();
  let csv;
  let filename;
  try {
    const report = audit.buildAuditReport(db, req.user.id, req.user.username);
    csv = audit.renderAuditReportCsv(report);
    filename = `audit-report-${req.user.id}.csv`;
    db.close();
  } catch (err) {
    db.close();
    return res.status(500).json({ error: 'Failed to build audit report' });
  }

  let filePath;
  try {
    filePath = audit.writeReportAtomic(REPORTS_DIR, filename, csv);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to write audit report' });
  }

  res.download(filePath, filename, (err) => {
    // The on-disk file is already complete (atomic rename happened before
    // streaming), so an aborted download leaves no contradictory file.
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Failed to download audit report' });
    }
  });
});

module.exports = router;
