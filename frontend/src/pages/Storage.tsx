import { useCallback, useEffect, useState } from 'react'
import {
  HardDrive, Cloud, Settings, FolderOpen, ChevronRight,
  Folder, Image, FileText, File, Trash2, Loader2, RefreshCw,
  X, ArrowLeft, AlertTriangle, Lock,
} from 'lucide-react'
import {
  browseLocal, browseS3, localImageUrl, s3ImageUrl,
  deleteLocalFile, deleteLocalFolder, deleteS3File, deleteS3Folder,
  fetchStorageSettings,
} from '../api'
import type { BrowseItem, StorageType } from '../types'
import S3ConfigModal from '../components/S3ConfigModal'
import { useAuth } from '../contexts/AuthContext'

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString([], { month: '2-digit', day: '2-digit', year: '2-digit' })
  } catch {
    return '—'
  }
}

function isImageFile(name: string): boolean {
  return /\.(jpg|jpeg|png|bmp|tiff|webp)$/i.test(name)
}

function fileIcon(item: BrowseItem) {
  if (item.type === 'folder') return <Folder size={16} className="text-blue-400" />
  if (isImageFile(item.name)) return <Image size={16} className="text-green-400" />
  if (item.name.endsWith('.txt')) return <FileText size={16} className="text-yellow-400" />
  return <File size={16} className="text-gray-400" />
}

