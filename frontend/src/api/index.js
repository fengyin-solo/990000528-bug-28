import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' }
})

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Handle 401 responses globally
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

// Auth
export const authApi = {
  register: (username, password) => api.post('/auth/register', { username, password }),
  login: (username, password) => api.post('/auth/login', { username, password })
}

// Boards
export const boardApi = {
  list: () => api.get('/boards'),
  create: (name, description) => api.post('/boards', { name, description }),
  delete: (id) => api.delete(`/boards/${id}`)
}

// Columns
export const columnApi = {
  list: (boardId) => api.get(`/boards/${boardId}/columns`),
  create: (boardId, name) => api.post(`/boards/${boardId}/columns`, { name }),
  update: (id, data) => api.put(`/columns/${id}`, data),
  delete: (id) => api.delete(`/columns/${id}`)
}

// Cards
export const cardApi = {
  list: (columnId) => api.get(`/columns/${columnId}/cards`),
  create: (columnId, data) => api.post(`/columns/${columnId}/cards`, data),
  update: (id, data) => api.put(`/cards/${id}`, data),
  delete: (id) => api.delete(`/cards/${id}`),
  move: (id, columnId, position) => api.put(`/cards/${id}/move`, { columnId, position })
}

// Cross-account permissions and audit report
export const permissionApi = {
  me: () => api.get('/permissions/me'),
  listBoardGrants: (boardId) => api.get(`/permissions/boards/${boardId}`),
  share: (boardId, granteeUsername, accessLevel) =>
    api.post('/permissions/share', { boardId, granteeUsername, accessLevel }),
  updateShare: (boardId, granteeId, accessLevel) =>
    api.put(`/permissions/share/${boardId}/${granteeId}`, { accessLevel }),
  revokeShare: (boardId, granteeId) =>
    api.delete(`/permissions/share/${boardId}/${granteeId}`),
  auditPreview: () => api.get('/permissions/audit'),
  // Returns { blob, filename, sha256 } only after the whole file has been
  // received successfully. A 409/500 refusal arrives as a JSON blob; it is
  // parsed and rejected so callers never save a contradictory file.
  auditExport: async () => {
    try {
      const res = await api.get('/permissions/audit/export', { responseType: 'blob' })
      return {
        blob: res.data,
        filename: filenameFromDisposition(res.headers['content-disposition']),
        sha256: res.headers['x-report-sha256']
      }
    } catch (err) {
      if (err.response && err.response.data instanceof Blob) {
        let payload = {}
        try { payload = JSON.parse(await err.response.data.text()) } catch { /* keep defaults */ }
        throw Object.assign(new Error(payload.error || 'Export failed'), {
          status: err.response.status,
          conflicts: payload.conflicts || []
        })
      }
      throw err
    }
  }
}

function filenameFromDisposition(disposition) {
  if (!disposition) return 'cross-account-audit.json'
  const match = /filename="?([^"]+)"?/.exec(disposition)
  return match ? match[1] : 'cross-account-audit.json'
}

export default api
