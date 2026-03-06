import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Save, Upload, Wifi, Monitor, RefreshCw, Check, ChevronDown, ChevronRight, FolderOpen, Folder, FileText, ArrowLeft, Camera } from 'lucide-react'
import { InspectionLine, InspectionConfig, ProductConfig, RotationType, DeviceType, CameraType, DetectorType, GpuInfo } from '../types'
import * as api from '../api'

// ── Collapsible Section ──────────────────────────────────────────────
function Section({ id, title, collapsed, onToggle, children, right }: {
  id: string
  title: string
  collapsed: Record<string, boolean>
  onToggle: (id: string) => void
  children: React.ReactNode
  right?: React.ReactNode
}) {
  const isCollapsed = collapsed[id] ?? false
  return (
    <section>
      <div
        className="flex items-center justify-between mb-3 cursor-pointer select-none group"
        onClick={() => onToggle(id)}
      >
        <div className="flex items-center gap-1.5">
          {isCollapsed
            ? <ChevronRight size={14} className="text-gray-500 group-hover:text-gray-300 transition-colors" />
            : <ChevronDown size={14} className="text-gray-500 group-hover:text-gray-300 transition-colors" />
          }
          <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider group-hover:text-gray-300 transition-colors">{title}</h3>
        </div>
        {right && <div onClick={e => e.stopPropagation()}>{right}</div>}
      </div>
      {!isCollapsed && children}
    </section>
  )
}

