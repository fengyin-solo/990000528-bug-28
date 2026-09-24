const bcrypt = require('bcryptjs');
const { initDb } = require('./init');

function seed() {
  const db = initDb();

  // Clear existing data
  db.exec('DELETE FROM permission_events');
  db.exec('DELETE FROM board_shares');
  db.exec('DELETE FROM cards');
  db.exec('DELETE FROM columns');
  db.exec('DELETE FROM boards');
  db.exec('DELETE FROM users');

  // Create demo user
  const hashedPassword = bcrypt.hashSync('demo123', 10);
  const insertUser = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
  const userResult = insertUser.run('demo', hashedPassword);
  const userId = userResult.lastInsertRowid;
  console.log('Created demo user (id:', userId, ')');

  // Additional accounts for cross-account sharing/audit demo
  const teammateResult = insertUser.run('teammate', hashedPassword);
  const teammateId = teammateResult.lastInsertRowid;
  const guestResult = insertUser.run('guest', hashedPassword);
  const guestId = guestResult.lastInsertRowid;
  console.log('Created users: teammate (id:', teammateId, '), guest (id:', guestId, ')');

  // Create sample board
  const insertBoard = db.prepare('INSERT INTO boards (user_id, name, description) VALUES (?, ?, ?)');
  const boardResult = insertBoard.run(userId, 'My Project', 'A sample project board to get started');
  const boardId = boardResult.lastInsertRowid;
  console.log('Created board "My Project" (id:', boardId, ')');

  // Create columns
  const insertColumn = db.prepare('INSERT INTO columns (board_id, name, position) VALUES (?, ?, ?)');
  const todoResult = insertColumn.run(boardId, 'To Do', 0);
  const inProgressResult = insertColumn.run(boardId, 'In Progress', 1);
  const doneResult = insertColumn.run(boardId, 'Done', 2);

  const todoId = todoResult.lastInsertRowid;
  const inProgressId = inProgressResult.lastInsertRowid;
  const doneId = doneResult.lastInsertRowid;
  console.log('Created columns: To Do, In Progress, Done');

  // Create sample cards
  const insertCard = db.prepare(
    'INSERT INTO cards (column_id, title, description, priority, due_date, position) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const cards = [
    { colId: todoId, title: 'Set up project repository', desc: 'Initialize git repo and set up CI/CD pipeline', priority: 'high', due: '2026-06-05', pos: 0 },
    { colId: todoId, title: 'Design database schema', desc: 'Design the database schema for users, boards, columns, and cards', priority: 'high', due: '2026-06-08', pos: 1 },
    { colId: todoId, title: 'Write API documentation', desc: 'Document all REST API endpoints with examples', priority: 'low', due: '2026-06-15', pos: 2 },
    { colId: inProgressId, title: 'Implement user authentication', desc: 'Build JWT-based auth with login and register endpoints', priority: 'high', due: '2026-06-10', pos: 0 },
    { colId: inProgressId, title: 'Build frontend layout', desc: 'Create the main app layout with navbar and sidebar', priority: 'medium', due: '2026-06-12', pos: 1 },
    { colId: doneId, title: 'Project kickoff meeting', desc: 'Initial planning meeting with the team', priority: 'medium', due: '2026-05-28', pos: 0 },
    { colId: doneId, title: 'Define project requirements', desc: 'Document functional and non-functional requirements', priority: 'high', due: '2026-05-30', pos: 1 },
  ];

  cards.forEach(c => insertCard.run(c.colId, c.title, c.desc, c.priority, c.due, c.pos));
  console.log('Created', cards.length, 'sample cards');

  // Cross-account sharing demo:
  //  - teammate has ACTIVE read-only access to "My Project"
  //  - guest was granted access and later revoked (must not appear as active)
  const insertShare = db.prepare(
    'INSERT INTO board_shares (board_id, user_id, granted_by, revoked_at) VALUES (?, ?, ?, ?)'
  );
  const insertEvent = db.prepare(
    'INSERT INTO permission_events (board_id, actor_id, target_user_id, action) VALUES (?, ?, ?, ?)'
  );

  insertShare.run(boardId, teammateId, userId, null);
  insertEvent.run(boardId, userId, teammateId, 'granted');

  const revokedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  insertShare.run(boardId, guestId, userId, revokedAt);
  insertEvent.run(boardId, userId, guestId, 'granted');
  insertEvent.run(boardId, userId, guestId, 'revoked');
  console.log('Created shares: teammate (active, read-only), guest (revoked)');

  db.close();
  console.log('Seed complete!');
}

seed();