export default function Storage() {
  const { requireAdmin, isAdminAuthenticated } = useAuth()
  const [activeSource, setActiveSource] = useState<'local' | 's3'>('local')
  const [currentPath, setCurrentPath] = useState('')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [saveRoot, setSaveRoot] = useState<string | null>(null)
  const [items, setItems] = useState<BrowseItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)

  // S3 status
  const [s3Configured, setS3Configured] = useState(false)
  const [s3Bucket, setS3Bucket] = useState('')
  const [storageType, setStorageType] = useState<StorageType>('local')

  // Modals
  const [s3ConfigOpen, setS3ConfigOpen] = useState(false)
  const [previewItem, setPreviewItem] = useState<BrowseItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BrowseItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Load S3 status
  const loadS3Status = useCallback(() => {
    fetchStorageSettings()
      .then(s => {
        setS3Configured(!!s.s3_bucket)
        setS3Bucket(s.s3_bucket)
        setStorageType(s.storage_type)
      })
      .catch(() => {})
  }, [])

  useEffect(() => { loadS3Status() }, [loadS3Status])

  // Browse
  const browse = useCallback(async (source: 'local' | 's3', path: string) => {
    setLoading(true)
    setError('')
    try {
      const res = source === 'local' ? await browseLocal(path) : await browseS3(path)
      setItems(res.items)
      setCurrentPath(res.current_path)
      setParentPath(res.parent_path)
      setSaveRoot(res.save_root ?? null)
      setTruncated(res.truncated)
    } catch (e: any) {
      setError(e.message || 'Failed to browse')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load & source switch
  useEffect(() => {
    browse(activeSource, '')
  }, [activeSource, browse])

  const handleNavigate = (item: BrowseItem) => {
    if (item.type === 'folder') {
      browse(activeSource, item.path)
    } else if (isImageFile(item.name)) {
      setPreviewItem(item)
    }
  }

  const handleGoUp = () => {
    if (parentPath !== null) {
      browse(activeSource, parentPath)
    }
  }

  const handleRefresh = () => {
    browse(activeSource, currentPath)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      if (activeSource === 'local') {
        if (deleteTarget.type === 'folder') {
          await deleteLocalFolder(deleteTarget.path)
        } else {
          await deleteLocalFile(deleteTarget.path)
        }
      } else {
        if (deleteTarget.type === 'folder') {
          await deleteS3Folder(deleteTarget.path)
        } else {
          await deleteS3File(deleteTarget.path)
        }
      }
      setDeleteTarget(null)
      browse(activeSource, currentPath)
    } catch (e: any) {
      setError(e.message || 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  const switchSource = (src: 'local' | 's3') => {
    if (src === activeSource) return
    setActiveSource(src)
    setCurrentPath('')
    setParentPath(null)
    setSaveRoot(null)
    setItems([])
    setError('')
  }

  // Breadcrumb segments
  const breadcrumbs = (() => {
    if (!currentPath) return []
    if (activeSource === 'local') {
      // saveRoot가 있으면: "worker-02/data" 라벨로 시작, 그 이하 세그먼트만 추가
      if (saveRoot && currentPath.startsWith(saveRoot)) {
        const rootParts = saveRoot.replace(/\\/g, '/').split('/').filter(Boolean)
        const rootLabel = rootParts.length >= 2
          ? `${rootParts[rootParts.length - 2]}/${rootParts[rootParts.length - 1]}`
          : rootParts[rootParts.length - 1] ?? saveRoot
        const relativePath = currentPath.slice(saveRoot.length).replace(/^[/\\]/, '')
        const subParts = relativePath ? relativePath.split('/').filter(Boolean) : []
        const segs: { label: string; path: string }[] = [
          { label: rootLabel, path: saveRoot }
        ]
        for (let i = 0; i < subParts.length; i++) {
          segs.push({
            label: subParts[i],
            path: saveRoot + '/' + subParts.slice(0, i + 1).join('/'),
          })
        }
        return segs
      }
      // saveRoot 없는 경우 (일반 폴더) — fallback
      const parts = currentPath.split('/').filter(Boolean)
      const segs: { label: string; path: string }[] = []
      for (let i = 0; i < parts.length; i++) {
        segs.push({
          label: parts[i],
          path: '/' + parts.slice(0, i + 1).join('/'),
        })
      }
      return segs
    } else {
      // S3 prefix-based
      const parts = currentPath.replace(/\/$/, '').split('/')
      const segs: { label: string; path: string }[] = []
      for (let i = 0; i < parts.length; i++) {
        if (!parts[i]) continue
        segs.push({
          label: parts[i],
          path: parts.slice(0, i + 1).join('/') + '/',
        })
      }
      return segs
    }
  })()

  const previewUrl = previewItem
    ? activeSource === 'local'
      ? localImageUrl(previewItem.path)
      : s3ImageUrl(previewItem.path)
    : ''

  if (!isAdminAuthenticated) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <div className="w-16 h-16 rounded-full bg-gray-800 flex items-center justify-center">
          <Lock size={28} className="text-gray-500" />
        </div>
        <h2 className="text-base font-medium text-white">Storage Browser</h2>
        <p className="text-sm text-gray-500">Admin password required to access this page</p>
        <button
          onClick={() => requireAdmin(() => {})}
          className="px-5 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          Unlock
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-700/40 shrink-0">
        <div className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center">
          <FolderOpen size={18} className="text-gray-400" />
        </div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-white">Storage Browser</h1>
          <p className="text-xs text-gray-500">Browse and manage stored files</p>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* ── Left Panel ───────────────────────────────────────── */}
        <div className="w-48 shrink-0 border-r border-gray-700/40 flex flex-col p-3 gap-2">
          {/* Local Card */}
          <button
            onClick={() => switchSource('local')}
            className={`flex flex-col items-center gap-1.5 p-4 rounded-xl border-2 transition-all ${
              activeSource === 'local'
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-gray-700 bg-gray-800/60 hover:border-gray-600'
            }`}
          >
            <HardDrive size={22} className={activeSource === 'local' ? 'text-blue-400' : 'text-gray-500'} />
            <span className={`text-sm font-medium ${activeSource === 'local' ? 'text-blue-400' : 'text-gray-300'}`}>
              Local
            </span>
            <span className="text-xs text-gray-500">Local disk</span>
          </button>

          {/* S3 Card */}
          <button
            onClick={() => {
              if (!s3Configured) { setS3ConfigOpen(true); return }
              switchSource('s3')
            }}
            className={`flex flex-col items-center gap-1.5 p-4 rounded-xl border-2 transition-all ${
              activeSource === 's3'
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-gray-700 bg-gray-800/60 hover:border-gray-600'
            }`}
          >
            <Cloud size={22} className={activeSource === 's3' ? 'text-blue-400' : 'text-gray-500'} />
            <span className={`text-sm font-medium ${activeSource === 's3' ? 'text-blue-400' : 'text-gray-300'}`}>
              AWS S3
            </span>
            <span className="text-xs text-gray-500 truncate w-full text-center">
              {s3Configured ? s3Bucket : 'Not configured'}
            </span>
            {s3Configured && storageType === 's3' && (
              <span className="flex items-center gap-1 text-xs text-green-400">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                Active
              </span>
            )}
          </button>

          {/* Config Button */}
          <button
            onClick={() => setS3ConfigOpen(true)}
            className="flex items-center justify-center gap-2 mt-1 px-3 py-2 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          >
            <Settings size={14} />
            Config
          </button>
        </div>

        {/* ── Right Panel ──────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Toolbar: Breadcrumb + Actions */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-700/40 shrink-0 min-h-[44px]">
            {/* Back */}
            <button
              onClick={handleGoUp}
              disabled={parentPath === null && !currentPath}
              className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Go up"
            >
              <ArrowLeft size={16} />
            </button>

            {/* Breadcrumb */}
            <div className="flex items-center gap-1 flex-1 overflow-x-auto text-sm min-w-0">
              <button
                onClick={() => browse(activeSource, '')}
                className="text-gray-400 hover:text-blue-400 shrink-0 transition-colors"
              >
                {activeSource === 'local' ? 'Local' : 'S3'}
              </button>
              {breadcrumbs.map((seg, i) => (
                <span key={seg.path} className="flex items-center gap-1 shrink-0">
                  <ChevronRight size={12} className="text-gray-600" />
                  {i === breadcrumbs.length - 1 ? (
                    <span className="text-white font-medium">{seg.label}</span>
                  ) : (
                    <button
                      onClick={() => browse(activeSource, seg.path)}
                      className="text-gray-400 hover:text-blue-400 transition-colors"
                    >
                      {seg.label}
                    </button>
                  )}
                </span>
              ))}
            </div>

            {/* Refresh */}
            <button
              onClick={handleRefresh}
              className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
              title="Refresh"
            >
              <RefreshCw size={14} />
            </button>
          </div>

          {/* File List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="animate-spin text-gray-500" size={24} />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2">
                <AlertTriangle size={24} className="text-red-400" />
                <p className="text-sm text-red-400">{error}</p>
                <button onClick={handleRefresh}
                        className="text-xs text-gray-400 hover:text-white mt-2">
                  Try again
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-500">
                <FolderOpen size={32} />
                <p className="text-sm">This directory is empty</p>
              </div>
            ) : (
              <>
                {truncated && (
                  <div className="px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20 text-xs text-yellow-400">
                    Showing first 1,000 items. Some entries may be hidden.
                  </div>
                )}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700/30">
                      <th className="text-left px-4 py-2 font-medium">Name</th>
                      <th className="text-right px-3 py-2 font-medium w-24">Size</th>
                      <th className="text-right px-3 py-2 font-medium w-28">Modified</th>
                      <th className="w-12 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr
                        key={item.path}
                        className="border-b border-gray-800/40 hover:bg-gray-800/40 transition-colors group"
                      >
                        <td className="px-4 py-2">
                          <button
                            onClick={() => handleNavigate(item)}
                            className={`flex items-center gap-2 text-left w-full ${
                              item.type === 'folder'
                                ? 'text-blue-300 hover:text-blue-200'
                                : isImageFile(item.name)
                                ? 'text-gray-200 hover:text-white cursor-pointer'
                                : 'text-gray-400 cursor-default'
                            }`}
                          >
                            {fileIcon(item)}
                            <span className="truncate">{item.name}</span>
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right text-gray-500">
                          {formatSize(item.size)}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-500">
                          {formatDate(item.modified)}
                        </td>
                        <td className="px-2 py-2">
                          <button
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget(item) }}
                            className="p-1 rounded text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                            title="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── S3 Config Modal ─────────────────────────────────── */}
      <S3ConfigModal
        open={s3ConfigOpen}
        onClose={() => setS3ConfigOpen(false)}
        onSaved={loadS3Status}
      />

      {/* ── Image Preview Modal ────────────────────────────── */}
      {previewItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
             onClick={() => setPreviewItem(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl max-w-7xl w-full mx-4 max-h-[90vh] flex flex-col"
               onClick={e => e.stopPropagation()}>
            {/* Header — breadcrumb path */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700/50 shrink-0">
              <div className="flex items-center gap-2 min-w-0 flex-1 overflow-x-auto text-sm">
                <FolderOpen size={16} className="text-gray-400 shrink-0" />
                <button
                  onClick={() => browse(activeSource, '')}
                  className="text-gray-400 hover:text-blue-400 shrink-0 transition-colors"
                >
                  {activeSource === 'local' ? 'Local' : 'S3'}
                </button>
                {breadcrumbs.map((seg, i) => (
                  <span key={seg.path} className="flex items-center gap-1 shrink-0">
                    <ChevronRight size={12} className="text-gray-600" />
                    {i === breadcrumbs.length - 1 ? (
                      <span className="text-white font-medium">{seg.label}</span>
                    ) : (
                      <button
                        onClick={() => browse(activeSource, seg.path)}
                        className="text-gray-400 hover:text-blue-400 transition-colors"
                      >
                        {seg.label}
                      </button>
                    )}
                  </span>
                ))}
              </div>
              <button onClick={() => setPreviewItem(null)} className="p-1 text-gray-500 hover:text-white shrink-0 ml-3">
                <X size={18} />
              </button>
            </div>

            {/* Body — 4:6 split */}
            <div className="flex-1 flex overflow-hidden min-h-0">
              {/* Left: file list (40%) */}
              <div className="w-2/5 border-r border-gray-700/50 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-900 z-10">
                    <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700/30">
                      <th className="text-left px-3 py-2 font-medium">Name</th>
                      <th className="text-right px-2 py-2 font-medium w-20">Size</th>
                      <th className="text-right px-2 py-2 font-medium w-24">Modified</th>
                      <th className="w-10 px-1 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr
                        key={item.path}
                        className={`border-b border-gray-800/40 hover:bg-gray-800/40 transition-colors group ${
                          item.path === previewItem.path ? 'bg-blue-500/10' : ''
                        }`}
                      >
                        <td className="px-3 py-1.5">
                          <button
                            onClick={() => {
                              if (item.type === 'folder') {
                                browse(activeSource, item.path)
                              } else if (isImageFile(item.name)) {
                                setPreviewItem(item)
                              }
                            }}
                            className={`flex items-center gap-2 text-left w-full ${
                              item.type === 'folder'
                                ? 'text-blue-300 hover:text-blue-200'
                                : isImageFile(item.name)
                                ? 'text-gray-200 hover:text-white cursor-pointer'
                                : 'text-gray-400 cursor-default'
                            }`}
                          >
                            {fileIcon(item)}
                            <span className="truncate text-xs">{item.name}</span>
                          </button>
                        </td>
                        <td className="px-2 py-1.5 text-right text-gray-500 text-xs">
                          {formatSize(item.size)}
                        </td>
                        <td className="px-2 py-1.5 text-right text-gray-500 text-xs">
                          {formatDate(item.modified)}
                        </td>
                        <td className="px-1 py-1.5">
                          <button
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget(item) }}
                            className="p-1 rounded text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Right: image preview (60%) */}
              <div className="w-3/5 flex items-center justify-center p-4 overflow-auto">
                <img
                  src={previewUrl}
                  alt={previewItem.name}
                  className="max-w-full max-h-[75vh] object-contain rounded"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none'
                  }}
                />
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 py-2.5 border-t border-gray-700/50 flex items-center gap-4 text-xs text-gray-500 shrink-0">
              <Image size={14} className="text-green-400 shrink-0" />
              <span className="text-white font-medium truncate">{previewItem.name}</span>
              <span>{formatSize(previewItem.size)}</span>
              <span>{formatDate(previewItem.modified)}</span>
              <span className="truncate flex-1 text-right font-mono">{previewItem.path}</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirm Modal ───────────────────────────── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
             onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="bg-[#2c313a] border border-gray-700/50 rounded-xl shadow-2xl w-full max-w-sm mx-4 p-5"
               onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-white mb-2">
              Delete {deleteTarget.type === 'folder' ? 'Folder' : 'File'}?
            </h3>
            <p className="text-xs text-gray-400 mb-4">
              Are you sure you want to delete <span className="text-white font-medium">"{deleteTarget.name}"</span>?
              {deleteTarget.type === 'folder' && ' All contents will be removed.'}
              {' '}This cannot be undone.
            </p>
            <div className="flex items-center gap-3 justify-end">
              <button onClick={() => setDeleteTarget(null)} disabled={deleting}
                      className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
                Cancel
              </button>
              <button onClick={handleDelete} disabled={deleting}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50">
                {deleting && <Loader2 size={14} className="animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
