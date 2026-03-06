import { useState, useEffect, useRef, useCallback } from 'react'
import { Camera, Play, Square, ImageDown, Zap, Radio } from 'lucide-react'
import { CollectionLineInfo, CollectionStats, CollectionMode } from '../types'
import { WS_BASE } from '../config'
import * as api from '../api'

export default function Collection() {
  const [lines, setLines] = useState<CollectionLineInfo[]>([])
  const [selectedLine, setSelectedLine] = useState('')
  const [sessionActive, setSessionActive] = useState(false)
  const [detectedMode, setDetectedMode] = useState<CollectionMode>('continuous')
  const [stats, setStats] = useState<CollectionStats | null>(null)
  const [imgSrc, setImgSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [reconnectTick, setReconnectTick] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const sessionActiveRef = useRef(false)
  const selectedLineRef = useRef('')
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep refs in sync
  useEffect(() => { sessionActiveRef.current = sessionActive }, [sessionActive])
  useEffect(() => { selectedLineRef.current = selectedLine }, [selectedLine])

  // ── Load available lines ──────────────────────────────────────

  const loadLines = useCallback(async () => {
    try {
      const data = await api.fetchCollectionLines()
      setLines(data)
      // If a session is already active on a line, restore state
      const active = data.find(l => l.collection_active)
      if (active) {
        setSelectedLine(active.line_name)
        setSessionActive(true)
      }
    } catch { /* backend not running */ }
  }, [])

  useEffect(() => { loadLines() }, [loadLines])

  // ── WebSocket for live preview ────────────────────────────────

  useEffect(() => {
    if (!sessionActive || !selectedLine) return

    // 이미 연결 중이면 재연결 안 함
    if (wsRef.current) return

    const wsUrl = `${WS_BASE}/ws/collection/${encodeURIComponent(selectedLine)}`
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const blob = new Blob([event.data], { type: 'image/jpeg' })
        const newUrl = URL.createObjectURL(blob)
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = newUrl
        setImgSrc(newUrl)
      }
    }

    ws.onclose = () => {
      wsRef.current = null
      reconnectTimerRef.current = setTimeout(() => setReconnectTick(t => t + 1), 1000)
    }

    ws.onerror = () => ws.close()

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      ws.close()
      wsRef.current = null
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, [sessionActive, selectedLine, reconnectTick])

  // ── Stats polling ─────────────────────────────────────────────

  useEffect(() => {
    if (!sessionActive || !selectedLine) return
    const id = setInterval(async () => {
      try {
        const s = await api.fetchCollectionStatus(selectedLine)
        setStats(s)
        if (s.status === 'error' || s.status === 'stopped' || s.status === 'inactive') {
          setSessionActive(false)
          if (s.last_error) setError(s.last_error)
        }
      } catch { /* ignore */ }
    }, 1000)
    return () => clearInterval(id)
  }, [sessionActive, selectedLine])

  // ── Spacebar handler (continuous mode) ────────────────────────
  // 매 keydown마다 1장 저장 요청. 꾹 누르면 키 리피트로 연속 저장.

  useEffect(() => {
    if (!sessionActive) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault()
        if (!e.repeat) setSpaceHeld(true)
        api.requestCollectionSave(selectedLineRef.current).catch(() => {})
      }
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault()
        setSpaceHeld(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [sessionActive])

  // ── Start / Stop handlers ─────────────────────────────────────

  const handleStart = async () => {
    if (!selectedLine) return
    setLoading(true)
    setError('')
    try {
      const result = await api.startCollection(selectedLine)
      setDetectedMode(result.detected_mode)
      setSessionActive(true)
      setStats(null)
    } catch (e: any) {
      setError(e.message || 'Failed to start collection')
    } finally {
      setLoading(false)
    }
  }

  const handleStop = async () => {
    setLoading(true)
    setSpaceHeld(false)
    try {
      const result = await api.stopCollection(selectedLine)
      setSessionActive(false)
      setImgSrc(null)
      setStats(prev => prev ? { ...prev, status: 'stopped', saved_count: result.saved_count } : null)
    } catch (e: any) {
      setError(e.message || 'Failed to stop collection')
    } finally {
      setLoading(false)
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  const selectedLineInfo = lines.find(l => l.line_name === selectedLine)
  const canStart = selectedLine && !sessionActive && !loading && selectedLineInfo && !selectedLineInfo.worker_running

  return (
    <div className="h-full flex flex-col p-6 gap-5 overflow-auto" style={{ color: '#e4e4e7' }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-violet-600/20 border border-violet-500/30 rounded-lg flex items-center justify-center">
            <ImageDown size={18} className="text-violet-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white">Data Collection</h1>
            <p className="text-xs text-gray-500">Capture images from camera for AI training</p>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div
        className="border border-gray-700/50 rounded-xl p-4 flex flex-wrap items-center gap-4"
        style={{ backgroundColor: 'rgba(39,39,42,0.6)' }}
      >
        {/* Line selector */}
        <div className="flex items-center gap-2 flex-1 min-w-[240px]">
          <Camera size={14} className="text-gray-500 shrink-0" />
          <select
            value={selectedLine}
            onChange={e => setSelectedLine(e.target.value)}
            disabled={sessionActive}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white
                       focus:outline-none focus:border-blue-500 disabled:opacity-50"
          >
            <option value="">Select a line...</option>
            {lines.map(l => (
              <option key={l.line_name} value={l.line_name} disabled={l.worker_running}>
                {l.line_name}
                {l.worker_running ? ' (Inspection Running)' : ''}
                {l.collection_active ? ' (Collecting)' : ''}
                {' — ' + l.camera_type.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        {/* Start / Stop */}
        {!sessionActive ? (
          <button
            onClick={handleStart}
            disabled={!canStart || loading}
            className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium
                       bg-green-600 hover:bg-green-500 text-white
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Play size={14} />
            {loading ? 'Starting...' : 'Start'}
          </button>
        ) : (
          <button
            onClick={handleStop}
            disabled={loading}
            className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium
                       bg-red-600 hover:bg-red-500 text-white
                       disabled:opacity-40 transition-colors"
          >
            <Square size={14} />
            {loading ? 'Stopping...' : 'Stop'}
          </button>
        )}
      </div>

      {/* Warning for worker running */}
      {selectedLineInfo?.worker_running && (
        <div className="border border-amber-500/30 bg-amber-500/10 rounded-lg px-4 py-2 text-sm text-amber-400">
          Inspection worker is running on this line. Stop the worker before starting data collection.
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="border border-red-500/30 bg-red-500/10 rounded-lg px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 flex flex-col gap-4 min-h-0">
        {/* Video preview */}
        <div
          className="flex-1 border border-gray-700/50 rounded-xl overflow-hidden flex items-center justify-center relative"
          style={{ backgroundColor: 'rgba(24,24,27,0.8)', minHeight: 300 }}
        >
          {imgSrc ? (
            <img
              src={imgSrc}
              alt="Collection preview"
              className="max-w-full max-h-full object-contain"
            />
          ) : sessionActive ? (
            <div className="flex flex-col items-center gap-2 text-gray-500">
              <Camera size={40} className="opacity-30" />
              <span className="text-sm">Connecting to camera...</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-gray-500">
              <Camera size={40} className="opacity-30" />
              <span className="text-sm">Select a line and press Start</span>
            </div>
          )}

          {/* Saving indicator overlay */}
          {sessionActive && spaceHeld && detectedMode === 'continuous' && (
            <div className="absolute top-3 right-3 flex items-center gap-2 bg-red-600/90 backdrop-blur rounded-lg px-3 py-1.5">
              <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
              <span className="text-xs font-medium text-white">SAVING</span>
            </div>
          )}

          {/* FPS overlay */}
          {sessionActive && stats && stats.fps > 0 && (
            <div className="absolute top-3 left-3 bg-black/60 backdrop-blur rounded px-2 py-1">
              <span className="text-xs text-gray-300 font-mono">{stats.fps} FPS</span>
            </div>
          )}
        </div>

        {/* Status bar */}
        {sessionActive && (
          <div
            className="border border-gray-700/50 rounded-xl p-4 flex flex-wrap items-center gap-6"
            style={{ backgroundColor: 'rgba(39,39,42,0.6)' }}
          >
            {/* Mode badge */}
            <div className="flex items-center gap-2">
              {detectedMode === 'trigger' ? (
                <Zap size={14} className="text-amber-400" />
              ) : (
                <Radio size={14} className="text-blue-400" />
              )}
              <span className="text-sm font-medium">
                {detectedMode === 'trigger' ? 'Trigger Mode' : 'Continuous Mode'}
              </span>
              <span className="text-xs text-gray-500">(from line settings)</span>
            </div>

            {/* Saved count */}
            <div className="flex items-center gap-2">
              <ImageDown size={14} className="text-green-400" />
              <span className="text-sm">
                <span className="font-bold text-white">{stats?.saved_count ?? 0}</span>
                <span className="text-gray-400 ml-1">images saved</span>
              </span>
            </div>

            {/* Status */}
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${
                stats?.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-gray-500'
              }`} />
              <span className="text-sm text-gray-400 capitalize">{stats?.status ?? 'starting'}</span>
            </div>
          </div>
        )}

        {/* Spacebar instruction */}
        {sessionActive && detectedMode === 'continuous' && (
          <div
            className={`border rounded-xl p-4 text-center transition-all duration-150 select-none ${
              spaceHeld
                ? 'border-red-500/50 bg-red-500/10'
                : 'border-gray-700/50 bg-gray-800/40'
            }`}
          >
            <div className="flex items-center justify-center gap-3">
              <kbd
                className={`px-4 py-2 rounded-lg text-sm font-mono font-bold border transition-all ${
                  spaceHeld
                    ? 'bg-red-600 border-red-500 text-white scale-95'
                    : 'bg-gray-700 border-gray-600 text-gray-300'
                }`}
              >
                SPACE
              </kbd>
              <span className={`text-sm ${spaceHeld ? 'text-red-400 font-medium' : 'text-gray-400'}`}>
                {spaceHeld ? 'Saving frames...' : 'Hold spacebar to capture images'}
              </span>
            </div>
          </div>
        )}

        {/* Trigger mode info */}
        {sessionActive && detectedMode === 'trigger' && (
          <div className="border border-amber-500/20 bg-amber-500/5 rounded-xl p-4 text-center">
            <div className="flex items-center justify-center gap-2">
              <Zap size={14} className="text-amber-400" />
              <span className="text-sm text-amber-400">
                Auto-saving on each trigger signal. No action needed.
              </span>
            </div>
          </div>
        )}

        {/* Final result after stop */}
        {!sessionActive && stats && stats.saved_count > 0 && (
          <div className="border border-green-500/20 bg-green-500/5 rounded-xl p-4 text-center">
            <span className="text-sm text-green-400">
              Collection complete. <span className="font-bold">{stats.saved_count}</span> images saved to{' '}
              <code className="text-xs bg-gray-800 px-1.5 py-0.5 rounded">only_image/{selectedLine}/</code>
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
