import { useEffect, useRef, useState } from 'react'
import { Camera, Play, Square, Settings, AlertTriangle, Loader2, GripVertical, X } from 'lucide-react'
import { InspectionLine } from '../types'
import { WS_BASE } from '../config'
import StatusBadge from './StatusBadge'

interface RejectMeta {
  reject_window_size: number
  reject_window_marks: number[]
}

// ── 정규식 ↔ 화면 표시 변환 ───────────────────────────────────────────────
/** 파일 형식 (정규식): "2026\\.06\\.03" → 화면 표시: "2026.06.03" */
const displayFormat = (regexStr: string): string => {
  if (!regexStr) return ''
  // \\ 을 . 로 변환 (마크다운 이스케이프 표시 제거)
  return regexStr.replace(/\\\./g, '.')
}

/** 화면 표시: "2026.06.03" → 파일 형식 (정규식): "2026\\.06\\.03" */
const regexFormat = (displayStr: string): string => {
  if (!displayStr) return ''
  // . 을 \\ 로 변환 (마크다운 이스케이프 추가)
  return displayStr.replace(/\./g, '\\.')
}

interface Props {
  line: InspectionLine
  onToggle: (lineName: string) => void
  onSettings: (line: InspectionLine) => void
  onSwitchProduct?: (lineName: string, productName: string) => void
  onUpdateThreshold?: (lineName: string, productName: string, className: string, newValue: number) => void
  onUpdateDetectorConfig?: (lineName: string, productName: string, config: Record<string, any>) => void
  editMode?: boolean
  gridSize?: { w: number; h: number }
}

