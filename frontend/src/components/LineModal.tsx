import { useState, useRef, useEffect } from 'react'
import { X, Save, Upload, Wifi, Monitor, RefreshCw, Check } from 'lucide-react'
import { InspectionLine, InspectionConfig, ProductConfig, RotationType, DeviceType, CameraType, DetectorType } from '../types'
import * as api from '../api'

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
  reject_positions: 1,
  time_valve_on: 0.1,
  pre_valve_delay: 0.25,
  save_root: './data',
  retention_days: 180,
  max_preview: 50,
  save_normal: false,
  detector_type: 'yolo',
  detector_config: null,
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
        reject_delay_frames: cfg.reject_delay_frames, reject_positions: cfg.reject_positions,
        time_valve_on: cfg.time_valve_on, pre_valve_delay: cfg.pre_valve_delay,
        save_root: cfg.save_root, retention_days: cfg.retention_days,
        max_preview: cfg.max_preview, save_normal: cfg.save_normal,
        detector_type: cfg.detector_type ?? 'yolo',
        detector_config: cfg.detector_config ?? null,
      },
    }
  })
  const [activeProduct, setActiveProduct] = useState<string>(cfg.active_product ?? 'Default')
  const [showAddProduct, setShowAddProduct] = useState(false)
  const [newProductName, setNewProductName] = useState('')

  // Webcam scan state
  const [webcamList, setWebcamList] = useState<api.WebcamDevice[]>([])
  const [webcamScanning, setWebcamScanning] = useState(false)
  const [webcamScanned, setWebcamScanned] = useState(false)

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

  // line prop 변경 시 cfg 동기화 (임계값 변경 후 설정 모달 열 때)
  useEffect(() => {
    if (line?.config) {
      setCfg(line.config)
      setThresholds(Object.entries(line.config.class_thresholds ?? { defect: 0.70 }))
      setSaveThresholds(Object.entries(line.config.save_thresholds ?? {}))
      setCropEnabled(line.config.crop_region !== null)
      setCropVals(line.config.crop_region ?? [0, 0, 1920, 1080])
      setActiveProduct(line.config.active_product ?? 'Default')
      // products 재초기화
      if (line.config.products && Object.keys(line.config.products).length > 0) {
        setProducts(line.config.products)
      } else {
        setProducts({
          Default: {
            rotation: line.config.rotation, crop_region: line.config.crop_region,
            model_path: line.config.model_path, class_thresholds: line.config.class_thresholds,
            save_thresholds: line.config.save_thresholds, device: line.config.device,
            reject_delay_frames: line.config.reject_delay_frames, reject_positions: line.config.reject_positions,
            time_valve_on: line.config.time_valve_on, pre_valve_delay: line.config.pre_valve_delay,
            save_root: line.config.save_root, retention_days: line.config.retention_days,
            max_preview: line.config.max_preview, save_normal: line.config.save_normal,
            detector_type: line.config.detector_type ?? 'yolo',
            detector_config: line.config.detector_config ?? null,
          },
        })
      }
    }
  }, [line?.config.line_name]) // line_name을 key로 사용해서 실제 변경만 감지

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
  const imgContainerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
    time_valve_on: cfg.time_valve_on, pre_valve_delay: cfg.pre_valve_delay,
    // save_root과 retention_days는 라인 레벨 고정값 (storage 페이지에서 관리)
    save_root: './data', retention_days: 180,
    max_preview: cfg.max_preview, save_normal: cfg.save_normal,
    detector_type: cfg.detector_type ?? 'yolo',
    detector_config: cfg.detector_config ?? null,
  })

  const loadProductIntoForm = (product: ProductConfig) => {
    setCfg(prev => ({
      ...prev,
      rotation: product.rotation,
      model_path: product.model_path, device: product.device,
      reject_delay_frames: product.reject_delay_frames, reject_positions: product.reject_positions,
      time_valve_on: product.time_valve_on, pre_valve_delay: product.pre_valve_delay,
      save_root: product.save_root, retention_days: product.retention_days,
      max_preview: product.max_preview, save_normal: product.save_normal,
      detector_type: product.detector_type ?? 'yolo',
      detector_config: product.detector_config ?? null,
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
    const currentFields = extractProductFields()
    const updated = { ...products, [activeProduct]: currentFields, [name]: { ...currentFields } }
    setProducts(updated)
    loadProductIntoForm(updated[name])
    setActiveProduct(name)
    setNewProductName('')
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
      // Data storage 고정값 (storage 페이지에서 관리)
      save_root: './data',
      retention_days: 180,
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
          <section>
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Basic Info</h3>

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
          </section>

          {/* Product Selector */}
          <section>
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Product</h3>
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
                <div className="flex items-center gap-1">
                  <input
                    value={newProductName}
                    onChange={e => setNewProductName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAddProduct()}
                    placeholder="Product name"
                    autoFocus
                    className="w-32 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                  />
                  <button type="button" onClick={handleAddProduct} className="text-xs text-blue-400 hover:text-blue-300">Add</button>
                  <button type="button" onClick={() => { setShowAddProduct(false); setNewProductName('') }} className="text-xs text-gray-600 hover:text-gray-400">Cancel</button>
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
          </section>

          {/* ── Divider ── */}
          <div className="border-t border-gray-700/40" />

          {/* Camera Settings */}
          <section>
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Camera Settings</h3>
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
                <label className="block">
                  <span className="text-xs text-gray-400 mb-1 block">PFS File</span>
                  <input
                    value={cfg.pfs_file}
                    onChange={e => set('pfs_file', e.target.value)}
                    placeholder="camera.pfs"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                  />
                </label>
              )}

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
          </section>

          {/* Crop Region (ROI) */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Crop Region (ROI)</h3>
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
                  /* ── Drop zone ──────────────────────────────── */
                  <>
                    <div
                      onDragOver={e => { e.preventDefault(); setIsDragOver(true) }}
                      onDragLeave={() => setIsDragOver(false)}
                      onDrop={e => {
                        e.preventDefault()
                        setIsDragOver(false)
                        const f = e.dataTransfer.files[0]
                        if (f) loadImageFile(f)
                      }}
                      onClick={() => fileInputRef.current?.click()}
                      className={`border-2 border-dashed rounded-xl flex flex-col items-center justify-center py-16 cursor-pointer transition-colors ${
                        isDragOver
                          ? 'border-blue-500 bg-blue-500/5'
                          : 'border-gray-700 hover:border-gray-600 hover:bg-gray-800/30'
                      }`}
                    >
                      <Upload size={28} className={isDragOver ? 'text-blue-400' : 'text-gray-600'} />
                      <p className={`text-sm mt-3 font-medium ${isDragOver ? 'text-blue-400' : 'text-gray-500'}`}>
                        Drop an image here, or click to browse
                      </p>
                      <p className="text-xs text-gray-700 mt-1">
                        Used only as a visual reference — not uploaded anywhere
                      </p>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) loadImageFile(f) }}
                    />
                  </>
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

                      {/* Change image button */}
                      <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={() => {
                          if (cropImageUrl) URL.revokeObjectURL(cropImageUrl)
                          setCropImageUrl(null)
                          setNaturalSize(null)
                          setSelStart(null)
                          setSelEnd(null)
                        }}
                        className="absolute top-2 right-2 bg-black/60 hover:bg-black/85 text-gray-300 hover:text-white rounded px-2 py-1 text-xs transition-colors"
                      >
                        Change image
                      </button>
                    </div>

                    {/* Coordinate inputs */}
                    <div className="grid grid-cols-4 gap-2">
                      {([
                        { label: 'X1 (left)', i: 0 },
                        { label: 'Y1 (top)', i: 1 },
                        { label: 'X2 (right)', i: 2 },
                        { label: 'Y2 (bottom)', i: 3 },
                      ] as { label: string; i: 0 | 1 | 2 | 3 }[]).map(({ label, i }) => (
                        <label key={i} className="block">
                          <span className="text-xs text-gray-500 mb-1 block">{label}</span>
                          <input
                            type="number"
                            min={0}
                            value={cropVals[i]}
                            onChange={e => {
                              const next = [...cropVals] as [number, number, number, number]
                              next[i] = +e.target.value
                              setCropVals(next)
                            }}
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 font-mono"
                          />
                        </label>
                      ))}
                    </div>

                    {/* Size summary */}
                    {naturalSize && (
                      <p className="text-xs text-gray-600 font-mono">
                        Image: {naturalSize.w} × {naturalSize.h} px
                        {' · '}
                        ROI: {cropVals[2] - cropVals[0]} × {cropVals[3] - cropVals[1]} px
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-gray-600">Disabled — full frame is used.</p>
            )}
          </section>

          {/* ── Divider ── */}
          <div className="border-t border-gray-700/40" />

          {/* AI Model Settings */}
          <section>
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">AI Model Settings</h3>
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
              <label className="block">
                <span className="text-xs text-gray-400 mb-1 block">
                  {(cfg.detector_type ?? 'yolo') === 'paddleocr' ? 'Model Directory' :
                   (cfg.detector_type ?? 'yolo') === 'cnn' ? 'Model File Path' :
                   'Weights File Path'}
                </span>
                <input
                  value={cfg.model_path}
                  onChange={e => set('model_path', e.target.value)}
                  placeholder={
                    (cfg.detector_type ?? 'yolo') === 'paddleocr' ? '(leave empty for default)' :
                    (cfg.detector_type ?? 'yolo') === 'cnn' ? './weights/classifier.pth' :
                    './weights/best.pt'
                  }
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-400 mb-1 block">Inference Device</span>
                <select
                  value={cfg.device}
                  onChange={e => set('device', e.target.value as DeviceType)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="cuda">CUDA (GPU)</option>
                  <option value="cpu">CPU</option>
                </select>
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

              {/* Class Thresholds (Reject) — NOT for PaddleOCR */}
              {(cfg.detector_type ?? 'yolo') !== 'paddleocr' && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-400">Class Thresholds</span>
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
            </div>
          </section>

          {/* ── Divider ── */}
          <div className="border-t border-gray-700/40" />

          {/* Reject Settings */}
          <section>
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Reject Settings</h3>
            <div className="grid grid-cols-2 gap-3">
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
              <label className="block">
                <span className="text-xs text-gray-400 mb-1 block">Valve On Time (sec)</span>
                <input
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={cfg.time_valve_on}
                  onChange={e => set('time_valve_on', +e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-400 mb-1 block">Pre-Valve Delay (sec)</span>
                <input
                  type="number"
                  step={0.01}
                  value={cfg.pre_valve_delay}
                  onChange={e => set('pre_valve_delay', +e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </label>
            </div>
          </section>

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
