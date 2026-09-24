const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const permissions = require('../services/permissions');

const router = express.Router();

// All board routes require authentication
router.use(authMiddleware);

// GET /api/boards - List boards the user can access (owned + shared).
// Uses the same canonical query as the audit report, so the board list and a
// downloaded report can never disagree.
router.get('/', (req, res) => {
  const db = getDb();
  try {
    const boards = permissions.listAccessibleBoards(db, req.user.id);
    db.close();
    res.json(boards);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to fetch boards' });
  }
});

// POST /api/boards - Create board
router.post('/', (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Board name is required' });
  }

  const db = getDb();
  try {
    const result = db.prepare('INSERT INTO boards (user_id, name, description) VALUES (?, ?, ?)').run(
      req.user.id,
      name.trim(),
      description || ''
    );
    const boardId = result.lastInsertRowid;

    // Create default columns
    const insertCol = db.prepare('INSERT INTO columns (board_id, name, position) VALUES (?, ?, ?)');
    insertCol.run(boardId, 'To Do', 0);
    insertCol.run(boardId, 'In Progress', 1);
    insertCol.run(boardId, 'Done', 2);

    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
    db.close();
    res.status(201).json(board);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to create board' });
  }
});

// DELETE /api/boards/:id - Delete board
router.delete('/:id', (req, res) => {
  const db = getDb();
  try {
    const board = db.prepare('SELECT * FROM boards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!board) {
      db.close();
      return res.status(404).json({ error: 'Board not found' });
    }

    db.prepare('DELETE FROM boards WHERE id = ?').run(req.params.id);
    db.close();
    res.json({ message: 'Board deleted' });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to delete board' });
  }
});

module.exports = router;
