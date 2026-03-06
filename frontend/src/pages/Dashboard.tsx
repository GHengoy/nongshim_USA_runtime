import { useState, useEffect, useRef, useCallback } from 'react'
import { Play, Square, LayoutGrid, Equal, LayoutDashboard } from 'lucide-react'
import ReactGridLayout, { Layout, LayoutItem } from 'react-grid-layout'
import { InspectionLine, InspectionConfig } from '../types'
import CameraCard from '../components/CameraCard'
import LineModal from '../components/LineModal'
import { useAuth } from '../contexts/AuthContext'
import * as api from '../api'

const TOTAL_SLOTS = 10
const LS_KEY = 'dashboard-layout'
const GRID_COLS = 60

const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: '0', x: 0,  y: 0,  w: 15, h: 10, minW: 3, minH: 3 },
  { i: '1', x: 15, y: 0,  w: 15, h: 10, minW: 3, minH: 3 },
  { i: '2', x: 30, y: 0,  w: 15, h: 10, minW: 3, minH: 3 },
  { i: '3', x: 45, y: 0,  w: 15, h: 10, minW: 3, minH: 3 },
  { i: '4', x: 0,  y: 10, w: 15, h: 10, minW: 3, minH: 3 },
  { i: '5', x: 15, y: 10, w: 15, h: 10, minW: 3, minH: 3 },
  { i: '6', x: 30, y: 10, w: 15, h: 10, minW: 3, minH: 3 },
  { i: '7', x: 45, y: 10, w: 15, h: 10, minW: 3, minH: 3 },
  { i: '8', x: 0,  y: 20, w: 15, h: 10, minW: 3, minH: 3 },
  { i: '9', x: 15, y: 20, w: 15, h: 10, minW: 3, minH: 3 },
]

function loadSavedLayout(): LayoutItem[] {
  try {
    const saved = localStorage.getItem(LS_KEY)
    if (saved) {
      let parsed: LayoutItem[] = JSON.parse(saved)
      // 이전 열 수 레이아웃 → 60열 자동 마이그레이션
      const maxRight = Math.max(...parsed.map(it => it.x + it.w))
      const oldCols = maxRight <= 12 ? 12 : maxRight <= 24 ? 24 : maxRight <= 32 ? 32 : 0
      if (oldCols > 0 && oldCols < GRID_COLS) {
        const scale = GRID_COLS / oldCols
        parsed = parsed.map(item => ({
          ...item,
          x: Math.round(item.x * scale),
          w: Math.round(item.w * scale),
        }))
        localStorage.setItem(LS_KEY, JSON.stringify(parsed))
      }
      return parsed.map(item => ({ minW: 3, minH: 3, ...item }))
    }
  } catch { /* ignore */ }
  return DEFAULT_LAYOUT
}

function EmptySlot({ index }: { index: number }) {
  return (
    <div
      className="h-full border rounded-xl overflow-hidden opacity-60"
      style={{
        backgroundColor: '#2c313a',
        borderColor: '#3e4451',
      }}
    >
      {/* 피드 영역 */}
      <div
        className="flex-1 min-h-0 h-3/4 flex items-center justify-center"
        style={{ backgroundColor: 'rgba(0,0,0,0.2)' }}
      >
        <div className="w-8 h-8 rounded border-2 border-dashed border-gray-700 flex items-center justify-center">
          <span className="text-xs text-gray-700 font-mono">{index + 1}</span>
        </div>
      </div>
      {/* 본문 스켈레톤 */}
      <div className="p-4">
        <div className="h-3 bg-gray-800 rounded w-1/2 mb-2" />
        <div className="h-2.5 bg-gray-800 rounded w-1/3 mb-4" />
        <div className="h-7 bg-gray-800 rounded" />
      </div>
    </div>
  )
}

