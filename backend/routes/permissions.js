const express = require('express');
const path = require('path');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const permissions = require('../services/permissions');
const { buildAuditReport, exportAuditReport } = require('../services/auditReport');

const router = express.Router();

router.use(authMiddleware);

const REPORT_DIR = process.env.REPORT_DIR
  || path.join(process.env.DB_DIR || path.join(__dirname, '..', 'data'), 'reports');

function sendError(res, result) {
  return res.status(result.error).json({ error: result.message });
}

// GET /api/permissions/me - everything the permission view shows, from the
// single canonical source: boards shared with me + boards I own + recent
// changes on boards I own.
router.get('/me', (req, res) => {
  const db = getDb();
  try {
    res.json({
      boards: permissions.listAccessibleBoards(db, req.user.id),
      shared_with_me: permissions.listSharedWithMe(db, req.user.id),
      grants_on_mine: permissions.listIncomingGrants(db, req.user.id),
      recent_changes: permissions.listRecentEvents(db, req.user.id),
      conflicts: permissions.detectConflicts(db, req.user.id)
    });
  } finally {
    db.close();
  }
});

// GET /api/permissions/boards/:boardId - active access list for one owned board
router.get('/boards/:boardId', (req, res) => {
  const db = getDb();
  try {
    if (!permissions.isOwner(db, req.params.boardId, req.user.id)) {
      return res.status(404).json({ error: 'Board not found' });
    }
    const grants = permissions.listIncomingGrants(db, req.user.id)
      .filter(g => g.board_id === Number(req.params.boardId));
    res.json(grants);
  } finally {
    db.close();
  }
});

// POST /api/permissions/share - grant cross-account access
router.post('/share', (req, res) => {
  const { boardId, granteeUsername, accessLevel } = req.body;
  if (!boardId || !granteeUsername || !accessLevel) {
    return res.status(400).json({ error: 'boardId, granteeUsername and accessLevel are required' });
  }
  const db = getDb();
  try {
    const grantee = db.prepare('SELECT id FROM users WHERE username = ?').get(String(granteeUsername).trim());
    if (!grantee) return res.status(404).json({ error: 'Target account not found' });

    const result = permissions.grantAccess(db, {
      boardId: Number(boardId),
      granteeId: grantee.id,
      accessLevel,
      actorId: req.user.id
    });
    if (result.error) return sendError(res, result);
    res.status(201).json({ shareId: result.shareId, message: 'Access granted' });
  } finally {
    db.close();
  }
});

// PUT /api/permissions/share/:boardId/:granteeId - change readonly <-> edit
router.put('/share/:boardId/:granteeId', (req, res) => {
  const { accessLevel } = req.body;
  const db = getDb();
  try {
    const result = permissions.updateAccess(db, {
      boardId: Number(req.params.boardId),
      granteeId: Number(req.params.granteeId),
      accessLevel,
      actorId: req.user.id
    });
    if (result.error) return sendError(res, result);
    res.json({ message: 'Access level updated' });
  } finally {
    db.close();
  }
});

// DELETE /api/permissions/share/:boardId/:granteeId - revoke access
router.delete('/share/:boardId/:granteeId', (req, res) => {
  const db = getDb();
  try {
    const result = permissions.revokeAccess(db, {
      boardId: Number(req.params.boardId),
      granteeId: Number(req.params.granteeId),
      actorId: req.user.id
    });
    if (result.error) return sendError(res, result);
    res.json({ message: 'Access revoked' });
  } finally {
    db.close();
  }
});

// GET /api/permissions/audit - report payload (preview / empty allowed)
router.get('/audit', (req, res) => {
  const db = getDb();
  try {
    const conflicts = permissions.detectConflicts(db, req.user.id);
    if (conflicts.length > 0) {
      return res.status(409).json({
        error: 'Conflicting permission records; resolve them before exporting',
        conflicts
      });
    }
    res.json(buildAuditReport(db, req.user));
  } finally {
    db.close();
  }
});

// GET /api/permissions/audit/export - download the report file
router.get('/audit/export', (req, res) => {
  const db = getDb();
  try {
    let exported;
    try {
      exported = exportAuditReport(db, req.user, REPORT_DIR);
    } catch (err) {
      const status = err.statusCode || 500;
      return res.status(status).json({ error: err.message, conflicts: err.conflicts });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
    res.setHeader('Content-Length', Buffer.byteLength(exported.content));
    res.setHeader('X-Report-Sha256', exported.sha256);
    res.send(exported.content);
  } finally {
    db.close();
  }
});

module.exports = router;
