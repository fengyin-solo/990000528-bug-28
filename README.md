# Task Board

A lightweight Trello-like task board application built with Vue 3 and Express.

## Tech Stack

### Frontend
- Vue 3 + Vite
- Vue Router
- Pinia (state management)
- Element Plus (UI components)
- vuedraggable (drag and drop)
- Axios (HTTP client)

### Backend
- Node.js + Express
- better-sqlite3 (SQLite database)
- jsonwebtoken (JWT authentication)
- bcryptjs (password hashing)
- cors

## Project Structure

```
task-board/
├── frontend/          # Vue 3 frontend (port 5174)
│   ├── src/
│   │   ├── api/       # Axios API layer
│   │   ├── components/# Reusable Vue components
│   │   ├── router/    # Vue Router configuration
│   │   ├── stores/    # Pinia stores (auth, board)
│   │   └── views/     # Page-level components
│   └── vite.config.js
├── backend/           # Express API (port 3002)
│   ├── db/            # Database init and seed scripts
│   ├── middleware/    # Auth middleware (JWT)
│   ├── routes/       # API route handlers
│   ├── data/         # SQLite database file
│   └── server.js
└── README.md
```

## Getting Started

### Prerequisites
- Node.js 18+

### Backend Setup

```bash
cd backend
npm install
npm run seed     # Seed database with demo data
npm run dev      # Start server on port 3002
```

### Frontend Setup

```bash
cd frontend
npm install
npm run dev      # Start dev server on port 5174
```

### Demo Account

- Username: `demo`
- Password: `demo123`

The seed script creates a demo user with a sample board "My Project" containing 3 columns (To Do, In Progress, Done) and 7 sample cards.

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login (returns JWT)

### Boards
- `GET /api/boards` - List boards you own or have been granted (includes `access_level`: `owner` / `edit` / `readonly`)
- `POST /api/boards` - Create board
- `DELETE /api/boards/:id` - Delete board (owner only)

### Cross-Account Permissions & Audit
- `GET /api/permissions/me` - Effective permission view (shared boards, active grants, recent changes, conflicts)
- `GET /api/permissions/boards/:boardId` - Active grants on one owned board
- `POST /api/permissions/share` - Grant access: `{ boardId, granteeUsername, accessLevel }` (`readonly`/`edit`)
- `PUT /api/permissions/share/:boardId/:granteeId` - Change access level
- `DELETE /api/permissions/share/:boardId/:granteeId` - Revoke access
- `GET /api/permissions/audit` - Audit report payload (board ownership, read-only scope, recent permission changes)
- `GET /api/permissions/audit/export` - Download the report file (attachment)

The permission view, board list, and audit report all read from one canonical
effective-permission query: only active (`revoked_at IS NULL`) grants count,
and exactly one active grant may exist per (board, account). Revoked rows stay
in history (and in "recent changes") but never appear as current access, so the
list and report cannot disagree.

The export is guarded and atomic:
- An account with no boards/grants gets a valid **empty** report.
- Conflicting records (duplicate active grants) make the export return `409`
  **before** any file is written; the previously downloaded good report is
  kept untouched.
- The file is built completely, written to a temp file, then renamed into
  place, so a download interruption never leaves a partial/contradictory file.
- The filename is stable per account (`cross-account-audit-<id>-<user>.json`);
  repeat exports overwrite the same result instead of creating copies.

Private boards (never shared) behave exactly as before: only the owner can
open or modify them, and outsiders receive `404`.

### Columns
- `GET /api/boards/:boardId/columns` - Get columns for a board
- `POST /api/boards/:boardId/columns` - Add column
- `PUT /api/columns/:id` - Update column (rename/reorder)
- `DELETE /api/columns/:id` - Delete column

### Cards
- `GET /api/columns/:columnId/cards` - Get cards in column
- `POST /api/columns/:columnId/cards` - Add card
- `PUT /api/cards/:id` - Update card
- `DELETE /api/cards/:id` - Delete card
- `PUT /api/cards/:id/move` - Move card to another column

## Features

- User authentication with JWT
- Create and manage multiple boards
- Add, rename, and delete columns
- Create cards with title, description, priority (low/medium/high), and due date
- Drag and drop cards between columns
- Drag and drop to reorder columns
- Responsive design with Element Plus UI
