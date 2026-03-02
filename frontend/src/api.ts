import { InspectionConfig, InspectionLine, HistoryResponse, HistoryFilters, CollectionLineInfo, CollectionStats, CollectionMode, StorageSettings, BrowseResponse } from './types'
import { API_BASE as BASE } from './config'

export async function fetchLines(): Promise<InspectionLine[]> {
  const res = await fetch(`${BASE}/api/lines`)
  if (!res.ok) throw new Error('Failed to fetch lines')
  return res.json()
}

export async function fetchLine(name: string): Promise<InspectionLine> {
  const res = await fetch(`${BASE}/api/lines/${encodeURIComponent(name)}`)
  if (!res.ok) throw new Error(`Failed to fetch line: ${name}`)
  return res.json()
}

export async function addLine(config: InspectionConfig): Promise<void> {
  const res = await fetch(`${BASE}/api/lines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function updateLine(name: string, config: InspectionConfig): Promise<void> {
  const res = await fetch(`${BASE}/api/lines/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function deleteLine(name: string): Promise<void> {
  const res = await fetch(`${BASE}/api/lines/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function startLine(name: string): Promise<void> {
  const res = await fetch(`${BASE}/api/lines/${encodeURIComponent(name)}/start`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function stopLine(name: string): Promise<void> {
  const res = await fetch(`${BASE}/api/lines/${encodeURIComponent(name)}/stop`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function resetLine(name: string): Promise<void> {
  const res = await fetch(`${BASE}/api/lines/${encodeURIComponent(name)}/reset`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function startAll(): Promise<void> {
  const res = await fetch(`${BASE}/api/lines/start-all`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
}

export async function stopAll(): Promise<void> {
  const res = await fetch(`${BASE}/api/lines/stop-all`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
}

export async function enableLine(name: string): Promise<void> {
  const res = await fetch(`${BASE}/api/lines/${encodeURIComponent(name)}/enable`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function disableLine(name: string): Promise<void> {
  const res = await fetch(`${BASE}/api/lines/${encodeURIComponent(name)}/disable`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function switchProduct(lineName: string, productName: string): Promise<{ active_product: string }> {
  const res = await fetch(`${BASE}/api/lines/${encodeURIComponent(lineName)}/product`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product: productName }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export interface WebcamDevice {
  index: string
  name: string
}

export async function fetchWebcams(): Promise<WebcamDevice[]> {
  const res = await fetch(`${BASE}/api/webcams`)
  if (!res.ok) throw new Error('Failed to scan webcams')
  return res.json()
}

export async function fetchHistory(params: {
  category?: string
  line?: string
  class_name?: string
  date?: string
  page?: number
  page_size?: number
  sort?: string
}, signal?: AbortSignal): Promise<HistoryResponse> {
  const qs = new URLSearchParams()
  if (params.category) qs.set('category', params.category)
  if (params.line) qs.set('line', params.line)
  if (params.class_name) qs.set('class_name', params.class_name)
  if (params.date) qs.set('date', params.date)
  if (params.page) qs.set('page', String(params.page))
  if (params.page_size) qs.set('page_size', String(params.page_size))
  if (params.sort) qs.set('sort', params.sort)
  const res = await fetch(`${BASE}/api/history?${qs.toString()}`, { signal })
  if (!res.ok) throw new Error('Failed to fetch history')
  return res.json()
}

export async function fetchHistoryFilters(): Promise<HistoryFilters> {
  const res = await fetch(`${BASE}/api/history/filters`)
  if (!res.ok) throw new Error('Failed to fetch history filters')
  return res.json()
}

export function historyImageUrl(url: string): string {
  return `${BASE}${url}`
}

// ── Data Collection ──────────────────────────────────────────────

export async function fetchCollectionLines(): Promise<CollectionLineInfo[]> {
  const res = await fetch(`${BASE}/api/collection/lines`)
  if (!res.ok) throw new Error('Failed to fetch collection lines')
  return res.json()
}

export async function startCollection(line_name: string): Promise<{
  status: string
  detected_mode: CollectionMode
  save_dir: string
}> {
  const res = await fetch(`${BASE}/api/collection/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line_name }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function stopCollection(line_name: string): Promise<{
  status: string
  saved_count: number
}> {
  const res = await fetch(`${BASE}/api/collection/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line_name }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function requestCollectionSave(line_name: string): Promise<{
  saved_count: number
}> {
  const res = await fetch(`${BASE}/api/collection/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line_name }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchCollectionStatus(line_name: string): Promise<CollectionStats> {
  const res = await fetch(`${BASE}/api/collection/status?line_name=${encodeURIComponent(line_name)}`)
  if (!res.ok) throw new Error('Failed to fetch collection status')
  return res.json()
}

// ── Storage Settings ────────────────────────────────────────────

export async function fetchStorageSettings(): Promise<StorageSettings> {
  const res = await fetch(`${BASE}/api/settings/storage`)
  if (!res.ok) throw new Error('Failed to fetch storage settings')
  return res.json()
}

export async function updateStorageSettings(settings: Omit<StorageSettings, 's3_sync_stats'>): Promise<void> {
  const res = await fetch(`${BASE}/api/settings/storage`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function testStorageConnection(settings: Omit<StorageSettings, 's3_sync_stats'>): Promise<{
  success: boolean
  message: string
}> {
  const res = await fetch(`${BASE}/api/settings/storage/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function triggerCleanupNow(): Promise<{ message: string }> {
  const res = await fetch(`${BASE}/api/settings/storage/cleanup`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ── Admin Auth ──────────────────────────────────────────────────

export async function verifyAdminPassword(password: string): Promise<{ success: boolean; message?: string }> {
  const res = await fetch(`${BASE}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function changeAdminPassword(currentPassword: string, newPassword: string): Promise<{ message: string }> {
  const res = await fetch(`${BASE}/api/settings/admin`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || 'Failed to change password')
  }
  return res.json()
}

// ── Storage Browser ─────────────────────────────────────────────

export async function browseLocal(path: string = ''): Promise<BrowseResponse> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await fetch(`${BASE}/api/storage/local/browse${qs}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function browseS3(prefix: string = ''): Promise<BrowseResponse> {
  const qs = prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''
  const res = await fetch(`${BASE}/api/storage/s3/browse${qs}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export function s3ImageUrl(key: string): string {
  return `${BASE}/api/storage/s3/image?key=${encodeURIComponent(key)}`
}

export function localImageUrl(path: string): string {
  return `${BASE}/api/history/image?path=${encodeURIComponent(path)}`
}

export async function deleteLocalFile(path: string): Promise<void> {
  const res = await fetch(`${BASE}/api/storage/local/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
}

export async function deleteLocalFolder(path: string): Promise<void> {
  const res = await fetch(`${BASE}/api/storage/local/folder?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
}

export async function deleteS3File(key: string): Promise<void> {
  const res = await fetch(`${BASE}/api/storage/s3/file?key=${encodeURIComponent(key)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
}

export async function deleteS3Folder(prefix: string): Promise<void> {
  const res = await fetch(`${BASE}/api/storage/s3/folder?prefix=${encodeURIComponent(prefix)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
}

// ── Layout Settings ──────────────────────────────────────────

export async function fetchLayoutSettings(): Promise<Record<string, any>> {
  const res = await fetch(`${BASE}/api/settings/layout`)
  if (!res.ok) throw new Error('Failed to fetch layout settings')
  return res.json()
}

export async function updateLayoutSettings(layout: Record<string, any>): Promise<void> {
  const res = await fetch(`${BASE}/api/settings/layout`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(layout),
  })
  if (!res.ok) throw new Error(await res.text())
}
