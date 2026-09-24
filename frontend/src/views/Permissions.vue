<template>
  <div class="permissions-page">
    <div class="permissions-container">
      <div class="page-header">
        <h1>Cross-Account Access &amp; Audit</h1>
        <div class="header-actions">
          <el-button :icon="Refresh" @click="load" :loading="loading">Refresh</el-button>
          <el-button type="primary" :icon="Download" :loading="exporting" @click="handleExport">
            Download Audit Report
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="conflicts.length"
        type="error"
        :closable="false"
        show-icon
        title="Conflicting permission records detected"
        description="The audit report cannot be exported until the duplicate active grants below are resolved. No contradictory report file will be generated."
        style="margin-bottom: 20px;"
      />

      <el-tabs v-model="activeTab">
        <!-- Boards I own + grants on them -->
        <el-tab-pane label="My Boards" name="owned">
          <el-table :data="boards" v-loading="loading" empty-text="No boards owned by this account">
            <el-table-column prop="name" label="Board" min-width="160" />
            <el-table-column label="Owner" width="140">
              <template #default="{ row }">
                <el-tag v-if="row.access_level === 'owner'" type="success">{{ row.owner_username }}</el-tag>
                <el-tag v-else type="warning">shared to you ({{ row.access_level }})</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="column_count" label="Columns" width="90" />
            <el-table-column prop="card_count" label="Cards" width="80" />
            <el-table-column label="Shared accounts" min-width="200">
              <template #default="{ row }">
                <template v-if="grantsByBoard[row.id]?.length">
                  <el-tag
                    v-for="g in grantsByBoard[row.id]"
                    :key="g.id"
                    :type="g.access_level === 'edit' ? 'danger' : 'info'"
                    size="small"
                    style="margin: 2px;"
                  >
                    {{ g.grantee_username }} · {{ g.access_level }}
                  </el-tag>
                </template>
                <el-text v-else type="info" size="small">Private — no cross-account access</el-text>
              </template>
            </el-table-column>
            <el-table-column label="Manage" width="120" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-if="row.access_level === 'owner'"
                  size="small"
                  @click="openShareDialog(row)"
                >Share</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- Read-only / edit scope of accounts on boards I own -->
        <el-tab-pane label="Read-Only Scope" name="scope">
          <el-table :data="grantsOnMine" v-loading="loading" empty-text="No active cross-account grants">
            <el-table-column prop="board_name" label="Board" min-width="150" />
            <el-table-column prop="grantee_username" label="Account" width="140" />
            <el-table-column label="Access" width="120">
              <template #default="{ row }">
                <el-tag :type="row.access_level === 'edit' ? 'danger' : 'info'">{{ row.access_level }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="granted_by_username" label="Granted by" width="130" />
            <el-table-column prop="granted_at" label="Granted at" min-width="160" />
            <el-table-column label="Actions" width="200" fixed="right">
              <template #default="{ row }">
                <el-button size="small" @click="toggleLevel(row)">
                  {{ row.access_level === 'readonly' ? 'Promote to edit' : 'Set read-only' }}
                </el-button>
                <el-button size="small" type="danger" @click="revoke(row)">Revoke</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- Boards shared with me -->
        <el-tab-pane label="Shared With Me" name="incoming">
          <el-table :data="sharedWithMe" v-loading="loading" empty-text="No boards have been shared with this account">
            <el-table-column prop="board_name" label="Board" min-width="160" />
            <el-table-column prop="owner_username" label="Owner" width="140" />
            <el-table-column label="My access" width="120">
              <template #default="{ row }">
                <el-tag :type="row.access_level === 'edit' ? 'danger' : 'info'">{{ row.access_level }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="granted_at" label="Granted at" min-width="160" />
            <el-table-column label="Open" width="100" fixed="right">
              <template #default="{ row }">
                <el-button size="small" @click="$router.push(`/board/${row.board_id}`)">Open</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- Recent permission changes (audit log) -->
        <el-tab-pane label="Recent Changes" name="changes">
          <el-table :data="recentChanges" v-loading="loading" empty-text="No permission changes recorded">
            <el-table-column prop="created_at" label="When" min-width="160" />
            <el-table-column prop="board_name" label="Board" min-width="140" />
            <el-table-column prop="grantee_username" label="Account" width="130" />
            <el-table-column prop="actor_username" label="Changed by" width="130" />
            <el-table-column label="Action" width="120">
              <template #default="{ row }">
                <el-tag :type="actionType(row.action)">{{ row.action }}</el-tag>
                <el-text v-if="row.access_level" size="small" style="margin-left: 6px;">→ {{ row.access_level }}</el-text>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>

    <!-- Share dialog -->
    <el-dialog v-model="shareDialogVisible" :title="`Share “${shareForm.boardName}”`" width="440px">
      <el-form label-position="top">
        <el-form-item label="Account username">
          <el-input v-model="shareForm.username" placeholder="Username of the other account" />
        </el-form-item>
        <el-form-item label="Access level">
          <el-radio-group v-model="shareForm.accessLevel">
            <el-radio value="readonly">Read-only (can view, cannot change)</el-radio>
            <el-radio value="edit">Can edit (cannot share or delete)</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="shareDialogVisible = false">Cancel</el-button>
        <el-button type="primary" :loading="sharing" @click="confirmShare">Grant access</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Refresh } from '@element-plus/icons-vue'
import { permissionApi } from '../api/index.js'

const loading = ref(false)
const exporting = ref(false)
const sharing = ref(false)
const activeTab = ref('owned')

const boards = ref([])
const sharedWithMe = ref([])
const grantsOnMine = ref([])
const recentChanges = ref([])
const conflicts = ref([])

const shareDialogVisible = ref(false)
const shareForm = ref({ boardId: null, boardName: '', username: '', accessLevel: 'readonly' })

const grantsByBoard = computed(() => {
  const map = {}
  for (const g of grantsOnMine.value) {
    (map[g.board_id] ||= []).push(g)
  }
  return map
})

async function load() {
  loading.value = true
  try {
    const { data } = await permissionApi.me()
    boards.value = data.boards || []
    sharedWithMe.value = data.shared_with_me || []
    grantsOnMine.value = data.grants_on_mine || []
    recentChanges.value = data.recent_changes || []
    conflicts.value = data.conflicts || []
  } catch (err) {
    ElMessage.error(err.response?.data?.error || 'Failed to load permissions')
  } finally {
    loading.value = false
  }
}

function openShareDialog(board) {
  shareForm.value = { boardId: board.id, boardName: board.name, username: '', accessLevel: 'readonly' }
  shareDialogVisible.value = true
}

async function confirmShare() {
  const f = shareForm.value
  if (!f.username.trim()) {
    ElMessage.warning('Enter the other account username')
    return
  }
  sharing.value = true
  try {
    await permissionApi.share(f.boardId, f.username.trim(), f.accessLevel)
    ElMessage.success(`Access granted to ${f.username.trim()}`)
    shareDialogVisible.value = false
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || 'Failed to grant access')
  } finally {
    sharing.value = false
  }
}

