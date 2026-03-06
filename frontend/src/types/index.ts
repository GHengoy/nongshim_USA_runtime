export type RotationType = 'CLOCKWISE_90' | 'COUNTERCLOCKWISE_90' | '180' | 'NONE'
export type DeviceType = string  // 'cpu' | 'cuda' | 'cuda:0' | 'cuda:1' | ...

export interface GpuInfo {
  index: number
  device: string   // e.g. 'cuda:0'
  name: string
  total_mb: number
}
export type WorkerStatus = 'running' | 'stopped' | 'error' | 'initializing'
export type CameraType = 'basler' | 'webcam'
export type DetectorType = 'yolo' | 'paddleocr' | 'cnn'

export interface ProductConfig {
  rotation: RotationType
  crop_region: [number, number, number, number] | null
  model_path: string
  class_thresholds: Record<string, number> | null
  save_thresholds: Record<string, number> | null
  device: DeviceType
  reject_delay_frames: number
  reject_delay_seconds?: number | null
  reject_positions: number
  reject_mode?: 'individual' | 'continuous'
  time_valve_on: number
  pre_valve_delay: number
  trigger_delay_us?: number | null
  trigger_debounce_us?: number | null
  save_root: string
  retention_days: number
  max_preview: number
  save_normal: boolean
  detector_type?: DetectorType
  detector_config?: Record<string, any> | null
  show_threshold?: number
  data_yaml?: string
}

export interface InspectionConfig {
  line_name: string
  project_name: string   // 화면 표시명 + 저장 폴더명 (자유 변경)
  enabled: boolean
  camera_type: CameraType
  camera_ip: string   // Basler: IP 주소 / Webcam: 인덱스 문자열 ("0", "1", ...)
  pfs_file: string
  collection_mode?: 'auto' | 'trigger' | 'continuous'
  rotation: RotationType
  crop_region: [number, number, number, number] | null
  model_path: string
  class_thresholds: Record<string, number> | null
  save_thresholds: Record<string, number> | null
  device: DeviceType
  reject_delay_frames: number
  reject_delay_seconds?: number | null
  reject_positions: number
  reject_mode?: 'individual' | 'continuous'
  time_valve_on: number
  pre_valve_delay: number
  trigger_delay_us?: number | null
  trigger_debounce_us?: number | null
  save_root: string
  retention_days: number
  max_preview: number
  save_normal: boolean
  detector_type?: DetectorType
  detector_config?: Record<string, any> | null
  show_threshold?: number
  data_yaml?: string
  active_product?: string
  products?: Record<string, ProductConfig>
}

export interface WorkerStats {
  line_name: string
  project_name?: string
  status: WorkerStatus
  fps: number
  total_count: number
  defect_count: number
  defect_rate: string
  last_error: string
  reject_window_size?: number
  reject_window_marks?: number[]
  init_stage?: string
  init_current?: number
  init_total?: number
  worker_folder?: string
}

export interface InspectionLine {
  config: InspectionConfig
  stats: WorkerStats
}

export interface DefectRecord {
  id: string
  line_name: string
  timestamp: string
  confidence: number
  class_name: string
  image_url: string
}

export interface HistoryRecord {
  id: string
  category: 'defect' | 'borderline'
  line_name: string
  class_name: string
  confidence: number
  timestamp: string
  date: string
  image_url: string
  mark_url: string | null
}

export interface HistoryResponse {
  records: HistoryRecord[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface HistoryFilters {
  lines: string[]
  classes: string[]
  dates: string[]
}

// ── Storage Settings ─────────────────────────────────────────────

export type StorageType = 'local' | 's3'

export interface StorageSettings {
  local_retention_days: number
  storage_type: StorageType
  s3_bucket: string
  s3_region: string
  s3_access_key: string
  s3_secret_key: string
  s3_prefix: string
  s3_retention_days: number
  s3_cleanup_interval_hours: number
  s3_sync_stats?: {
    queue_size: number
    uploaded: number
    errors: number
  }
}

// ── Storage Browser ─────────────────────────────────────────────

export interface BrowseItem {
  name: string
  type: 'folder' | 'file'
  size: number | null
  modified: string | null
  path: string
  item_count?: number
}

export interface BrowseResponse {
  items: BrowseItem[]
  current_path: string
  parent_path: string | null
  save_root: string | null
  storage_type: string
  truncated: boolean
}

// ── Data Collection ──────────────────────────────────────────────

export type CollectionMode = 'trigger' | 'continuous'

export interface CollectionLineInfo {
  line_name: string
  camera_type: CameraType
  camera_ip: string
  worker_running: boolean
  collection_active: boolean
}

export interface CollectionStats {
  line_name: string
  status: string
  detected_mode: CollectionMode
  fps: number
  saved_count: number
  pending_saves: number
  last_error: string
}