// ── File Browser Component ──────────────────────────────────────────
function FileBrowser({ extensions, onSelect, onClose, initialPath }: {
  extensions: string
  onSelect: (path: string) => void
  onClose: () => void
  initialPath?: string
}) {
  const [currentDir, setCurrentDir] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [items, setItems] = useState<api.FileBrowseItem[]>([])
  const [loading, setLoading] = useState(true)

  const browse = useCallback(async (path: string) => {
    setLoading(true)
    try {
      const res = await api.browseFiles(path, extensions)
      setCurrentDir(res.current)
      setParentDir(res.parent)
      setItems(res.items)
    } catch { /* ignore */ }
    setLoading(false)
  }, [extensions])

  useEffect(() => {
    browse(initialPath || '')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-600 rounded-lg shadow-2xl max-h-72 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700 bg-gray-900/50">
        <button
          type="button"
          onClick={() => browse(parentDir)}
          className="p-1 text-gray-400 hover:text-white rounded hover:bg-gray-700"
          title="Go up"
        >
          <ArrowLeft size={14} />
        </button>
        <span className="text-[10px] text-gray-500 font-mono truncate flex-1" title={currentDir}>{currentDir}</span>
        <button type="button" onClick={onClose} className="p-1 text-gray-500 hover:text-gray-300">
          <X size={12} />
        </button>
      </div>
      {/* Items */}
      <div className="overflow-y-auto flex-1">
        {loading ? (
          <div className="text-xs text-gray-500 py-4 text-center">Loading...</div>
        ) : items.length === 0 ? (
          <div className="text-xs text-gray-600 py-4 text-center">No items found</div>
        ) : (
          items.map(item => (
            <button
              key={item.path}
              type="button"
              onClick={() => item.is_dir ? browse(item.path) : onSelect(item.path)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-700/60 transition-colors ${
                !item.is_dir ? 'text-blue-300' : 'text-gray-300'
              }`}
            >
              {item.is_dir
                ? <Folder size={13} className="text-yellow-500/70 shrink-0" />
                : <FileText size={13} className="text-gray-500 shrink-0" />
              }
              <span className="truncate">{item.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

// ── 정규식 ↔ 화면 표시 변환 ───────────────────────────────────────────────
/** 파일 형식 (정규식): "2011\\.11\\.11" → 화면 표시: "2011.11.11" */
const displayFormat = (regexStr: string): string => {
  if (!regexStr) return ''
  // \\ 을 . 로 변환 (마크다운 이스케이프 표시 제거)
  return regexStr.replace(/\\\./g, '.')
}

/** 화면 표시: "2011.11.11" → 파일 형식 (정규식): "2011\\.11\\.11" */
const regexFormat = (displayStr: string): string => {
  if (!displayStr) return ''
  // . 을 \\ 로 변환 (마크다운 이스케이프 추가)
  return displayStr.replace(/\./g, '\\.')
}

export const defaultConfig: InspectionConfig = {
  line_name: '',
  project_name: '',
  enabled: true,
  camera_type: 'basler',
  camera_ip: '192.168.1.',
  pfs_file: 'camera.pfs',
  rotation: 'NONE',
  crop_region: null,
  model_path: './weights/best.pt',
  class_thresholds: { defect: 0.70 },
  save_thresholds: null,
  device: 'cuda',
  reject_delay_frames: 10,
  reject_delay_seconds: null as null | number,
  reject_positions: 1,
  reject_mode: 'individual' as const,
  time_valve_on: 0.1,
  pre_valve_delay: 0.25,
  trigger_delay_us: null as null | number,
  trigger_debounce_us: null as null | number,
  save_root: './data',
  retention_days: 180,
  max_preview: 50,
  save_normal: false,
  detector_type: 'yolo',
  detector_config: null,
  show_threshold: 0.3,
  data_yaml: './weights/data.yaml',
}

export default function LineModal({
  line,
  onClose,
  onSave,
}: {
  line: InspectionLine | null
  onClose: () => void
  onSave: (config: InspectionConfig) => void
}) {
  // Backward compatibility: convert reject_pulse_count to time_valve_on if needed
  const normalizeConfig = (config: any): InspectionConfig => {
    const c = { ...config }
    if (c.reject_pulse_count !== undefined && c.time_valve_on === undefined) {
      c.time_valve_on = c.reject_pulse_count * 0.1
    }
    return c as InspectionConfig
  }

  const [cfg, setCfg] = useState<InspectionConfig>(
    line ? normalizeConfig(line.config) : defaultConfig
  )
  const [thresholds, setThresholds] = useState<[string, number][]>(
    Object.entries(cfg.class_thresholds ?? { defect: 0.70 })
  )
  const [saveThresholds, setSaveThresholds] = useState<[string, number][]>(
    Object.entries(cfg.save_thresholds ?? {})
  )
  const [cropEnabled, setCropEnabled] = useState(cfg.crop_region !== null)
  const [cropVals, setCropVals] = useState<[number, number, number, number]>(
    cfg.crop_region ?? [0, 0, 1920, 1080]
  )

  // Product management state
  const [products, setProducts] = useState<Record<string, ProductConfig>>(() => {
    if (cfg.products && Object.keys(cfg.products).length > 0) {
      // Normalize each product's time_valve_on if needed
      const normalized: Record<string, ProductConfig> = {}
      for (const [name, product] of Object.entries(cfg.products)) {
        const p = { ...product } as any
        if (p.reject_pulse_count !== undefined && p.time_valve_on === undefined) {
          p.time_valve_on = p.reject_pulse_count * 0.1
        }
        normalized[name] = p as ProductConfig
      }
      return normalized
    }
    return {
      Default: {
        rotation: cfg.rotation, crop_region: cfg.crop_region,
        model_path: cfg.model_path, class_thresholds: cfg.class_thresholds,
        save_thresholds: cfg.save_thresholds, device: cfg.device,
        reject_delay_frames: cfg.reject_delay_frames, reject_delay_seconds: cfg.reject_delay_seconds ?? null,
        reject_positions: cfg.reject_positions, reject_mode: cfg.reject_mode ?? 'individual',
        time_valve_on: cfg.time_valve_on, pre_valve_delay: cfg.pre_valve_delay,
        trigger_delay_us: cfg.trigger_delay_us ?? null,
        save_root: cfg.save_root, retention_days: cfg.retention_days,
        max_preview: cfg.max_preview, save_normal: cfg.save_normal,
        detector_type: cfg.detector_type ?? 'yolo',
        detector_config: cfg.detector_config ?? null,
        show_threshold: cfg.show_threshold ?? 0.3,
      },
    }
  })
  const [activeProduct, setActiveProduct] = useState<string>(cfg.active_product ?? 'Default')
  const [showAddProduct, setShowAddProduct] = useState(false)
  const [newProductName, setNewProductName] = useState('')
  const [copyFromProduct, setCopyFromProduct] = useState('')

  // Webcam scan state
  const [webcamList, setWebcamList] = useState<api.WebcamDevice[]>([])
  const [webcamScanning, setWebcamScanning] = useState(false)
  const [webcamScanned, setWebcamScanned] = useState(false)

  // GPU list state
  const [gpuList, setGpuList] = useState<GpuInfo[]>([])

  // Collapsible sections state
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const toggleSection = (id: string) => setCollapsed(prev => ({ ...prev, [id]: !prev[id] }))

  // File browser state
  const [fileBrowser, setFileBrowser] = useState<{ field: string; extensions: string; initialPath?: string } | null>(null)

  const scanWebcams = async () => {
    setWebcamScanning(true)
    setWebcamList([])
    try {
      const cams = await api.fetchWebcams()
      setWebcamList(cams)
      setWebcamScanned(true)
      // 스캔 결과에서 현재 선택된 인덱스가 없으면 첫 번째로 자동 선택
      if (cams.length > 0 && !cams.find(c => c.index === cfg.camera_ip)) {
        set('camera_ip', cams[0].index)
      }
    } catch {
      setWebcamList([])
      setWebcamScanned(true)
    } finally {
      setWebcamScanning(false)
    }
  }

  // 모달 열릴 때 GPU 목록 로드
  useEffect(() => {
    api.fetchGpus().then(setGpuList).catch(() => setGpuList([]))
  }, [])

  // 모달 열릴 때 YAML 자동 파싱 (class names 초기 로드)
  useEffect(() => {
    const yamlPath = cfg.data_yaml
    const lineName = cfg.line_name
    if (!yamlPath || !lineName) return
    api.parseYaml(yamlPath, lineName).then(result => {
      const classNames = Object.values(result.names)
      if (classNames.length > 0 && thresholds.length === 0) {
        setThresholds(classNames.map(name => [name, 0.70]))
        setSaveThresholds(classNames.map(name => [name, 0.60]))
      }
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 모달 열릴 때 백엔드에서 최신 데이터 가져오기
  useEffect(() => {
    if (!line?.config.line_name) return

    const loadLatestConfig = async () => {
      try {
        const latestLine = await api.fetchLine(line.config.line_name)
        const config = latestLine.config
        setCfg(config)
        setThresholds(Object.entries(config.class_thresholds ?? { defect: 0.70 }))
        setSaveThresholds(Object.entries(config.save_thresholds ?? {}))
        setCropEnabled(config.crop_region !== null)
        setCropVals(config.crop_region ?? [0, 0, 1920, 1080])
        setActiveProduct(config.active_product ?? 'Default')
        // products 재초기화
        if (config.products && Object.keys(config.products).length > 0) {
          setProducts(config.products)
        } else {
          setProducts({
            Default: {
              rotation: config.rotation, crop_region: config.crop_region,
              model_path: config.model_path, class_thresholds: config.class_thresholds,
              save_thresholds: config.save_thresholds, device: config.device,
              reject_delay_frames: config.reject_delay_frames, reject_delay_seconds: config.reject_delay_seconds ?? null,
              reject_positions: config.reject_positions, reject_mode: config.reject_mode ?? 'individual',
              time_valve_on: config.time_valve_on, pre_valve_delay: config.pre_valve_delay,
              trigger_delay_us: config.trigger_delay_us ?? null,
              save_root: config.save_root, retention_days: config.retention_days,
              max_preview: config.max_preview, save_normal: config.save_normal,
              detector_type: config.detector_type ?? 'yolo',
              detector_config: config.detector_config ?? null,
              show_threshold: config.show_threshold ?? 0.3,
            },
          })
        }
      } catch (e) {
        console.error('Failed to fetch latest line config:', e)
      }
    }

    loadLatestConfig()
  }, [line?.config.line_name]) // line_name을 key로 사용해서 모달 열릴 때만 갱신

  // webcam 탭으로 전환 시 상태 초기화 (자동 스캔 안 함 - 버튼 클릭 시에만)
  useEffect(() => {
    if (cfg.camera_type === 'webcam' && !webcamScanned) {
      // 웹캠 선택 시 명시적 스캔이 필요함
    }
  }, [cfg.camera_type]) // eslint-disable-line react-hooks/exhaustive-deps

  // Crop image & drag-select state
  const [cropImageUrl, setCropImageUrl] = useState<string | null>(null)
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isSelecting, setIsSelecting] = useState(false)
  const [selStart, setSelStart] = useState<{ x: number; y: number } | null>(null)
  const [selEnd, setSelEnd] = useState<{ x: number; y: number } | null>(null)
  const [capturingFrame, setCapturingFrame] = useState(false)
  const imgContainerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const isWorkerRunning = line?.stats.status === 'running'

  const handleCaptureFrame = async () => {
    if (!cfg.line_name) return
    setCapturingFrame(true)
    try {
      const url = await api.captureFrame(cfg.line_name)
      if (cropImageUrl) URL.revokeObjectURL(cropImageUrl)
      setCropImageUrl(url)
    } catch (e: any) {
      console.error('Failed to capture frame:', e)
    } finally {
      setCapturingFrame(false)
    }
  }

  const set = <K extends keyof InspectionConfig>(key: K, val: InspectionConfig[K]) =>
    setCfg(prev => ({ ...prev, [key]: val }))

  // ── Product helpers ──────────────────────────────────────────────
  const extractProductFields = (): ProductConfig => ({
    rotation: cfg.rotation,
    crop_region: cropEnabled ? cropVals : null,
    model_path: cfg.model_path,
    class_thresholds: Object.fromEntries(thresholds),
    save_thresholds: saveThresholds.length > 0 ? Object.fromEntries(saveThresholds) : null,
    device: cfg.device,
    reject_delay_frames: cfg.reject_delay_frames, reject_positions: cfg.reject_positions,
    reject_mode: cfg.reject_mode ?? 'individual',
    time_valve_on: cfg.time_valve_on, pre_valve_delay: cfg.pre_valve_delay,
    save_root: cfg.save_root, retention_days: cfg.retention_days,
    max_preview: cfg.max_preview, save_normal: cfg.save_normal,
    detector_type: cfg.detector_type ?? 'yolo',
    detector_config: cfg.detector_config ?? null,
    show_threshold: cfg.show_threshold ?? 0.3,
    data_yaml: cfg.data_yaml ?? './weights/data.yaml',
    trigger_delay_us: cfg.trigger_delay_us ?? null,
    trigger_debounce_us: cfg.trigger_debounce_us ?? null,
    reject_delay_seconds: cfg.reject_delay_seconds ?? null,
  })

  const loadProductIntoForm = (product: ProductConfig) => {
    setCfg(prev => ({
      ...prev,
      rotation: product.rotation,
      model_path: product.model_path, device: product.device,
      reject_delay_frames: product.reject_delay_frames, reject_delay_seconds: product.reject_delay_seconds ?? null,
      reject_positions: product.reject_positions, reject_mode: product.reject_mode ?? 'individual',
      time_valve_on: product.time_valve_on, pre_valve_delay: product.pre_valve_delay,
      trigger_delay_us: product.trigger_delay_us ?? null,
      trigger_debounce_us: product.trigger_debounce_us ?? null,
      save_root: product.save_root, retention_days: product.retention_days,
      max_preview: product.max_preview, save_normal: product.save_normal,
      detector_type: product.detector_type ?? 'yolo',
      detector_config: product.detector_config ?? null,
      show_threshold: product.show_threshold ?? 0.3,
      data_yaml: product.data_yaml ?? './weights/data.yaml',
    }))
    setCropEnabled(product.crop_region !== null)
    setCropVals(product.crop_region ?? [0, 0, 1920, 1080])
    setThresholds(Object.entries(product.class_thresholds ?? { defect: 0.70 }))
    setSaveThresholds(Object.entries(product.save_thresholds ?? {}))
  }

  const handleSwitchProduct = (productName: string) => {
    if (productName === activeProduct) return
    const currentFields = extractProductFields()
    const updatedProducts = { ...products, [activeProduct]: currentFields }
    setProducts(updatedProducts)
    const target = updatedProducts[productName]
    if (target) {
      loadProductIntoForm(target)
      setActiveProduct(productName)
    }
  }

  const handleAddProduct = () => {
    const name = newProductName.trim()
    if (!name || products[name]) return
    // Save current product first
    const currentFields = extractProductFields()
    const savedProducts = { ...products, [activeProduct]: currentFields }
    // Determine source product to copy from
    const sourceKey = copyFromProduct || Object.keys(savedProducts)[0]
    const sourceFields = savedProducts[sourceKey] ?? currentFields
    const updated = { ...savedProducts, [name]: { ...sourceFields } }
    setProducts(updated)
    loadProductIntoForm(updated[name])
    setActiveProduct(name)
    setNewProductName('')
    setCopyFromProduct('')
    setShowAddProduct(false)
  }

  const handleDeleteProduct = (productName: string) => {
    if (Object.keys(products).length <= 1) return
    if (!window.confirm(`Delete product "${productName}"?`)) return
    const updated = { ...products }
    delete updated[productName]
    setProducts(updated)
    if (activeProduct === productName) {
      const next = Object.keys(updated)[0]
      setActiveProduct(next)
      loadProductIntoForm(updated[next])
    }
  }

  const handleSave = () => {
    const currentFields = extractProductFields()
    const finalProducts = { ...products, [activeProduct]: currentFields }
    onSave({
      ...cfg,
      class_thresholds: Object.fromEntries(thresholds),
      save_thresholds: saveThresholds.length > 0 ? Object.fromEntries(saveThresholds) : null,
      crop_region: cropEnabled ? cropVals : null,
      save_root: cfg.save_root,
      retention_days: cfg.retention_days,
      active_product: activeProduct,
      products: finalProducts,
    })
  }

  // ── Detector config helpers ───────────────────────────────────
  const setDetectorConfig = (key: string, val: unknown) =>
    setCfg(prev => ({
      ...prev,
      detector_config: { ...(prev.detector_config ?? {}), [key]: val },
    }))

  const handleDetectorTypeChange = (type: DetectorType) => {
    if ((cfg.detector_type ?? 'yolo') === type) return
    const defaults: Record<string, { model_path: string; config: Record<string, unknown> | null; thresholds: [string, number][] }> = {
      yolo:      { model_path: './weights/best.pt',        config: null,                                                         thresholds: [['defect', 0.70]] },
      paddleocr: { model_path: '',                         config: { lang: 'en', change_date: '', class_name: 'date_check', use_gpu: true }, thresholds: [] },
      cnn:       { model_path: './weights/classifier.pth', config: { input_size: [224, 224], class_names: ['ok', 'ng'] },         thresholds: [['ng', 0.50]] },
    }
    const d = defaults[type] ?? defaults.yolo
    setCfg(prev => ({ ...prev, detector_type: type, model_path: d.model_path, detector_config: d.config }))
    setThresholds(d.thresholds)
    setSaveThresholds([])
  }

  // ── YAML file parsing for class names ─────────────────────────
  const handleYamlSelect = async (yamlPath: string) => {
    set('data_yaml', yamlPath)
    try {
      const result = await api.parseYaml(yamlPath, cfg.line_name)
      const classNames = Object.values(result.names)
      if (classNames.length > 0) {
        setThresholds(classNames.map(name => [name, 0.70]))
        setSaveThresholds(classNames.map(name => [name, 0.60]))
      }
    } catch (e) {
      console.error('Failed to parse YAML:', e)
    }
    setFileBrowser(null)
  }

  // ── Image file loading ─────────────────────────────────────────
  const loadImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) return
    if (cropImageUrl) URL.revokeObjectURL(cropImageUrl)
    setCropImageUrl(URL.createObjectURL(file))
    setNaturalSize(null)
    setSelStart(null)
    setSelEnd(null)
    setIsSelecting(false)
  }

  // ── Coordinate conversion ──────────────────────────────────────
  const getContainerWidth = () => imgContainerRef.current?.clientWidth ?? 1

  const pxToImg = (px: number, py: number): [number, number] => {
    if (!naturalSize) return [0, 0]
    const scale = naturalSize.w / getContainerWidth()
    return [Math.round(px * scale), Math.round(py * scale)]
  }

  const imgToPx = (ix: number, iy: number): [number, number] => {
    if (!naturalSize) return [0, 0]
    const scale = getContainerWidth() / naturalSize.w
    return [ix * scale, iy * scale]
  }

  // ── Mouse selection handlers ───────────────────────────────────
  const getRelPos = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = imgContainerRef.current?.getBoundingClientRect()
    if (!rect) return null
    return {
      x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
    }
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const pos = getRelPos(e)
    if (!pos) return
    setIsSelecting(true)
    setSelStart(pos)
    setSelEnd(pos)
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isSelecting) return
    const pos = getRelPos(e)
    if (pos) setSelEnd(pos)
  }

  const finalizeSelection = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isSelecting || !selStart) return
    const pos = getRelPos(e) ?? selEnd
    if (!pos) { setIsSelecting(false); return }
    const x1img = Math.min(selStart.x, pos.x)
    const y1img = Math.min(selStart.y, pos.y)
    const x2img = Math.max(selStart.x, pos.x)
    const y2img = Math.max(selStart.y, pos.y)
    if (x2img - x1img > 4 && y2img - y1img > 4) {
      const [x1, y1] = pxToImg(x1img, y1img)
      const [x2, y2] = pxToImg(x2img, y2img)
      setCropVals([x1, y1, x2, y2])
    }
    setIsSelecting(false)
  }

  // ── Selection overlay rect ─────────────────────────────────────
  const selBox = (() => {
    if (isSelecting && selStart && selEnd) {
      return {
        left: Math.min(selStart.x, selEnd.x),
        top: Math.min(selStart.y, selEnd.y),
        width: Math.abs(selEnd.x - selStart.x),
        height: Math.abs(selEnd.y - selStart.y),
      }
    }
    if (!isSelecting && naturalSize && imgContainerRef.current) {
      const [x1, y1] = imgToPx(cropVals[0], cropVals[1])
      const [x2, y2] = imgToPx(cropVals[2], cropVals[3])
      if (x2 > x1 && y2 > y1) return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 }
    }
    return null
  })()

  const liveLabel = (() => {
    if (!isSelecting || !selStart || !selEnd) return null
    const [x1, y1] = pxToImg(Math.min(selStart.x, selEnd.x), Math.min(selStart.y, selEnd.y))
    const [x2, y2] = pxToImg(Math.max(selStart.x, selEnd.x), Math.max(selStart.y, selEnd.y))
    return `(${x1}, ${y1}) → (${x2}, ${y2})  [${x2 - x1} × ${y2 - y1}]`
  })()

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Overlay */}
      <div className="flex-1 bg-black/60" onClick={onClose} />

      {/* Panel — widens when crop is enabled */}
      <div
        className="bg-gray-900 border-l border-gray-800 flex flex-col h-full overflow-hidden"
        style={{
          width: cropEnabled ? 'min(920px, calc(100vw - 32px))' : '480px',
          transition: 'width 0.2s ease',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
          <h2 className="text-base font-semibold text-white">
            {line ? 'Edit Line' : 'Add New Line'}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <X size={18} />
          </button>
        </div>

        {/* Form body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* Basic Info */}
          <Section id="basic" title="Basic Info" collapsed={collapsed} onToggle={toggleSection}>
            {/* Line ID (read-only for existing lines) */}
            {line && (
              <label className="block mb-3">
                <span className="text-xs text-gray-400 mb-1 block">
                  Line ID <span className="text-gray-600">(auto-assigned, read-only)</span>
                </span>
                <input
                  value={cfg.line_name}
                  readOnly
                  className="w-full bg-gray-700/50 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-500 font-mono cursor-not-allowed"
                />
              </label>
            )}

            {/* Project Name (editable) */}
            <label className="block mb-3">
              <span className="text-xs text-gray-400 mb-1 block">
                Project Name <span className="text-gray-600">(display name & save folder)</span>
              </span>
              <input
                value={cfg.project_name ?? ''}
                onChange={e => set('project_name', e.target.value)}
                placeholder="e.g. Pouch Line A"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
            </label>
          </Section>

          {/* Product Selector */}
          <Section id="product" title="Product" collapsed={collapsed} onToggle={toggleSection}>
            <div className="flex items-center gap-2 flex-wrap">
              {Object.keys(products).map(pName => (
                <div key={pName} className="flex items-center">
                  <button
                    type="button"
                    onClick={() => handleSwitchProduct(pName)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      pName === activeProduct
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:text-gray-200 border border-gray-700'
                    }`}
                  >
                    {pName}
                  </button>
                  {Object.keys(products).length > 1 && pName === activeProduct && (
                    <button
                      type="button"
                      onClick={() => handleDeleteProduct(pName)}
                      className="ml-1 p-0.5 text-gray-600 hover:text-red-400"
                      title="Delete product"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              ))}
              {showAddProduct ? (
                <div className="flex items-center gap-1 flex-wrap">
                  {Object.keys(products).length > 1 && (
                    <select
                      value={copyFromProduct || Object.keys(products)[0]}
                      onChange={e => setCopyFromProduct(e.target.value)}
                      className="w-28 bg-gray-800 border border-gray-700 rounded-lg px-1.5 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
                      title="Copy settings from"
                    >
                      {Object.keys(products).map(p => (
                        <option key={p} value={p}>Copy: {p}</option>
                      ))}
                    </select>
                  )}
                  <input
                    value={newProductName}
                    onChange={e => setNewProductName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAddProduct()}
                    placeholder="New product name"
                    autoFocus
                    className="w-32 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                  />
                  <button type="button" onClick={handleAddProduct} className="text-xs text-blue-400 hover:text-blue-300">Add</button>
                  <button type="button" onClick={() => { setShowAddProduct(false); setNewProductName(''); setCopyFromProduct('') }} className="text-xs text-gray-600 hover:text-gray-400">Cancel</button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowAddProduct(true)}
                  className="px-2.5 py-1.5 rounded-lg text-xs text-blue-400 hover:text-blue-300 border border-dashed border-gray-700 hover:border-blue-500/50"
                >
                  + Add Product
                </button>
              )}
            </div>
          </Section>

          {/* ── Divider ── */}
          <div className="border-t border-gray-700/40" />

          {/* Camera Settings */}
          <Section id="camera" title="Camera Settings" collapsed={collapsed} onToggle={toggleSection}>
            <div className="space-y-3">

              {/* Camera Type */}
              <div className="grid grid-cols-2 gap-3">
                {([
                  { value: 'basler' as CameraType, icon: Wifi, title: 'Basler GigE', desc: 'Industrial GigE camera via pypylon driver.' },
                  { value: 'webcam' as CameraType, icon: Monitor, title: 'Webcam / USB', desc: 'PC webcam or USB camera via OpenCV.' },
                ]).map(({ value, icon: Icon, title, desc }) => {
                  const active = cfg.camera_type === value
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        set('camera_type', value)
                        // 웹캠 선택 시 camera_ip 기본값을 인덱스로 변경
                        if (value === 'webcam' && (cfg.camera_ip.includes('.') || cfg.camera_ip === '')) {
                          set('camera_ip', '0')
                        } else if (value === 'basler' && !cfg.camera_ip.includes('.')) {
                          set('camera_ip', '192.168.1.')
                        }
                      }}
                      className={`text-left p-3 rounded-xl border transition-all ${
                        active
                          ? 'border-cyan-500/60 bg-cyan-500/10'
                          : 'border-gray-700 bg-gray-800/50 hover:border-gray-600'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <Icon size={13} className={active ? 'text-cyan-400' : 'text-gray-500'} />
                        <span className={`text-xs font-semibold ${active ? 'text-white' : 'text-gray-400'}`}>{title}</span>
                        {active && (
                          <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-cyan-500/20 text-cyan-400">Active</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 leading-relaxed">{desc}</p>
                    </button>
                  )
                })}
              </div>

              {/* Camera Source — IP (Basler) or Device List (Webcam) */}
              {cfg.camera_type === 'webcam' ? (
                <div>
                  {/* 스캔 헤더 */}
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-400">Select Camera Device</span>
                    <button
                      type="button"
                      onClick={scanWebcams}
                      disabled={webcamScanning}
                      className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <RefreshCw size={11} className={webcamScanning ? 'animate-spin' : ''} />
                      {webcamScanning ? 'Scanning…' : webcamScanned ? 'Rescan' : 'Scan'}
                    </button>
                  </div>

                  {/* 결과 목록 */}
                  {webcamScanning ? (
                    <div className="flex items-center gap-2 py-4 justify-center text-gray-600 text-xs">
                      <RefreshCw size={13} className="animate-spin" />
                      Scanning for cameras…
                    </div>
                  ) : webcamScanned && webcamList.length === 0 ? (
                    <p className="text-xs text-gray-600 py-3 text-center">
                      No cameras detected. Enter index manually below.
                    </p>
                  ) : (
                    <div className="space-y-1.5 mb-3">
                      {webcamList.map(cam => {
                        const selected = cfg.camera_ip === cam.index
                        return (
                          <button
                            key={cam.index}
                            type="button"
                            onClick={() => set('camera_ip', cam.index)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all ${
                              selected
                                ? 'border-cyan-500/60 bg-cyan-500/10'
                                : 'border-gray-700 bg-gray-800/50 hover:border-gray-600'
                            }`}
                          >
                            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                              selected ? 'border-cyan-400 bg-cyan-400' : 'border-gray-600'
                            }`}>
                              {selected && <Check size={10} className="text-black" strokeWidth={3} />}
                            </div>
                            <Monitor size={14} className={selected ? 'text-cyan-400' : 'text-gray-500'} />
                            <div>
                              <p className={`text-xs font-medium ${selected ? 'text-white' : 'text-gray-300'}`}>
                                {cam.name}
                              </p>
                              <p className="text-[10px] text-gray-600 font-mono">index: {cam.index}</p>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {/* 수동 입력 (항상 표시 — 폴백용) */}
                  <label className="block">
                    <span className="text-xs text-gray-500 mb-1 block">Manual Index Override</span>
                    <input
                      value={cfg.camera_ip}
                      onChange={e => set('camera_ip', e.target.value)}
                      placeholder="0"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-gray-600 focus:outline-none focus:border-blue-500"
                    />
                    <p className="text-xs text-gray-700 mt-1">0 = default webcam, 1 = second camera, etc.</p>
                  </label>
                </div>
              ) : (
                <label className="block">
                  <span className="text-xs text-gray-400 mb-1 block">Camera IP</span>
                  <input
                    value={cfg.camera_ip}
                    onChange={e => set('camera_ip', e.target.value)}
                    placeholder="192.168.1.100"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-gray-600 focus:outline-none focus:border-blue-500"
                  />
                </label>
              )}

              {/* PFS File — Basler only */}
              {cfg.camera_type === 'basler' && (
                <div className="relative">
                  <span className="text-xs text-gray-400 mb-1 block">PFS File</span>
                  <div className="flex gap-1">
                    <input
                      value={cfg.pfs_file}
                      onChange={e => set('pfs_file', e.target.value)}
                      placeholder="camera.pfs"
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                    />
                    <button
                      type="button"
                      onClick={() => setFileBrowser(fileBrowser?.field === 'pfs' ? null : { field: 'pfs', extensions: '.pfs' })}
                      className={`px-2 rounded-lg border text-xs transition-colors ${
                        fileBrowser?.field === 'pfs' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:border-gray-500'
                      }`}
                      title="Browse files"
                    >
                      <FolderOpen size={14} />
                    </button>
                  </div>
                  {fileBrowser?.field === 'pfs' && (
                    <FileBrowser
                      extensions=".pfs"
                      initialPath={cfg.pfs_file ? undefined : undefined}
                      onSelect={(path) => { set('pfs_file', path); setFileBrowser(null) }}
                      onClose={() => setFileBrowser(null)}
                    />
                  )}
                </div>
              )}

              {/* Camera Mode (shared for inspection & data collection) */}
              <label className="block">
                <span className="text-xs text-gray-400 mb-1 block">Camera Mode</span>
                <div className="flex gap-1">
                  {(['auto', 'trigger', 'continuous'] as const).map(m => {
                    const active = (cfg.collection_mode ?? 'auto') === m
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => set('collection_mode', m)}
                        className={`flex-1 py-2 rounded-lg text-xs font-medium border transition-colors ${
                          active
                            ? m === 'trigger'
                              ? 'bg-amber-600 border-amber-500 text-white'
                              : m === 'continuous'
                              ? 'bg-blue-600 border-blue-500 text-white'
                              : 'bg-gray-600 border-gray-500 text-white'
                            : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:border-gray-500'
                        }`}
                      >
                        {m === 'auto' ? 'Auto' : m === 'trigger' ? 'Trigger' : 'Continuous'}
                      </button>
                    )
                  })}
                </div>
                <p className="text-xs text-gray-600 mt-1">
                  {(cfg.collection_mode ?? 'auto') === 'auto'
                    ? 'Auto-detect from camera TriggerMode (PFS file)'
                    : (cfg.collection_mode ?? 'auto') === 'trigger'
                    ? 'Hardware trigger — inspect/save on trigger signal only'
                    : 'Continuous — inspect/save every frame'}
                </p>
              </label>

              <label className="block">
                <span className="text-xs text-gray-400 mb-1 block">Image Rotation</span>
                <select
                  value={cfg.rotation}
                  onChange={e => set('rotation', e.target.value as RotationType)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="NONE">None</option>
                  <option value="CLOCKWISE_90">Clockwise 90°</option>
                  <option value="COUNTERCLOCKWISE_90">Counter-clockwise 90°</option>
                  <option value="180">180°</option>
                </select>
              </label>
            </div>

            {/* ── Crop Region (ROI) sub-section ── */}
            <div className="border-t border-gray-700/30 pt-3 mt-3">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Crop Region (ROI)</h4>
                <button
                  type="button"
                  onClick={() => setCropEnabled(p => !p)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${cropEnabled ? 'bg-blue-600' : 'bg-gray-700'}`}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${cropEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>
            {cropEnabled ? (
              <div className="space-y-3">
                {!cropImageUrl ? (
                  /* ── Capture / Browse zone ──────────────────── */
                  <div className="space-y-3">
                    {isWorkerRunning ? (
                      <div className="flex flex-col items-center gap-3 py-8">
                        <button
                          type="button"
                          onClick={handleCaptureFrame}
                          disabled={capturingFrame}
                          className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
                        >
                          <Camera size={16} />
                          {capturingFrame ? 'Capturing...' : 'Capture from Camera'}
                        </button>
                        <span className="text-xs text-gray-600">or</span>
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="flex items-center gap-2 px-3 py-1.5 text-gray-400 hover:text-white text-xs border border-gray-700 hover:border-gray-500 rounded-lg transition-colors"
                        >
                          <Upload size={14} />
                          Browse file
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-3 py-8">
                        <div className="flex items-center gap-2 text-yellow-500/80 text-sm">
                          <Monitor size={16} />
                          Camera is not running
                        </div>
                        <p className="text-xs text-gray-600">Start the worker to capture from camera, or select an image file.</p>
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
                        >
                          <Upload size={16} />
                          Browse file
                        </button>
                      </div>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) loadImageFile(f) }}
                    />
                  </div>
                ) : (
                  /* ── Image + drag-select ─────────────────────── */
                  <div className="space-y-2">
                    {/* Image container with selection overlay */}
                    <div
                      ref={imgContainerRef}
                      className="relative select-none overflow-hidden rounded-lg border border-gray-700"
                      style={{ cursor: 'crosshair' }}
                      onMouseDown={handleMouseDown}
                      onMouseMove={handleMouseMove}
                      onMouseUp={finalizeSelection}
                      onMouseLeave={e => { if (isSelecting) finalizeSelection(e) }}
                    >
                      <img
                        src={cropImageUrl}
                        alt="reference"
                        className="w-full h-auto block"
                        draggable={false}
                        onLoad={e => {
                          const img = e.target as HTMLImageElement
                          setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight })
                          if (cfg.crop_region === null) {
                            setCropVals([0, 0, img.naturalWidth, img.naturalHeight])
                          }
                        }}
                      />

                      {/* Selection box with dark vignette outside */}
                      {selBox && selBox.width > 1 && selBox.height > 1 && (
                        <div
                          className="absolute pointer-events-none"
                          style={{
                            left: selBox.left,
                            top: selBox.top,
                            width: selBox.width,
                            height: selBox.height,
                            border: '2px solid #3b82f6',
                            boxShadow: '0 0 0 9999px rgba(0,0,0,0.50)',
                          }}
                        />
                      )}

                      {/* Live coordinate label while dragging */}
                      {isSelecting && liveLabel && (
                        <div className="absolute bottom-2 left-2 bg-black/80 rounded px-2 py-1 text-xs text-blue-300 font-mono pointer-events-none">
                          {liveLabel}
                        </div>
                      )}

                      {/* Hint when idle */}
                      {!isSelecting && (
                        <div className="absolute top-2 left-2 bg-black/60 rounded px-2 py-1 text-xs text-gray-400 pointer-events-none">
                          Drag to select crop region
                        </div>
                      )}

                      {/* Change image buttons */}
                      <div className="absolute top-2 right-2 flex gap-1" onMouseDown={e => e.stopPropagation()}>
                        {isWorkerRunning && (
                          <button
                            onClick={handleCaptureFrame}
                            disabled={capturingFrame}
                            className="bg-black/60 hover:bg-black/85 text-gray-300 hover:text-white rounded px-2 py-1 text-xs transition-colors disabled:opacity-50"
                          >
                            {capturingFrame ? '...' : 'Re-capture'}
                          </button>
                        )}
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="bg-black/60 hover:bg-black/85 text-gray-300 hover:text-white rounded px-2 py-1 text-xs transition-colors"
                        >
                          Browse file
                        </button>
                      </div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) loadImageFile(f) }}
                      />
                    </div>

                  </div>
                )}

                {/* Compact coordinate inputs */}
                <div className="flex items-center gap-1.5 text-[10px] font-mono">
                  {([
                    { label: 'X1', i: 0 },
                    { label: 'Y1', i: 1 },
                    { label: 'X2', i: 2 },
                    { label: 'Y2', i: 3 },
                  ] as { label: string; i: 0 | 1 | 2 | 3 }[]).map(({ label, i }) => (
                    <label key={i} className="flex items-center gap-0.5">
                      <span className="text-gray-500 shrink-0">{label}</span>
                      <input
                        type="number"
                        min={0}
                        value={cropVals[i]}
                        onChange={e => {
                          const next = [...cropVals] as [number, number, number, number]
                          next[i] = +e.target.value
                          setCropVals(next)
                        }}
                        className="w-14 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[10px] text-white focus:outline-none focus:border-blue-500 font-mono"
                      />
                    </label>
                  ))}
                  <span className="text-gray-600 ml-1">
                    ({cropVals[2] - cropVals[0]}×{cropVals[3] - cropVals[1]})
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-600">Disabled — full frame is used.</p>
            )}
            </div>
          </Section>

          {/* ── Divider ── */}
          <div className="border-t border-gray-700/40" />

          {/* AI Model Settings */}
          <Section id="ai" title="AI Model Settings" collapsed={collapsed} onToggle={toggleSection}>
            <div className="space-y-3">
              {/* Detector Type */}
              <div>
                <span className="text-xs text-gray-400 mb-2 block">Detector Type</span>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { value: 'yolo', title: 'YOLO', desc: 'Object detection' },
                    { value: 'paddleocr', title: 'PaddleOCR', desc: 'Text recognition' },
                    { value: 'cnn', title: 'CNN', desc: 'Image classification' },
                  ] as const).map(({ value, title, desc }) => {
                    const active = (cfg.detector_type ?? 'yolo') === value
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => handleDetectorTypeChange(value)}
                        className={`text-left p-2.5 rounded-xl border transition-all ${
                          active
                            ? 'border-blue-500/60 bg-blue-500/10'
                            : 'border-gray-700 bg-gray-800/50 hover:border-gray-600'
                        }`}
                      >
                        <span className={`text-xs font-semibold ${active ? 'text-white' : 'text-gray-400'}`}>
                          {title}
                        </span>
                        <p className="text-[10px] text-gray-600 mt-0.5">{desc}</p>
                      </button>
                    )
                  })}
                </div>
              </div>
              {/* Weights / Model Path with Browse */}
              <div className="relative">
                <span className="text-xs text-gray-400 mb-1 block">
                  {(cfg.detector_type ?? 'yolo') === 'paddleocr' ? 'Model Directory' :
                   (cfg.detector_type ?? 'yolo') === 'cnn' ? 'Model File Path' :
                   'Weights File Path'}
                </span>
                <div className="flex gap-1">
                  <input
                    value={cfg.model_path}
                    onChange={e => set('model_path', e.target.value)}
                    placeholder={
                      (cfg.detector_type ?? 'yolo') === 'paddleocr' ? '(leave empty for default)' :
                      (cfg.detector_type ?? 'yolo') === 'cnn' ? './weights/classifier.pth' :
                      './weights/best.pt'
                    }
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => setFileBrowser(fileBrowser?.field === 'model' ? null : {
                      field: 'model',
                      extensions: (cfg.detector_type ?? 'yolo') === 'cnn' ? '.pth,.pt' : '.pt',
                    })}
                    className={`px-2 rounded-lg border text-xs transition-colors ${
                      fileBrowser?.field === 'model' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:border-gray-500'
                    }`}
                    title="Browse files"
                  >
                    <FolderOpen size={14} />
                  </button>
                </div>
                {fileBrowser?.field === 'model' && (
                  <FileBrowser
                    extensions={fileBrowser.extensions}
                    onSelect={(path) => { set('model_path', path); setFileBrowser(null) }}
                    onClose={() => setFileBrowser(null)}
                  />
                )}
              </div>

              {/* YAML Data File (for YOLO class names) */}
              {(cfg.detector_type ?? 'yolo') === 'yolo' && (
                <div className="relative">
                  <span className="text-xs text-gray-400 mb-1 block">YAML Data File <span className="text-gray-600">(auto-fills reject thresholds)</span></span>
                  <div className="flex gap-1">
                    <input
                      value={cfg.data_yaml ?? './weights/data.yaml'}
                      onChange={e => set('data_yaml', e.target.value)}
                      placeholder="./weights/data.yaml"
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                    />
                    <button
                      type="button"
                      onClick={() => setFileBrowser(fileBrowser?.field === 'yaml' ? null : { field: 'yaml', extensions: '.yaml,.yml' })}
                      className={`px-2 rounded-lg border text-xs transition-colors ${
                        fileBrowser?.field === 'yaml' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:border-gray-500'
                      }`}
                      title="Browse files"
                    >
                      <FolderOpen size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleYamlSelect(cfg.data_yaml ?? './weights/data.yaml')}
                      className="px-2 rounded-lg border border-gray-700 bg-gray-800 text-xs text-gray-400 hover:text-white hover:border-gray-500 transition-colors"
                      title="Load YAML and set reject thresholds"
                    >
                      <RefreshCw size={14} />
                    </button>
                  </div>
                  {fileBrowser?.field === 'yaml' && (
                    <FileBrowser
                      extensions=".yaml,.yml"
                      onSelect={handleYamlSelect}
                      onClose={() => setFileBrowser(null)}
                    />
                  )}
                </div>
              )}

              {/* Inference Device */}
              <label className="block">
                <span className="text-xs text-gray-400 mb-1 block">Inference Device</span>
                <select
                  value={gpuList.length === 0 && cfg.device !== 'cpu' ? 'cpu' : cfg.device}
                  onChange={e => set('device', e.target.value as DeviceType)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="cpu">CPU</option>
                  {gpuList.length > 0 && (
                    gpuList.map(g => (
                      <option key={g.device} value={g.device}>
                        {g.device} — {g.name} ({Math.round(g.total_mb / 1024)}GB)
                      </option>
                    ))
                  )}
                </select>
                {gpuList.length > 1 && (
                  <p className="text-xs text-gray-500 mt-1">{gpuList.length} GPUs detected</p>
                )}
              </label>
              {/* PaddleOCR Configuration */}
              {(cfg.detector_type ?? 'yolo') === 'paddleocr' && (
                <div className="space-y-3 p-3 rounded-lg bg-gray-800/30 border border-gray-700/50">
                  <span className="text-xs text-gray-500 font-medium">PaddleOCR Settings</span>

                  {/* Performance Presets */}
                  <div>
                    <span className="text-xs text-gray-400 mb-2 block">Performance Preset</span>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        {
                          label: '⚡ Speed',
                          desc: 'Fastest',
                          config: { use_gpu: true, use_angle_cls: false, det_limit_side_len: 480, rec_batch_num: 10 }
                        },
                        {
                          label: '⚖️ Balanced',
                          desc: 'Recommended',
                          config: { use_gpu: true, use_angle_cls: true, det_limit_side_len: 960, rec_batch_num: 6 }
                        },
                        {
                          label: '🎯 Accurate',
                          desc: 'Best quality',
                          config: { use_gpu: true, use_angle_cls: true, det_limit_side_len: 1280, rec_batch_num: 3, use_dilation: true }
                        }
                      ].map((preset) => {
                        const isActive =
                          cfg.detector_config?.det_limit_side_len === preset.config.det_limit_side_len &&
                          cfg.detector_config?.rec_batch_num === preset.config.rec_batch_num
                        return (
                          <button
                            key={preset.label}
                            type="button"
                            onClick={() => {
                              Object.entries(preset.config).forEach(([key, val]) => {
                                setDetectorConfig(key as any, val)
                              })
                            }}
                            className={`text-left p-2 rounded-lg border transition-all text-xs ${
                              isActive
                                ? 'border-blue-500/60 bg-blue-500/10'
                                : 'border-gray-700 bg-gray-800/50 hover:border-gray-600'
                            }`}
                          >
                            <div className={`font-semibold ${isActive ? 'text-blue-400' : 'text-gray-300'}`}>{preset.label}</div>
                            <div className="text-gray-600 text-[10px]">{preset.desc}</div>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-xs text-gray-400 mb-1 block">Language</span>
                      <select
                        value={cfg.detector_config?.lang ?? 'en'}
                        onChange={e => setDetectorConfig('lang', e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                      >
                        <option value="en">English</option>
                        <option value="korean">Korean</option>
                        <option value="japan">Japanese</option>
                        <option value="ch">Chinese</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-xs text-gray-400 mb-1 block">Folder Name</span>
                      <input
                        value={cfg.detector_config?.class_name ?? 'date_check'}
                        onChange={e => setDetectorConfig('class_name', e.target.value)}
                        placeholder="e.g. date_check"
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                      />
                    </label>
                  </div>
                  <label className="block">
                    <span className="text-xs text-gray-400 mb-1 block">Change Date Pattern</span>
                    <input
                      value={displayFormat(cfg.detector_config?.change_date ?? '')}
                      onChange={e => setDetectorConfig('change_date', regexFormat(e.target.value))}
                      placeholder="e.g. 2011.11.11"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                    />
                  </label>
                  <p className="text-xs text-gray-600 mb-3">
                    ✅ If the date pattern is <strong>found</strong> → Normal (signal OFF)<br/>
                    ❌ If the date pattern is <strong>NOT found</strong> → Defect (signal ON)
                  </p>

                  {/* Advanced Performance Tuning */}
                  <div className="border-t border-gray-700/50 pt-3">
                    <span className="text-xs text-gray-400 font-medium block mb-2">Advanced Tuning</span>
                    <div className="space-y-2">
                      <label className="block">
                        <span className="text-xs text-gray-500 mb-1 block">Detection Image Size</span>
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min={320}
                            max={1920}
                            step={160}
                            value={cfg.detector_config?.det_limit_side_len ?? 960}
                            onChange={e => setDetectorConfig('det_limit_side_len', parseInt(e.target.value))}
                            className="flex-1"
                          />
                          <span className="text-xs text-gray-400 w-12 text-right font-mono">{cfg.detector_config?.det_limit_side_len ?? 960}</span>
                        </div>
                        <p className="text-[10px] text-gray-700 mt-1">Smaller = faster, Larger = more accurate</p>
                      </label>

                      <label className="block">
                        <span className="text-xs text-gray-500 mb-1 block">Recognition Batch Size</span>
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min={1}
                            max={32}
                            step={1}
                            value={cfg.detector_config?.rec_batch_num ?? 6}
                            onChange={e => setDetectorConfig('rec_batch_num', parseInt(e.target.value))}
                            className="flex-1"
                          />
                          <span className="text-xs text-gray-400 w-8 text-right font-mono">{cfg.detector_config?.rec_batch_num ?? 6}</span>
                        </div>
                        <p className="text-[10px] text-gray-700 mt-1">Larger = faster but more memory</p>
                      </label>

                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={cfg.detector_config?.use_angle_cls ?? true}
                          onChange={e => setDetectorConfig('use_angle_cls', e.target.checked)}
                          className="w-4 h-4 bg-gray-700 border border-gray-600 rounded"
                        />
                        <span className="text-xs text-gray-400">Detect Rotated Text</span>
                      </label>

                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={cfg.detector_config?.use_dilation ?? false}
                          onChange={e => setDetectorConfig('use_dilation', e.target.checked)}
                          className="w-4 h-4 bg-gray-700 border border-gray-600 rounded"
                        />
                        <span className="text-xs text-gray-400">Dilate Detection Regions</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* CNN Configuration */}
              {(cfg.detector_type ?? 'yolo') === 'cnn' && (
                <div className="space-y-3 p-3 rounded-lg bg-gray-800/30 border border-gray-700/50">
                  <span className="text-xs text-gray-500 font-medium">CNN Classifier Settings</span>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-xs text-gray-400 mb-1 block">Input Size</span>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          value={cfg.detector_config?.input_size?.[0] ?? 224}
                          onChange={e => setDetectorConfig('input_size', [+e.target.value, cfg.detector_config?.input_size?.[1] ?? 224])}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                        />
                        <span className="text-gray-500 text-xs shrink-0">×</span>
                        <input
                          type="number"
                          min={1}
                          value={cfg.detector_config?.input_size?.[1] ?? 224}
                          onChange={e => setDetectorConfig('input_size', [cfg.detector_config?.input_size?.[0] ?? 224, +e.target.value])}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                        />
                      </div>
                    </label>
                    <label className="block">
                      <span className="text-xs text-gray-400 mb-1 block">Class Names</span>
                      <input
                        value={(cfg.detector_config?.class_names ?? ['ok', 'ng']).join(', ')}
                        onChange={e => setDetectorConfig('class_names', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                        placeholder="ok, ng"
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                      />
                      <p className="text-xs text-gray-600 mt-1">Comma-separated class labels</p>
                    </label>
                  </div>
                </div>
              )}

              {/* Reject Thresholds — NOT for PaddleOCR */}
              {(cfg.detector_type ?? 'yolo') !== 'paddleocr' && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-400">Reject Thresholds</span>
                    <button
                      onClick={() => setThresholds(prev => [...prev, ['', 0.70]])}
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >
                      + Add
                    </button>
                  </div>
                  {products[activeProduct]?.detector_type === 'yolo' && (
                    <p className="text-xs text-gray-600 mb-2">
                      For YOLO: Keys are class names. Objects with confidence below threshold are rejected.
                    </p>
                  )}
                  <div className="space-y-2">
                    {thresholds.map(([cls, thr], i) => (
                      <div key={i} className="flex gap-2 items-center">
                        <input
                          value={cls}
                          onChange={e => {
                            const next = [...thresholds]
                            next[i] = [e.target.value, thr]
                            setThresholds(next)
                          }}
                          placeholder="class name"
                          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                        />
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={thr}
                          onChange={e => {
                            const next = [...thresholds]
                            next[i] = [cls, parseFloat(e.target.value)]
                            setThresholds(next)
                          }}
                          className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                        />
                        <button
                          onClick={() => setThresholds(prev => prev.filter((_, j) => j !== i))}
                          className="text-gray-600 hover:text-red-400"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Save Thresholds (Borderline) */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-400">Save Thresholds</span>
                  <button
                    onClick={() => setSaveThresholds(prev => [...prev, ['', 0.30]])}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    + Add
                  </button>
                </div>
                <p className="text-xs text-gray-600 mb-2">
                  Saves borderline images below reject threshold but above this value.
                </p>
                <div className="space-y-2">
                  {saveThresholds.map(([cls, thr], i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input
                        value={cls}
                        onChange={e => {
                          const next = [...saveThresholds]
                          next[i] = [e.target.value, thr]
                          setSaveThresholds(next)
                        }}
                        placeholder="class name"
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                      />
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={thr}
                        onChange={e => {
                          const next = [...saveThresholds]
                          next[i] = [cls, parseFloat(e.target.value)]
                          setSaveThresholds(next)
                        }}
                        className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                      />
                      <button
                        onClick={() => setSaveThresholds(prev => prev.filter((_, j) => j !== i))}
                        className="text-gray-600 hover:text-red-400"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Show Threshold (Dashboard display threshold) */}
              {(cfg.detector_type ?? 'yolo') !== 'paddleocr' && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-400">Show Threshold (Dashboard)</span>
                    <span className="text-xs text-gray-500 font-mono">{(cfg.show_threshold ?? 0.3).toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={cfg.show_threshold ?? 0.3}
                    onChange={e => set('show_threshold', parseFloat(e.target.value))}
                    className="w-full"
                  />
                  <p className="text-xs text-gray-600 mt-1">
                    Show detection boxes above this confidence on dashboard stream. Does NOT affect reject behavior.
                  </p>
                </div>
              )}
            </div>
          </Section>

          {/* ── Divider ── */}
          <div className="border-t border-gray-700/40" />

          {/* Reject Settings */}
          <Section id="reject" title="Reject Settings" collapsed={collapsed} onToggle={toggleSection}>
            <div className="grid grid-cols-2 gap-3">

              {/* ── 딜레이 (카메라 모드에 따라 달라짐) ── */}
              {(cfg.collection_mode ?? 'auto') === 'continuous' ? (
                /* 연속 모드: 초 단위 딜레이 */
                <label className="block">
                  <span className="text-xs text-gray-400 mb-1 block">Reject Delay (sec)</span>
                  <input
                    type="number"
                    min={0.01}
                    step={0.01}
                    value={cfg.reject_delay_seconds ?? ''}
                    placeholder="e.g. 1.0"
                    onChange={e => set('reject_delay_seconds', e.target.value ? +e.target.value : null)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
                  />
                  <p className="text-xs text-gray-600 mt-1">FPS measured at startup → auto-converts to frames</p>
                </label>
              ) : (
                /* 트리거 / auto 모드: 프레임 단위 딜레이 */
                <label className="block">
                  <span className="text-xs text-gray-400 mb-1 block">Delay Frames</span>
                  <input
                    type="number"
                    min={1}
                    value={cfg.reject_delay_frames}
                    onChange={e => set('reject_delay_frames', +e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                </label>
              )}

              {/* ── Reject Positions ── */}
              <label className="block">
                <span className="text-xs text-gray-400 mb-1 block">Reject Positions</span>
                <input
                  type="number"
                  min={1}
                  value={cfg.reject_positions}
                  onChange={e => set('reject_positions', +e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                />
                <p className="text-xs text-gray-600 mt-1">Trailing window slots to check</p>
              </label>

              {/* ── Reject Mode ── */}
              <label className="block col-span-2">
                <span className="text-xs text-gray-400 mb-1 block">Reject Mode</span>
                <div className="flex gap-1">
                  {(['individual', 'continuous'] as const).map(m => {
                    const active = (cfg.reject_mode ?? 'individual') === m
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => set('reject_mode', m)}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          active
                            ? 'bg-blue-600 border-blue-600 text-white'
                            : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                        }`}
                      >
                        {m === 'individual' ? 'Individual (×N shots)' : 'Continuous (1 long burst)'}
                      </button>
                    )
                  })}
                </div>
                <p className="text-xs text-gray-600 mt-1">
                  {(cfg.reject_mode ?? 'individual') === 'individual'
                    ? `Fires ${cfg.reject_positions} separate shot${cfg.reject_positions > 1 ? 's' : ''}, each ${cfg.time_valve_on}s — pre-valve delay applies to each`
                    : cfg.reject_positions > 1
                      ? `Valve ON at pos -${cfg.reject_positions} (after pre-valve delay), OFF at pos -1 (after valve-on time)`
                      : `Single position: pre-valve delay → ON → valve-on time → OFF`}
                </p>
              </label>

              {/* ── Valve On Time ── */}
              <label className="block">
                <span className="text-xs text-gray-400 mb-1 block">
                  Valve On Time (sec)
                  {(cfg.reject_mode ?? 'individual') === 'continuous' && cfg.reject_positions > 1
                    ? ' — applied at last position'
                    : ''}
                </span>
                <input
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={cfg.time_valve_on}
                  onChange={e => set('time_valve_on', +e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </label>

              {/* ── Pre-Valve Delay ── */}
              <label className="block">
                <span className="text-xs text-gray-400 mb-1 block">
                  Pre-Valve Delay (sec)
                  {(cfg.reject_mode ?? 'individual') === 'continuous' && cfg.reject_positions > 1
                    ? ' — applied at first position'
                    : ''}
                </span>
                <input
                  type="number"
                  step={0.01}
                  value={cfg.pre_valve_delay}
                  onChange={e => set('pre_valve_delay', +e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </label>

              {/* ── 트리거 모드 전용: 센서→카메라 딜레이 ── */}
              {(cfg.collection_mode ?? 'auto') === 'trigger' && (
                <label className="block col-span-2">
                  <span className="text-xs text-gray-400 mb-1 block">Trigger Delay (µs)</span>
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={cfg.trigger_delay_us ?? ''}
                    placeholder="e.g. 5000 (= 5ms)"
                    onChange={e => set('trigger_delay_us', e.target.value ? +e.target.value : null)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
                  />
                  <p className="text-xs text-gray-600 mt-1">
                    Camera hardware delay after sensor trigger fires (TriggerDelayAbs). 1,000 µs = 1 ms.
                  </p>
                </label>
              )}

              {/* ── 트리거 노이즈 제거 ── */}
              {(cfg.collection_mode ?? 'auto') === 'trigger' && (
                <label className="block col-span-2">
                  <span className="text-xs text-gray-400 mb-1 block">Trigger Debounce (µs)</span>
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={cfg.trigger_debounce_us ?? ''}
                    placeholder="e.g. 500 (= 0.5ms)"
                    onChange={e => set('trigger_debounce_us', e.target.value ? +e.target.value : null)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
                  />
                  <p className="text-xs text-gray-600 mt-1">
                    Ignore trigger pulses shorter than this duration (LineDebouncerHighTime). Filters out electrical noise.
                  </p>
                </label>
              )}

            </div>
          </Section>

          <div className="border-t border-gray-700/40" />

          {/* Data Storage */}
          <Section id="storage" title="Data Storage" collapsed={collapsed} onToggle={toggleSection}>
            <div className="space-y-3">
              <label className="block">
                <span className="text-xs text-gray-400 mb-1 block">Save Folder</span>
                <input
                  type="text"
                  value={cfg.save_root}
                  onChange={e => set('save_root', e.target.value)}
                  placeholder="e.g. ./data or /mnt/nas/product-a"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
                />
                <p className="text-xs text-gray-600 mt-1">
                  Root directory for saving defect images. Can be absolute or relative path.
                </p>
              </label>
              <label className="block">
                <span className="text-xs text-gray-400 mb-1 block">Retention Days</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={cfg.retention_days}
                  onChange={e => set('retention_days', +e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                />
                <p className="text-xs text-gray-600 mt-1">
                  Days to keep data. 0 = unlimited.
                </p>
              </label>
            </div>
          </Section>

        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex gap-3 shrink-0">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors border border-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
          >
            <Save size={14} />
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