export default function Dashboard() {
  const { requireAdmin } = useAuth()
  const [lines, setLines] = useState<InspectionLine[]>([])
  const [lastUpdated, setLastUpdated] = useState(new Date())
  const [modalLine, setModalLine] = useState<InspectionLine | undefined>(undefined)
  const [bulkLoading, setBulkLoading] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [layout, setLayout] = useState<LayoutItem[]>(loadSavedLayout)
  const [containerWidth, setContainerWidth] = useState(1200)
  const containerRef = useRef<HTMLDivElement>(null)

  // 컨테이너 너비 추적 (사이드바 토글 등 대응)
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      setContainerWidth(entries[0].contentRect.width)
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // 백엔드에서 레이아웃 로드 (마운트 시)
  useEffect(() => {
    const loadLayoutFromBackend = async () => {
      try {
        const serverLayout = await api.fetchLayoutSettings()
        if (serverLayout && Object.keys(serverLayout).length > 0) {
          const layoutArray = Object.values(serverLayout) as LayoutItem[]
          setLayout(layoutArray.map(item => ({
            minW: 3, minH: 3, ...item,
            w: Math.max(item.w ?? 4, 3),
            h: Math.max(item.h ?? 4, 3),
          })))
        }
      } catch {
        // 백엔드 실패 시 localStorage 사용 (이미 초기화됨)
      }
    }
    loadLayoutFromBackend()
  }, [])

  // 레이아웃 변경 시 백엔드에 저장 (throttled)
  const saveLayoutRef = useRef<ReturnType<typeof setTimeout>>()
  const saveLayoutToBackend = useCallback((newLayout: LayoutItem[]) => {
    if (saveLayoutRef.current) clearTimeout(saveLayoutRef.current)
    saveLayoutRef.current = setTimeout(() => {
      const layoutObj = Object.fromEntries(newLayout.map(item => [item.i, item]))
      api.updateLayoutSettings(layoutObj).catch(() => {
        // 저장 실패 시 무시
      })
      localStorage.setItem(LS_KEY, JSON.stringify(newLayout))
    }, 500)
  }, [])

  const loadLines = async () => {
    try {
      const data = await api.fetchLines()
      setLines(data)
      setLastUpdated(new Date())
    } catch {
      // 백엔드 미실행 시 무시
    }
  }

  // 초기화 중인 라인이 있으면 빠르게 폴링 (500ms), 아니면 3초
  const hasInitializing = lines.some(l => l.stats.status === 'initializing')

  useEffect(() => {
    loadLines()
    const interval = hasInitializing ? 500 : 3000
    const id = setInterval(loadLines, interval)
    return () => clearInterval(id)
  }, [hasInitializing])

  const handleToggle = async (lineName: string) => {
    const line = lines.find(l => l.config.line_name === lineName)
    if (!line) return
    const isActive = line.stats.status === 'running' || line.stats.status === 'initializing'
    setLines(prev =>
      prev.map(l =>
        l.config.line_name === lineName
          ? { ...l, stats: { ...l.stats, status: isActive ? 'stopped' : 'initializing' } }
          : l
      )
    )
    try {
      if (isActive) await api.stopLine(lineName)
      else await api.startLine(lineName)
    } catch {
      await loadLines()
    }
  }

  const handleModalSave = async (config: InspectionConfig) => {
    try {
      await api.updateLine(config.line_name, config)
      await loadLines()
    } catch (e) {
      alert(`Save failed: ${e}`)
    }
    setModalLine(undefined)
  }

  const handleSwitchProduct = async (lineName: string, productName: string) => {
    try {
      await api.switchProduct(lineName, productName)
      await loadLines()
    } catch (e) {
      console.error('Product switch failed:', e)
    }
  }

  const handleUpdateThreshold = async (
    lineName: string,
    productName: string,
    className: string,
    newValue: number
  ) => {
    const line = lines.find(l => l.config.line_name === lineName)
    if (!line) return

    const newThresholds = {
      ...line.config.products?.[productName]?.class_thresholds,
      [className]: newValue,
    }

    // 로컬 상태 즉시 반영 (낙관적 업데이트)
    setLines(prev =>
      prev.map(l => {
        if (l.config.line_name !== lineName) return l
        const updatedProducts = l.config.products
          ? { ...l.config.products, [productName]: { ...l.config.products[productName], class_thresholds: newThresholds } }
          : undefined
        return { ...l, config: { ...l.config, products: updatedProducts, class_thresholds: newThresholds } }
      })
    )

    try {
      await api.updateThresholds(lineName, productName, newThresholds)
    } catch (e) {
      console.error('Threshold update failed:', e)
      await loadLines()
    }
  }

  const handleUpdateDetectorConfig = async (
    lineName: string,
    productName: string,
    detectorConfig: Record<string, any>
  ) => {
    const line = lines.find(l => l.config.line_name === lineName)
    if (!line) return

    const updatedConfig = {
      ...line.config,
      products: line.config.products
        ? {
            ...line.config.products,
            [productName]: {
              ...line.config.products[productName],
              detector_config: detectorConfig,
            },
          }
        : undefined,
    }

    try {
      await api.updateLine(lineName, updatedConfig)
      // 성공 시 로컬 상태도 즉시 반영
      setLines(prev =>
        prev.map(l =>
          l.config.line_name === lineName
            ? { ...l, config: updatedConfig }
            : l
        )
      )
    } catch (e) {
      console.error('Detector config update failed:', e)
      // 실패 시 서버 상태로 복구
      await loadLines()
    }
  }

  const handleStartAll = async () => {
    setBulkLoading(true)
    try {
      await api.startAll()
      await loadLines()
    } catch { /* ignore */ } finally {
      setBulkLoading(false)
    }
  }

  const handleStopAll = async () => {
    setBulkLoading(true)
    try {
      await api.stopAll()
      await loadLines()
    } catch { /* ignore */ } finally {
      setBulkLoading(false)
    }
  }

  const handleLayoutChange = useCallback((newLayout: Layout) => {
    const mutable = [...newLayout] as LayoutItem[]
    setLayout(mutable)
    saveLayoutToBackend(mutable)
  }, [saveLayoutToBackend])

  const handleResetLayout = () => {
    setLayout(DEFAULT_LAYOUT)
    saveLayoutToBackend(DEFAULT_LAYOUT)
  }

  // 행 그룹 계산 (y값이 같은 아이템 = 같은 행)
  const rowGroups = (() => {
    const map = new Map<number, LayoutItem[]>()
    layout.forEach(item => {
      const arr = map.get(item.y) || []
      arr.push(item)
      map.set(item.y, arr)
    })
    return [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([y, items]) => ({ y, items: items.sort((a, b) => a.x - b.x) }))
  })()

  const handleEqualizeRow = (yValue: number) => {
    const rowItems = layout.filter(item => item.y === yValue)
                           .sort((a, b) => a.x - b.x)
    if (rowItems.length <= 1) return

    const count = rowItems.length
    const baseW = Math.floor(GRID_COLS / count)
    const extra = GRID_COLS - baseW * count

    const equalizedIds = new Set(rowItems.map(it => it.i))
    let x = 0
    const newLayout = layout.map(item => {
      if (!equalizedIds.has(item.i)) return item
      const idx = rowItems.findIndex(ri => ri.i === item.i)
      const w = baseW + (idx < extra ? 1 : 0)
      const result = { ...item, x, w }
      x += w
      return result
    })

    setLayout(newLayout as LayoutItem[])
    localStorage.setItem(LS_KEY, JSON.stringify(newLayout))
  }

  // 활성화된 라인을 워커 번호 기준으로 정확한 슬롯에 배치
  const enabledLines = lines.filter(l => l.config.enabled !== false)
  const slots: (InspectionLine | null)[] = Array(TOTAL_SLOTS).fill(null)
  lines.forEach(line => {
    if (line.config.enabled !== false) {
      const workerFolder = line.stats.worker_folder || ''
      const match = workerFolder.match(/worker-(\d+)/)
      if (match) {
        const slotIndex = parseInt(match[1]) - 1
        if (slotIndex >= 0 && slotIndex < TOTAL_SLOTS) {
          slots[slotIndex] = line
        }
      }
    }
  })

  return (
    <div className="relative p-6 overflow-hidden">
      {/* 상단 파랑/보라 글로우 + 물결 장식 (페이드아웃 마스크) */}
      <div className="absolute top-0 left-0 right-0 h-[280px] pointer-events-none select-none" style={{ maskImage: 'linear-gradient(to bottom, black 20%, transparent 75%)', WebkitMaskImage: 'linear-gradient(to bottom, black 20%, transparent 75%)' }}>
        {/* 글로우 */}
        <div className="absolute -top-10 -left-10 w-96 h-56 bg-black/35 rounded-full blur-3xl" />
        <div className="absolute -top-6 left-[12%] w-80 h-36 bg-indigo-900/30 rounded-full blur-3xl" />
        <div className="absolute -top-12 left-[28%] w-96 h-48 bg-blue-900/25 rounded-full blur-3xl" />
        <div className="absolute -top-8 left-[44%] w-72 h-40 bg-violet-500/25 rounded-full blur-3xl" />
        <div className="absolute -top-14 left-[58%] w-88 h-44 bg-purple-500/20 rounded-full blur-3xl" />
        <div className="absolute -top-6 left-[72%] w-80 h-36 bg-indigo-400/22 rounded-full blur-3xl" />
        <div className="absolute -top-10 left-[85%] w-72 h-48 bg-blue-500/25 rounded-full blur-3xl" />

        {/* 물결 — 5개 레이어 (중간 진폭) */}
        <svg className="absolute w-[300%] h-full opacity-[0.09]" viewBox="0 0 2880 200" preserveAspectRatio="none">
          <path fill="currentColor" className="text-blue-400" d="M0,50 C360,100 720,20 1080,80 C1260,110 1380,35 1440,50 C1800,100 2160,20 2520,80 C2700,110 2820,35 2880,50 L2880,0 L0,0 Z">
            <animateTransform attributeName="transform" type="translate" values="0,0;-1440,0;0,0" dur="60s" repeatCount="indefinite" />
          </path>
        </svg>
        <svg className="absolute w-[300%] h-full opacity-[0.07]" viewBox="0 0 2880 200" preserveAspectRatio="none">
          <path fill="currentColor" className="text-cyan-400" d="M0,70 C240,30 480,110 720,45 C960,20 1200,95 1440,70 C1680,30 1920,110 2160,45 C2400,20 2640,95 2880,70 L2880,0 L0,0 Z">
            <animateTransform attributeName="transform" type="translate" values="-1440,0;0,0;-1440,0" dur="50s" repeatCount="indefinite" />
          </path>
        </svg>
        <svg className="absolute w-[300%] h-full opacity-[0.05]" viewBox="0 0 2880 200" preserveAspectRatio="none">
          <path fill="currentColor" className="text-indigo-400" d="M0,55 C300,105 600,20 900,85 C1150,115 1350,30 1440,55 C1740,105 2040,20 2340,85 C2590,115 2790,30 2880,55 L2880,0 L0,0 Z">
            <animateTransform attributeName="transform" type="translate" values="0,0;-1440,0;0,0" dur="70s" repeatCount="indefinite" />
          </path>
        </svg>
        <svg className="absolute w-[300%] h-full opacity-[0.06]" viewBox="0 0 2880 200" preserveAspectRatio="none">
          <path fill="currentColor" className="text-violet-400" d="M0,65 C200,25 500,110 720,50 C1000,20 1250,100 1440,65 C1640,25 1940,110 2160,50 C2440,20 2690,100 2880,65 L2880,0 L0,0 Z">
            <animateTransform attributeName="transform" type="translate" values="-1440,0;0,0;-1440,0" dur="56s" repeatCount="indefinite" />
          </path>
        </svg>
        <svg className="absolute w-[300%] h-full opacity-[0.04]" viewBox="0 0 2880 200" preserveAspectRatio="none">
          <path fill="currentColor" className="text-purple-300" d="M0,60 C360,110 720,25 1080,90 C1260,105 1380,40 1440,60 C1800,110 2160,25 2520,90 C2700,105 2820,40 2880,60 L2880,0 L0,0 Z">
            <animateTransform attributeName="transform" type="translate" values="0,0;-1440,0;0,0" dur="64s" repeatCount="indefinite" />
          </path>
        </svg>
      </div>

      {/* 헤더 */}
      <div className="relative flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-blue-600/20 border border-white/30 rounded-lg flex items-center justify-center">
            <LayoutDashboard size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white">Dashboard</h1>
            <p className="text-xs text-gray-500">
              Last updated: {lastUpdated.toLocaleTimeString('en-US')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* 실행 중인 라인이 있으면 Stop All만, 없으면 Start All만 표시 */}
          {!editMode && (
            <>
              {enabledLines.some(l => l.stats.status === 'running' || l.stats.status === 'initializing') ? (
                /* Stop All */
                <button
                  onClick={handleStopAll}
                  disabled={bulkLoading}
                  className="flex items-center gap-2.5 px-5 py-2.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed
                    bg-red-500/30 text-white border border-red-500/60 hover:bg-red-500/40 hover:border-red-500/80"
                >
                  <Square size={20} strokeWidth={2.5} />
                  Stop All
                </button>
              ) : (
                /* Start All */
                <button
                  onClick={handleStartAll}
                  disabled={bulkLoading}
                  className="flex items-center gap-2.5 px-5 py-2.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed
                    bg-green-500/30 text-white border border-green-500/60 hover:bg-green-500/40 hover:border-green-500/80"
                >
                  <Play size={20} strokeWidth={2.5} />
                  Start All
                </button>
              )}
            </>
          )}

          {/* 구분선 */}
          <div className="w-px h-6 bg-gray-700" />

          {/* Edit Layout 토글 — 진입 시만 관리자 인증 필요 */}
          <button
            onClick={() => editMode ? setEditMode(false) : requireAdmin(() => setEditMode(true))}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition-all border ${
              editMode
                ? 'bg-blue-500/10 text-blue-400 border-blue-500/50 hover:bg-blue-500/15 hover:border-blue-500/70'
                : 'bg-gray-800/30 text-gray-400 border-gray-600/50 hover:bg-gray-700/40 hover:border-gray-500/60 hover:text-gray-300'
            }`}
            title={editMode ? 'Exit layout edit mode' : 'Enter layout edit mode'}
          >
            <LayoutGrid size={16} />
            {editMode ? 'Done' : 'Edit Layout'}
          </button>

          {/* 편집 모드일 때 Reset 버튼 표시 */}
          {editMode && (
            <button
              onClick={handleResetLayout}
              className="px-3 py-2.5 rounded-xl text-xs font-medium text-gray-500 border border-gray-700/50 hover:text-gray-300 hover:bg-gray-800/60 transition-all"
              title="Reset to default layout"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* 편집 모드 안내 */}
      {editMode && (
        <div className="mb-4 px-4 py-2.5 rounded-lg border border-blue-500/20 bg-blue-500/5 text-xs text-blue-300/80 flex items-center gap-2">
          <LayoutGrid size={13} className="shrink-0" />
          Drag cards to reposition · Resize from the bottom-right corner · Click <strong className="text-blue-300">Done</strong> when finished
        </div>
      )}

      {/* 행 균등 분배 버튼 */}
      {editMode && rowGroups.length > 0 && (
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 mr-1">Equalize row:</span>
          {rowGroups.map((row, idx) => (
            <button
              key={row.y}
              onClick={() => handleEqualizeRow(row.y)}
              disabled={row.items.length <= 1}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium
                bg-gray-800/60 text-gray-400 border border-gray-700/50
                hover:bg-gray-700/60 hover:text-gray-300 transition-all
                disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span>Row {idx + 1}</span>
              <span className="text-gray-600">·</span>
              <span className="text-gray-500">{row.items.length} cards</span>
              <Equal size={13} className="ml-1" />
            </button>
          ))}
        </div>
      )}

      {/* 카메라 그리드 — ReactGridLayout */}
      <div ref={containerRef}>
        <ReactGridLayout
          className="layout"
          layout={layout as Layout}
          width={containerWidth}
          gridConfig={{ cols: GRID_COLS, rowHeight: 30, margin: [16, 16] as [number, number] }}
          dragConfig={{ enabled: editMode }}
          resizeConfig={{ enabled: editMode }}
          onLayoutChange={handleLayoutChange}
        >
          {slots.map((line, i) => {
            if (!line && !editMode) return null
            return (
              <div
                key={String(i)}
                style={{ cursor: editMode ? 'grab' : 'default' }}
              >
                {line ? (
                  <CameraCard
                    line={line}
                    onToggle={handleToggle}
                    onSettings={(l) => requireAdmin(() => setModalLine(l))}
                    onSwitchProduct={handleSwitchProduct}
                    onUpdateThreshold={handleUpdateThreshold}
                    onUpdateDetectorConfig={handleUpdateDetectorConfig}
                    editMode={editMode}
                    gridSize={editMode ? { w: layout[i]?.w ?? 0, h: layout[i]?.h ?? 0 } : undefined}
                  />
                ) : (
                  <EmptySlot index={i} />
                )}
              </div>
            )
          })}
        </ReactGridLayout>
      </div>

      {/* Settings modal */}
      {modalLine !== undefined && (
        <LineModal
          line={modalLine}
          onClose={() => setModalLine(undefined)}
          onSave={handleModalSave}
        />
      )}
    </div>
  )
}