export default function CameraCard({ line, onToggle, onSettings, onSwitchProduct, onUpdateThreshold, onUpdateDetectorConfig, editMode = false, gridSize }: Props) {
  const { config, stats } = line
  const isRunning = stats.status === 'running'
  const isInitializing = stats.status === 'initializing'
  const isActive = isRunning || isInitializing
  const isError = stats.status === 'error'

  const [imgSrc, setImgSrc] = useState<string | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [reconnectTick, setReconnectTick] = useState(0)
  const [isVisible, setIsVisible] = useState(true) // Intersection Observer로 관리
  // WebSocket으로 수신한 최신 window 상태 (프레임마다 업데이트)
  const [rejectMeta, setRejectMeta] = useState<RejectMeta>({
    reject_window_size: stats.reject_window_size ?? 0,
    reject_window_marks: stats.reject_window_marks ?? [],
  })
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [showThresholdPanel, setShowThresholdPanel] = useState(false)

  // 로컬 임계값 상태 (낙관적 업데이트용)
  const activeProductConfig = config.products?.[config.active_product ?? '']
  const sourceThresholds = activeProductConfig?.class_thresholds ?? config.class_thresholds
  const [localThresholds, setLocalThresholds] = useState<Record<string, number>>(sourceThresholds ?? {})

  // OCR 설정 편집 상태
  const [ocrConfig, setOcrConfig] = useState<Record<string, any>>(
    activeProductConfig?.detector_config ?? config.detector_config ?? {}
  )
  // 화면 표시용: 정규식 형식을 간단하게 변환
  const [editingChangeDate, setEditingChangeDate] = useState<string>(
    displayFormat(ocrConfig.change_date ?? '')
  )

  // 워커 시작 시 드롭다운 자동 닫기
  useEffect(() => {
    if (isActive) setShowProductDropdown(false)
  }, [isActive])

  // Intersection Observer: 화면에 보이는 카메라만 스트리밍
  // (스크롤할 때 보이지 않는 카메라의 WebSocket을 종료해 대역폭 절약)
  useEffect(() => {
    if (!cardRef.current) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting)
      },
      { threshold: 0.1 } // 카드의 10% 이상이 보이면 visible
    )

    observer.observe(cardRef.current)

    return () => {
      observer.disconnect()
    }
  }, [])

  // config 갱신 시 로컬 임계값 동기화 (실제 변경이 있을 때만)
  useEffect(() => {
    const src = config.products?.[config.active_product ?? '']?.class_thresholds
      ?? config.class_thresholds
    const newThresholds = src ?? {}

    // 실제로 값이 변경되었을 때만 업데이트 (불필요한 리셋 방지)
    if (JSON.stringify(newThresholds) !== JSON.stringify(localThresholds)) {
      setLocalThresholds(newThresholds)
    }
  }, [config.active_product, config.products, config.class_thresholds, localThresholds])

  // OCR 설정 동기화 (detector_config가 변경될 때만)
  useEffect(() => {
    const newOcrConfig = activeProductConfig?.detector_config ?? config.detector_config ?? {}
    if (JSON.stringify(newOcrConfig) !== JSON.stringify(ocrConfig)) {
      setOcrConfig(newOcrConfig)
    }
  }, [config.active_product, config.products, config.detector_config, activeProductConfig])

  // Change Date 표시 동기화 (ocrConfig.change_date가 변경될 때)
  useEffect(() => {
    const newDisplayFormat = displayFormat(ocrConfig.change_date ?? '')
    if (newDisplayFormat !== editingChangeDate) {
      setEditingChangeDate(newDisplayFormat)
    }
  }, [ocrConfig.change_date])

  const urlRef = useRef<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // 정지/에러 상태이거나 화면에 안 보이면 스트림 정리
    if (!isActive || !isVisible) {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
      setImgSrc(null)
      setWsConnected(false)
      setRejectMeta({ reject_window_size: 0, reject_window_marks: [] })
      return
    }

    // 이미 연결 중이면 재연결 안 함
    if (wsRef.current) return

    const ws = new WebSocket(`${WS_BASE}/ws/${encodeURIComponent(config.line_name)}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => setWsConnected(true)

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const blob = new Blob([event.data], { type: 'image/jpeg' })
        const newUrl = URL.createObjectURL(blob)
        if (urlRef.current) URL.revokeObjectURL(urlRef.current)
        urlRef.current = newUrl
        setImgSrc(newUrl)
      } else {
        try {
          const meta: RejectMeta = JSON.parse(event.data as string)
          setRejectMeta(meta)
        } catch {
          // JSON 파싱 실패 시 무시
        }
      }
    }

    ws.onclose = () => {
      setWsConnected(false)
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
      setWsConnected(false)
    }
  }, [isActive, isVisible, config.line_name, reconnectTick])

  const { reject_window_size: winSize, reject_window_marks: winMarks } = rejectMeta
  const isRejectActive = winMarks && winMarks.length > 0

  const borderColor = editMode
    ? 'border-blue-500/50'
    : isRejectActive
    ? 'border-red-500 border-2'
    : isError
    ? 'border-red-500/20'
    : 'border-gray-600/50 hover:border-gray-500/70'
  const rejectPositions = config.reject_positions ?? 1
  // 실행 중일 때만 바 표시. collection 모드 등 winSize=0이면 config 값으로 폴백.
  const displayWinSize = isRunning
    ? (winSize > 0 ? winSize : config.reject_delay_frames)
    : 0

  const handleThresholdChange = (className: string, delta: number) => {
    const current = localThresholds[className] ?? 0.5
    const next = Math.round((current + delta) * 100) / 100  // 부동소수점 오차 방지
    const clamped = Math.max(0, Math.min(1, next))

    setLocalThresholds(prev => ({ ...prev, [className]: clamped }))  // 낙관적 업데이트
    if (config.active_product) {
      onUpdateThreshold?.(config.line_name, config.active_product, className, clamped)
    }
  }

  return (
    <div
      ref={cardRef}
      className={`h-full flex flex-col border rounded-xl overflow-hidden transition-colors ${borderColor}`}
      style={{ backgroundColor: 'rgba(44,49,58,1.0)', backdropFilter: 'blur(12px)' }}
    >
      {/* 카메라 피드 영역 — flex-1로 남은 공간 모두 사용 */}
      <div
        className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden"
        style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
      >
        {isActive ? (
          <>
            {imgSrc ? (
              <img
                src={imgSrc}
                alt="live feed"
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="text-center">
                <Loader2 size={28} className="text-gray-600 mx-auto mb-2 animate-spin" />
                <p className="text-xs text-gray-600">
                  {isInitializing
                    ? stats.init_stage === 'Streaming'
                      ? 'Streaming started'
                      : `Initializing${stats.init_stage ? ` (${stats.init_stage})` : ''}...`
                    : wsConnected ? 'Waiting for frames…' : 'Connecting…'}
                </p>
                {isInitializing && (stats.init_total ?? 0) > 0 && (
                  <div className="mt-2 w-32 mx-auto">
                    <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-amber-500 transition-all duration-300"
                        style={{ width: `${((stats.init_current ?? 0) / stats.init_total!) * 100}%` }}
                      />
                    </div>
                    <p className="text-[10px] text-gray-700 mt-1">
                      Step {stats.init_current}/{stats.init_total}
                    </p>
                  </div>
                )}
              </div>
            )}
            {/* FPS 오버레이 — running 상태에서만 */}
            {isRunning && (
              <div className="absolute top-2 right-2 bg-black/60 rounded px-2 py-0.5 text-xs text-gray-300 font-mono">
                {stats.fps > 0 ? `${stats.fps} FPS` : '— FPS'}
              </div>
            )}
          </>
        ) : isError ? (
          <div className="text-center px-4">
            <AlertTriangle size={32} className="text-red-500/50 mx-auto mb-2" />
            <p className="text-xs text-red-400/70 line-clamp-3">{stats.last_error}</p>
          </div>
        ) : (
          <div className="text-center">
            <Camera size={36} className="text-gray-800 mx-auto mb-2" />
            <p className="text-xs text-gray-700">Offline</p>
          </div>
        )}

        {/* 편집 모드 오버레이 */}
        {editMode && (
          <div className="absolute inset-0 bg-blue-500/5 flex items-center justify-center pointer-events-none">
            <div className="bg-black/50 rounded-lg px-3 py-1.5 flex items-center gap-1.5">
              <GripVertical size={14} className="text-blue-400" />
              <span className="text-xs text-blue-300 font-medium">Drag to move</span>
            </div>
            {gridSize && (
              <div className="absolute bottom-2 right-2 bg-black/60 rounded px-2 py-0.5">
                <span className="text-[10px] text-blue-300/80 font-mono">{gridSize.w}×{gridSize.h}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 리젝트 슬라이딩 윈도우 바 — WebSocket으로 프레임마다 업데이트 */}
      {displayWinSize > 0 && (
        <div
          className="shrink-0 px-2 pt-1.5 pb-1"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
        >
          <div
            className="relative w-full rounded-sm overflow-hidden"
            style={{ height: 8, backgroundColor: 'rgba(255,255,255,0.1)' }}
          >
            {/* 체크 구역 배경 (뒤쪽 N칸) — 최소 10px 보장 */}
            <div
              className="absolute top-0 right-0 h-full"
              style={{
                width: `calc(max(10px, ${(rejectPositions / displayWinSize) * 100}%))`,
                backgroundColor: 'rgba(251,191,36,0.18)',
                borderLeft: '1px solid rgba(251,191,36,0.4)',
              }}
            />
            {/* 불량 마킹 — 1의 위치 개수만큼만 DOM 요소 생성 */}
            {winMarks.map(idx => (
              <div
                key={idx}
                className="absolute top-0 h-full"
                style={{
                  left: `${(idx / displayWinSize) * 100}%`,
                  width: `${(1 / displayWinSize) * 100}%`,
                  minWidth: 2,
                  backgroundColor: '#ef4444',
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* 카드 본문 — 편집 모드일 때 버튼 클릭 차단 */}
      <div className="p-4 shrink-0" style={{ pointerEvents: editMode ? 'none' : 'auto' }}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-semibold text-sm text-white truncate pr-2">{config.project_name || config.line_name}</h3>
          <div className="flex items-center gap-2 shrink-0">
            {/* Threshold/Change Date 버튼 — 제품 드롭다운 왼쪽 */}
            <button
              onClick={() => setShowThresholdPanel(true)}
              disabled={isActive}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors border ${
                isActive
                  ? 'opacity-50 cursor-not-allowed text-gray-600 border-gray-700/40'
                  : 'text-amber-600/70 hover:text-amber-500 hover:bg-amber-500/10 border-amber-500/20 hover:border-amber-500/40'
              }`}
              title={isActive ? 'Disabled while running' : (activeProductConfig?.detector_type === 'paddleocr' ? 'Change Date Pattern' : 'Adjust Thresholds')}
            >
              <Settings size={13} />
              <span>{activeProductConfig?.detector_type === 'paddleocr' ? 'Change Date' : 'Threshold'}</span>
            </button>

            {/* Active Product Selector — 우측 상단 */}
            {config.active_product && config.products && Object.keys(config.products).length > 1 ? (
              <div className="relative">
                <button
                  onClick={() => !isActive && setShowProductDropdown(v => !v)}
                  disabled={isActive}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                    isActive
                      ? 'bg-gray-500/15 text-gray-500 border-gray-500/30 cursor-not-allowed'
                      : 'bg-blue-500/15 text-blue-400 border-blue-500/30 hover:bg-blue-500/25'
                  }`}
                >
                  {config.active_product}
                  <svg width="10" height="6" viewBox="0 0 10 6" className="ml-0.5">
                    <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
                  </svg>
                </button>
                {showProductDropdown && (
                  <div className="absolute top-full right-0 mt-1 z-20 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[140px]">
                    {Object.keys(config.products).map(pName => (
                      <button
                        key={pName}
                        onClick={() => {
                          onSwitchProduct?.(config.line_name, pName)
                          setShowProductDropdown(false)
                        }}
                        className={`w-full text-left px-3 py-2 text-xs font-medium transition-colors ${
                          pName === config.active_product
                            ? 'text-blue-400 bg-blue-500/10'
                            : 'text-gray-300 hover:bg-gray-700'
                        }`}
                      >
                        {pName}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : config.active_product ? (
              <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/30">
                {config.active_product}
              </span>
            ) : null}
            <StatusBadge status={stats.status} />
          </div>
        </div>

        <p className="text-xs text-gray-600 font-mono mb-3">
          {config.camera_type === 'webcam'
            ? `Webcam #${config.camera_ip}`
            : config.camera_ip}
        </p>

        {/* 액션 버튼 */}
        <div className="flex gap-2">
          {/* Start/Stop 버튼 — Edit Layout 모드에서 숨김 */}
          {!editMode && (
            <button
              onClick={() => onToggle(config.line_name)}
              disabled={isInitializing}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                isInitializing
                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20 opacity-60 cursor-not-allowed'
                  : isRunning
                  ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20'
                  : isError
                  ? 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/20'
                  : 'bg-green-500/10 text-green-400 hover:bg-green-500/20 border border-green-500/20'
              }`}
            >
              {isActive ? <Square size={12} /> : <Play size={12} />}
              {isInitializing ? 'Starting...' : isRunning ? 'Stop' : isError ? 'Retry' : 'Start'}
            </button>
          )}
          <button
            onClick={() => onSettings(line)}
            className="p-1.5 rounded-lg text-gray-600 hover:text-gray-300 hover:bg-gray-800 transition-colors border border-gray-800"
            title="Settings"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {/* 임계값/날짜 조절 패널 모달 */}
      {showThresholdPanel && (activeProductConfig?.detector_type === 'paddleocr' || Object.keys(localThresholds).length > 0) && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-amber-500/50 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            {/* 헤더 */}
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-amber-100">
                {activeProductConfig?.detector_type === 'paddleocr' ? 'Date Patterns' : 'Reject Thresholds'}
              </h2>
              <button
                onClick={() => setShowThresholdPanel(false)}
                className="text-gray-500 hover:text-gray-300 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* PaddleOCR 모드: detector_config 편집 */}
            {activeProductConfig?.detector_type === 'paddleocr' ? (
              <div className="space-y-3 mb-6">
                {/* Change Date Pattern */}
                <div className="flex flex-col gap-1.5 p-3 bg-black/40 rounded-lg border border-gray-700/50">
                  <label className="text-xs text-gray-400 font-medium">
                    Date Pattern (Regex)
                  </label>
                  <input
                    type="text"
                    value={editingChangeDate}
                    onChange={e => setEditingChangeDate(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        // 입력값을 정규식 형식으로 변환해서 저장
                        const regexValue = regexFormat(editingChangeDate)
                        const newOcrConfig = { ...ocrConfig, change_date: regexValue }
                        setOcrConfig(newOcrConfig)
                        // 즉시 백엔드에 저장
                        if (config.active_product) {
                          onUpdateDetectorConfig?.(
                            config.line_name,
                            config.active_product,
                            newOcrConfig
                          )
                        }
                        e.currentTarget.blur()
                      }
                    }}
                    onBlur={() => {
                      // 입력값을 정규식 형식으로 변환해서 저장
                      const regexValue = regexFormat(editingChangeDate)
                      if (regexValue !== ocrConfig.change_date) {
                        const newOcrConfig = { ...ocrConfig, change_date: regexValue }
                        setOcrConfig(newOcrConfig)
                        // 즉시 백엔드에 저장
                        if (config.active_product) {
                          onUpdateDetectorConfig?.(
                            config.line_name,
                            config.active_product,
                            newOcrConfig
                          )
                        }
                      }
                    }}
                    placeholder="e.g., 2026.02.28"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500 transition-colors"
                  />
                  <p className="text-xs text-gray-500">
                    Simple format: 2026.02.28 (dots are auto-escaped in JSON)
                  </p>
                </div>

                {/* Use Angle Detection */}
                <div className="flex items-center justify-between p-3 bg-black/40 rounded-lg border border-gray-700/50">
                  <label className="text-xs text-gray-400 font-medium">
                    Detect Rotated Text
                  </label>
                  <button
                    onClick={() => {
                      setOcrConfig(prev => ({ ...prev, use_angle_cls: !prev.use_angle_cls }))
                    }}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                      ocrConfig.use_angle_cls
                        ? 'bg-blue-500/30 text-blue-300 border border-blue-500/50'
                        : 'bg-gray-700/30 text-gray-400 border border-gray-600/50'
                    }`}
                  >
                    {ocrConfig.use_angle_cls ? 'ON' : 'OFF'}
                  </button>
                </div>

                {/* Detection Size Limit */}
                <div className="flex flex-col gap-1.5 p-3 bg-black/40 rounded-lg border border-gray-700/50">
                  <label className="text-xs text-gray-400 font-medium">
                    Detection Speed
                  </label>
                  <div className="flex gap-2">
                    {[480, 960, 1280].map(size => (
                      <button
                        key={size}
                        onClick={() => {
                          setOcrConfig(prev => ({ ...prev, det_limit_side_len: size }))
                        }}
                        className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                          ocrConfig.det_limit_side_len === size
                            ? 'bg-amber-500/30 text-amber-300 border border-amber-500/50'
                            : 'bg-gray-700/30 text-gray-400 border border-gray-600/50 hover:bg-gray-700/50'
                        }`}
                      >
                        {size === 480 ? 'Fast' : size === 960 ? 'Balanced' : 'Accurate'}
                        <br />
                        <span className="text-[10px] opacity-70">{size}px</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              /* 일반 모드: 값 조절 */
              <div className="space-y-3 mb-6">
                {Object.entries(localThresholds).map(([cls, val]) => (
                  <div key={cls} className="flex items-center justify-between p-3 bg-black/40 rounded-lg border border-gray-700/50">
                    <span className="text-sm font-medium text-amber-100">{cls}</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleThresholdChange(cls, -0.01)}
                        className="w-7 h-7 flex items-center justify-center rounded bg-amber-500/20 text-amber-400
                          hover:text-amber-200 hover:bg-amber-500/30 transition-colors font-bold text-sm"
                      >
                        ▼
                      </button>
                      <span className="text-sm font-mono text-amber-100 w-12 text-center font-bold">
                        {val.toFixed(2)}
                      </span>
                      <button
                        onClick={() => handleThresholdChange(cls, +0.01)}
                        className="w-7 h-7 flex items-center justify-center rounded bg-amber-500/20 text-amber-400
                          hover:text-amber-200 hover:bg-amber-500/30 transition-colors font-bold text-sm"
                      >
                        ▲
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 저장/닫기 버튼 */}
            {activeProductConfig?.detector_type === 'paddleocr' ? (
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    // OCR 설정 저장
                    if (config.active_product) {
                      onUpdateDetectorConfig?.(
                        config.line_name,
                        config.active_product,
                        ocrConfig
                      )
                    }
                    setShowThresholdPanel(false)
                  }}
                  className="flex-1 py-2.5 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors font-semibold text-sm border border-green-500/30"
                >
                  Save
                </button>
                <button
                  onClick={() => setShowThresholdPanel(false)}
                  className="flex-1 py-2.5 rounded-lg bg-gray-700/30 text-gray-400 hover:bg-gray-700/50 transition-colors font-semibold text-sm border border-gray-600/30"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowThresholdPanel(false)}
                className="w-full py-2.5 rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors font-semibold text-sm border border-amber-500/30"
              >
                Close
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