async function toggleLevel(row) {
  const next = row.access_level === 'readonly' ? 'edit' : 'readonly'
  try {
    await permissionApi.updateShare(row.board_id, row.grantee_id, next)
    ElMessage.success(`Access changed to ${next}`)
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || 'Failed to change access')
  }
}

async function revoke(row) {
  try {
    await ElMessageBox.confirm(
      `Revoke ${row.access_level} access from ${row.grantee_username} for “${row.board_name}”?`,
      'Revoke access',
      { type: 'warning', confirmButtonText: 'Revoke', cancelButtonText: 'Cancel' }
    )
    await permissionApi.revokeShare(row.board_id, row.grantee_id)
    ElMessage.success('Access revoked')
    await load()
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err.response?.data?.error || 'Failed to revoke access')
  }
}

// Download only after the whole response arrived and passed server checks.
// Repeated exports use the server-provided stable filename, so the browser
// overwrites the same file instead of accumulating copies.
async function handleExport() {
  if (conflicts.value.length) {
    ElMessage.error('Resolve conflicting permission records before exporting')
    return
  }
  exporting.value = true
  try {
    const { blob, filename } = await permissionApi.auditExport()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    ElMessage.success('Audit report downloaded')
  } catch (err) {
    const detail = err.conflicts?.length ? `: ${err.conflicts.join('; ')}` : ''
    ElMessage.error(`${err.message || 'Export failed'}${detail}`)
  } finally {
    exporting.value = false
  }
}

function actionType(action) {
  return action === 'revoke' ? 'danger' : action === 'update' ? 'warning' : 'success'
}

onMounted(load)
</script>

<style scoped>
.permissions-page {
  padding: 30px;
}

.permissions-container {
  max-width: 1200px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.page-header h1 {
  font-size: 24px;
  color: #303133;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 10px;
}
</style>
