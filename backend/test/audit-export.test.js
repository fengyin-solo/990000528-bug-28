// End-to-end regression test for cross-account audit exports.
// Spawns an isolated API server (temp DB, own port), exercises share/revoke,
// empty reports, repeat-export overwrite, download interruption handling and
// conflict refusal, then verifies no contradictory files are produced.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3099;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-audit-test-'));
const BASE = `http://localhost:${PORT}`;
let failures = 0;

const Database = require('better-sqlite3');
function userId(name) {
  const db = new Database(path.join(TMP_DIR, 'taskboard.db'), { readonly: true });
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  db.close();
  return row.id;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, DB_DIR: TMP_DIR, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', d => process.stderr.write(d));
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) { clearInterval(timer); resolve(child); }
      } catch { /* server not ready yet */ }
    }, 100);
    child.on('exit', code => reject(new Error(`server exited early with ${code}`)));
  });
}

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name} ${detail}`);
  }
}

async function api(method, url, token, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function register(u, p) {
  const r = await api('POST', '/api/auth/register', null, { username: u, password: p });
  return r.data.token;
}

(async () => {
  const server = await startServer();
  try {
    await runTests();
  } finally {
    server.kill();
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('TEST ERROR', err); process.exit(2); });

async function runTests() {
  const tAlice = await register('alice', 'pass1234');
  const tBob = await register('bob', 'pass1234');
  const tCarol = await register('carol', 'pass1234');
  const tDan = await register('dan', 'pass1234');
  check('registered 4 accounts', !!(tAlice && tBob && tCarol && tDan));

  // Alice creates two boards (private)
  const b1 = (await api('POST', '/api/boards', tAlice, { name: 'Secret', description: 'private board' })).data;
  const b2 = (await api('POST', '/api/boards', tAlice, { name: 'Shared', description: 'cross account' })).data;
  check('alice created 2 boards', b1.id && b2.id);

  // Bob sees none of alice's boards
  const bobBoardsBefore = (await api('GET', '/api/boards', tBob)).data;
  check('private board invisible before share', bobBoardsBefore.length === 0, JSON.stringify(bobBoardsBefore));

  // Grant bob readonly, carol edit
  const g1 = await api('POST', '/api/permissions/share', tAlice, { boardId: b2.id, granteeUsername: 'bob', accessLevel: 'readonly' });
  const g2 = await api('POST', '/api/permissions/share', tAlice, { boardId: b2.id, granteeUsername: 'carol', accessLevel: 'edit' });
  check('granted readonly to bob', g1.status === 201);
  check('granted edit to carol', g2.status === 201);

  // cannot re-grant
  const dup = await api('POST', '/api/permissions/share', tAlice, { boardId: b2.id, granteeUsername: 'bob', accessLevel: 'edit' });
  check('duplicate grant rejected 409', dup.status === 409, String(dup.status));

  // Board list now matches permission view for bob: exactly one board, readonly
  const bobBoards = (await api('GET', '/api/boards', tBob)).data;
  check('bob sees exactly 1 board', bobBoards.length === 1, JSON.stringify(bobBoards));
  check('bob board marked readonly', bobBoards[0] && bobBoards[0].access_level === 'readonly');
  check('bob does NOT see owner-only Secret board', !bobBoards.find(b => b.id === b1.id));

  // Permission view for bob via /permissions/me
  const meBob = (await api('GET', '/api/permissions/me', tBob)).data;
  check('me view shows shared-with-me', meBob.shared_with_me.length === 1 && meBob.shared_with_me[0].access_level === 'readonly');
  check('me view does NOT show every account editable', meBob.shared_with_me.every(s => s.access_level !== 'edit' || s.grantee_username !== 'bob'));

  // Readonly bob can GET but cannot mutate
  const cols = (await api('GET', `/api/boards/${b2.id}/columns`, tBob)).data;
  check('readonly can view columns', Array.isArray(cols) && cols.length === 3);
  const addCol = await api('POST', `/api/boards/${b2.id}/columns`, tBob, { name: 'Nope' });
  check('readonly cannot add column (403)', addCol.status === 403, String(addCol.status));
  const addCard = await api('POST', `/api/columns/${cols[0].id}/cards`, tBob, { title: 'Nope' });
  check('readonly cannot add card (403)', addCard.status === 403);

  // Carol with edit access CAN add a card
  const colsC = (await api('GET', `/api/boards/${b2.id}/columns`, tCarol)).data;
  const addCardC = await api('POST', `/api/columns/${colsC[0].id}/cards`, tCarol, { title: 'Hi from carol' });
  check('edit grantee can add card (201)', addCardC.status === 201, String(addCardC.status));
  // carol cannot delete a board she does not own
  const delAttempt = await api('DELETE', `/api/boards/${b2.id}`, tCarol);
  check('edit grantee cannot delete board (404 owner-only)', delAttempt.status === 404);

  // Private board operations unchanged: bob gets 404 on alice's private board columns
  const priv = await api('GET', `/api/boards/${b1.id}/columns`, tBob);
  check('private board stays 404 to outsiders', priv.status === 404);

  // Recent changes: alice sees grant events
  const meAlice = (await api('GET', '/api/permissions/me', tAlice)).data;
  check('recent changes has 2 grant events', meAlice.recent_changes.length === 2);

  // Promote bob to edit, then revoke
  const upd = await api('PUT', `/api/permissions/share/${b2.id}/${userId('bob')}`, tAlice, { accessLevel: 'edit' });
  check('promoted bob to edit', upd.status === 200, String(upd.status));
  const bobAfterUpd = (await api('GET', '/api/permissions/me', tBob)).data;
  check('view reflects edit after update', bobAfterUpd.shared_with_me[0].access_level === 'edit');

  const rev = await api('DELETE', `/api/permissions/share/${b2.id}/${userId('bob')}`, tAlice);
  check('revoked bob', rev.status === 200);
  const bobAfterRev = (await api('GET', '/api/boards', tBob)).data;
  check('revoked board disappears from list', bobAfterRev.length === 0, JSON.stringify(bobAfterRev));
  const meBob2 = (await api('GET', '/api/permissions/me', tBob)).data;
  check('revoked grant does not linger in view', meBob2.shared_with_me.length === 0);
  // revoked cannot view
  const revView = await api('GET', `/api/boards/${b2.id}/columns`, tBob);
  check('revoked account loses access', revView.status === 404);

  // Empty report for dan: export still succeeds with a valid empty file
  const emptyExport = await api('GET', '/api/permissions/audit/export', tDan);
  check('empty report exports 200', emptyExport.status === 200, String(emptyExport.status));
  const emptyJson = typeof emptyExport.data === 'string' ? JSON.parse(emptyExport.data) : emptyExport.data;
  check('empty report is valid JSON with empty sections', emptyJson &&
    emptyJson.ownership.length === 0 &&
    emptyJson.readonly_scope.length === 0 &&
    emptyJson.edit_scope.length === 0 &&
    emptyJson.recent_permission_changes.length === 0);
  check('empty report filename stable', emptyExport.headers.get('content-disposition').includes('cross-account-audit-'));

  // Alice's report: list/report agreement + hash stability on repeat export
  const listAlice = (await api('GET', '/api/boards', tAlice)).data;
  const report1 = await api('GET', '/api/permissions/audit/export', tAlice);
  const report2 = await api('GET', '/api/permissions/audit/export', tAlice);
  check('report exports 200', report1.status === 200 && report2.status === 200);
  check('repeat export same hash (overwrite same result)', report1.headers.get('x-report-sha256') === report2.headers.get('x-report-sha256'));
  const rj = typeof report1.data === 'string' ? JSON.parse(report1.data) : report1.data;
  check('report ownership matches board list count', rj.ownership.length === listAlice.length);
  check('report lists both boards', rj.ownership.length === 2);
  const readonlyBob = rj.readonly_scope.find(s => s.grantee_username === 'bob');
  const editBob = rj.edit_scope.find(s => s.grantee_username === 'bob');
  check('revoked bob not present in readonly/edit scope', !readonlyBob && !editBob);
  const carolShare = rj.edit_scope.find(s => s.grantee_username === 'carol');
  check('carol edit scope present', carolShare && carolShare.board_id === b2.id);
  const revokeEvent = rj.recent_permission_changes.find(e => e.action === 'revoke' && e.grantee_username === 'bob');
  check('revoke recorded in recent changes', !!revokeEvent);
  const updateEvent = rj.recent_permission_changes.find(e => e.action === 'update' && e.grantee_username === 'bob');
  check('update recorded in recent changes', !!updateEvent);

  // Exactly one file per account on disk (repeat export overwrites, no copies)
  const files = fs.readdirSync(path.join(TMP_DIR, 'reports')).filter(f => f.endsWith('.json'));
  const aliceFiles = files.filter(f => f.includes('-alice.json'));
  check('single alice report file despite repeat exports', aliceFiles.length === 1, JSON.stringify(files));
  check('no leftover temp files', !files.some(f => f.includes('.tmp-')), JSON.stringify(files));

  // Conflict injection: simulate legacy bad data (index created only for new
  // writes), two active rows for the same (board, grantee).
  const db = new Database(path.join(TMP_DIR, 'taskboard.db'));
  db.exec('DROP INDEX idx_board_shares_active');
  db.prepare("INSERT INTO board_shares (board_id, grantee_id, access_level, granted_by) VALUES (?, ?, 'readonly', ?)").run(b2.id, userId('dan'), userId('alice'));
  db.prepare("INSERT INTO board_shares (board_id, grantee_id, access_level, granted_by) VALUES (?, ?, 'edit', ?)").run(b2.id, userId('dan'), userId('alice'));
  db.close();
  const conflictExport = await api('GET', '/api/permissions/audit/export', tAlice);
  check('conflict export refused 409', conflictExport.status === 409, String(conflictExport.status));
  check('conflict response names conflicts', Array.isArray(conflictExport.data.conflicts) && conflictExport.data.conflicts.length > 0);
  // The previously good alice file must still exist unchanged (no contradictory file)
  const onDisk = fs.readdirSync(path.join(TMP_DIR, 'reports')).filter(f => f.includes('-alice.json'));
  check('previous good report kept when conflict detected', onDisk.length === 1);
  const kept = JSON.parse(fs.readFileSync(path.join(path.join(TMP_DIR, 'reports'), onDisk[0]), 'utf8'));
  check('kept report has no conflicting dan grant', ![...kept.readonly_scope, ...kept.edit_scope].some(s => s.grantee_username === 'dan'));

  // Interrupted download: abort the HTTP response mid-stream. The server-side
  // file is written fully (temp + rename) before the first byte is sent, so an
  // abort must never leave a partial/contradictory report behind.
  const before = fs.readdirSync(path.join(TMP_DIR, 'reports')).filter(f => f.includes('-alice.json'));
  await new Promise((resolve) => {
    const http = require('http');
    const req = http.get(`${BASE}/api/permissions/audit/export`, {
      headers: { Authorization: `Bearer ${tAlice}` }
    }, (res) => {
      res.on('data', () => req.destroy()); // abort as soon as data flows
      res.on('end', resolve);
      res.on('error', resolve);
    });
    req.on('error', resolve);
  });
  // Give the server a moment, then verify no temp files and old file intact.
  await new Promise(r => setTimeout(r, 200));
  const after = fs.readdirSync(path.join(TMP_DIR, 'reports')).filter(f => f.includes('-alice.json'));
  check('interrupted download leaves exactly one report file', after.length === 1, JSON.stringify(after));
  check('interrupted download keeps previous file name', after[0] === before[0]);
  const allFilesAfter = fs.readdirSync(path.join(TMP_DIR, 'reports'));
  check('interrupted download leaves no temp files', !allFilesAfter.some(f => f.includes('.tmp-')), JSON.stringify(allFilesAfter));

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
}
