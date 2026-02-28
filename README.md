# Ansung Vision Inspection Framework

A real-time AI vision inspection system for factory production lines. Detects product defects using YOLOv12 and controls conveyor belt reject signals.

**Key Features:**
- Real-time defect detection with YOLOv12 (Ultralytics)
- Multi-camera support (Basler GigE, USB webcam)
- Web-based dashboard with React
- Pluggable detector system (YOLO, PaddleOCR, CNN)
- WebSocket video streaming
- File-based data management with auto-archiving

---

## 📋 System Requirements

### Hardware
- **CPU**: Intel i5/i7 or equivalent (4+ cores)
- **RAM**: 8GB minimum (16GB recommended)
- **GPU**: NVIDIA CUDA-compatible GPU (optional but recommended for real-time inference)
- **Storage**: 50GB+ free space (for model weights and defect data)

### Software
- **OS**: macOS 10.14+ / Ubuntu 18.04+ / Windows 10+
- **Python**: 3.9+
- **Node.js**: 18+ (for frontend)
- **npm**: 9+ (usually comes with Node.js)

---

## 🚀 Quick Start

### 1. Clone Repository

```bash
git clone https://github.com/goddly4123/nongshim_USA_runtime.git
cd nongshim_USA_runtime
```

### 2. Install Python Packages (using uv)

**What is uv?**
`uv` is a fast Python package manager that replaces `pip`. It's already configured in this project.

#### Option A: Using uv (Recommended)
```bash
# Install uv first (if not already installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install Python dependencies
uv sync
```

#### Option B: Using pip
```bash
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

**What gets installed:**
- `fastapi` - Backend web framework
- `uvicorn` - ASGI server
- `ultralytics` - YOLOv12 object detection
- `opencv-python` - Image processing
- `pypylon` - Basler camera control
- `paddleocr` - Text recognition (OCR)
- And other dependencies in `pyproject.toml`

### 3. Install Frontend Dependencies

```bash
cd frontend
npm install
cd ..
```

### 4. Download Model Weights

The YOLOv12 model file (`best.pt`) is already included in the `weights/` directory.

**If you need a different model:**
```bash
# The framework will auto-download from Ultralytics if not found:
# Place your .pt file in: weights/best.pt
ls -lh weights/best.pt
```

### 5. Configure Settings (Optional)

Edit `configs/global_settings.json` to customize:
- Storage retention days
- S3 bucket details (for cloud storage)
- Admin password
- Dashboard layout

```json
{
  "storage": {
    "local_retention_days": 180,
    "storage_type": "local",
    "s3_bucket": "",
    "s3_region": "ap-northeast-2",
    "s3_access_key": "",
    "s3_secret_key": ""
  },
  "admin": {
    "password": "your_hashed_password"
  }
}
```

---

## 🎬 Running the Application

### Option 1: Using start.sh (All-in-one)

```bash
chmod +x start.sh
./start.sh
```

This script:
1. Cleans up old processes (ports 8000, 5173)
2. Starts FastAPI backend on port 8000
3. Starts React frontend on port 5173
4. Opens browser automatically

**Output:**
```
==============================
  Ansung Vision Inspection
==============================

[0/2] Cleaning up existing processes...
[1/2] Starting FastAPI backend (port 8000)...
[2/2] Starting React frontend (port 5173)...

-------------------------------
  Local:    http://localhost:5173
  External: http://{YOUR_IP}:5173
  Backend:  http://localhost:8000
  API Docs: http://localhost:8000/docs
-------------------------------
  Exit: Ctrl+C
```

### Option 2: Manual Startup

#### Terminal 1 - Backend
```bash
uv run uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

#### Terminal 2 - Frontend
```bash
cd frontend
npm run dev
```

#### Terminal 3 - Inspection Line (Optional)
```bash
cd inspection_framework
uv run python example_pinhole.py
```

---

## 🌐 Access the Dashboard

Once running, open your browser:

| Component | URL |
|-----------|-----|
| **Dashboard** | http://localhost:5173 |
| **API Docs** | http://localhost:8000/docs |
| **API ReDoc** | http://localhost:8000/redoc |

### Default Admin Login
- **Password**: (Set in `configs/global_settings.json`)

---

## 📁 Project Structure

```
.
├── backend/                          # FastAPI backend
│   ├── main.py                      # API endpoints
│   ├── collection.py                # Video collection logic
│   ├── storage.py                   # Data storage manager
│   └── history_db.py               # History tracking
│
├── frontend/                         # React dashboard
│   ├── src/
│   │   ├── pages/                  # Dashboard, Lines, Collection, Admin, etc.
│   │   ├── components/             # UI components (CameraCard, LineModal, etc.)
│   │   └── api.ts                  # API client
│   ├── package.json
│   └── vite.config.ts
│
├── inspection_framework/            # Core AI inspection engine
│   ├── config.py                   # Configuration dataclass
│   ├── camera.py                   # Basler GigE camera interface
│   ├── detector.py                 # Plugin detector system
│   │   ├── detector_yolo.py       # YOLO object detection
│   │   ├── detector_paddleocr.py  # Text recognition (OCR)
│   │   └── detector_cnn.py        # Image classification
│   ├── rejecter.py                 # Reject signal control
│   ├── datamanager.py              # Data storage & archiving
│   ├── inspection_worker.py        # Background worker thread
│   ├── inspection_runtime.py       # Standalone mode (OpenCV display)
│   └── example_pinhole.py          # Template for new inspection lines
│
├── configs/                         # Configuration files
│   ├── global_settings.json        # Global settings (storage, admin, layout)
│   ├── default_config.json         # Default inspection line config
│   ├── paddleocr_date_check.json   # OCR-specific config
│   └── lines.json                  # Runtime inspection lines (auto-generated)
│
├── weights/                         # Model files
│   └── best.pt                     # YOLOv12 model
│
├── data/                           # Collected defect data (auto-generated)
│   └── {line_name}/
│       ├── defect/
│       ├── preview/
│       └── archive/
│
├── pyproject.toml                  # Python dependencies
├── uv.lock                         # Locked dependency versions
└── start.sh                        # Quick start script
```

---

## 🔧 Configuration Guide

### Adding a New Inspection Line

1. **Copy template:**
   ```bash
   cp inspection_framework/example_pinhole.py inspection_framework/example_neoguri.py
   ```

2. **Edit configuration:**
   ```python
   config = InspectionConfig(
       name="Line_Neoguri",
       camera_type="basler",  # or "webcam"
       camera_ip="192.168.0.100",
       detector_type="yolo",
       model_path="weights/best.pt",
       class_thresholds={
           "defect": 0.70,
           "pinhole": 0.85,
       },
       reject_delay_frames=30,
       save_root="data/Line_Neoguri"
   )
   ```

3. **Run:**
   ```bash
   uv run python inspection_framework/example_neoguri.py
   ```

4. **Settings auto-save to:** `configs/lines.json`

### Detector Types

| Type | Model | Use Case | Config Keys |
|------|-------|----------|------------|
| `yolo` | YOLO object detection | Bounding box defects | None |
| `paddleocr` | PaddleOCR | Text recognition | `lang`, `expected_text`, `use_gpu` |
| `cnn` | Custom CNN classifier | Full-image classification | `input_size`, `class_names` |

---

## 🐛 Troubleshooting

### Port Already in Use

```bash
# Kill process on port 8000
lsof -ti :8000 | xargs kill -9

# Kill process on port 5173
lsof -ti :5173 | xargs kill -9
```

### Camera Not Found

```bash
# List available cameras
python -c "import cv2; print([i for i in range(5) if cv2.VideoCapture(i).isOpened()])"
```

### CUDA Not Available (but GPU present)

```bash
# Install GPU support
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
uv sync
```

### ModuleNotFoundError

```bash
# Reinstall all dependencies
uv sync --force-all-sync
```

### Frontend Build Issues

```bash
# Clean and reinstall
cd frontend
rm -rf node_modules package-lock.json
npm install
npm run dev
```

---

## 📊 API Endpoints

### Lines Management
```
GET    /api/lines                    # Get all inspection lines
POST   /api/lines                    # Create new line
PUT    /api/lines/{name}             # Update line
DELETE /api/lines/{name}             # Delete line
```

### Live Video Feed
```
WS     /ws/{line_name}               # WebSocket video stream
```

### Data & History
```
GET    /api/data/defects/{line}     # Get defect history
GET    /api/data/preview/{line}     # Get recent preview images
DELETE /api/data/{line}/{defect_id} # Delete defect record
```

### Admin
```
POST   /api/admin/auth              # Login
GET    /api/admin/settings          # Get settings
PUT    /api/admin/settings          # Update settings
```

Full API documentation: http://localhost:8000/docs

---

## 🚦 Performance Tips

1. **GPU Acceleration**: Use NVIDIA GPU for real-time inference
   ```bash
   pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
   ```

2. **Multi-Camera**: Use `inspection_worker.py` with background threads

3. **Data Cleanup**: Set `local_retention_days` in `global_settings.json` for auto-archiving

4. **Network Streaming**: Use Basler GigE cameras for stable real-time feed

---

## 📝 Environment Variables (Optional)

Create `.env` file in root directory:
```bash
# S3 Configuration
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_S3_BUCKET=your_bucket

# Backend
BACKEND_HOST=0.0.0.0
BACKEND_PORT=8000

# Frontend
VITE_API_URL=http://localhost:8000
```

---

## 🔐 Security Notes

- **Never commit** `configs/global_settings.json` with real AWS credentials
- Use environment variables for sensitive data
- Change default admin password in `global_settings.json`
- Use HTTPS in production
- Restrict camera IP access via firewall

---

## 📚 Additional Resources

- **Inspection Framework Guide**: See [inspection_framework/README.md](inspection_framework/README.md)
- **API Documentation**: http://localhost:8000/docs (when running)
- **CLAUDE.md**: Development guidelines for this project

---

## 🤝 Support

For issues or questions, check:
1. **Troubleshooting** section above
2. **API Docs**: http://localhost:8000/docs
3. **Project structure** in this README

---

## 📄 License

[Your License Here]

---

**Last Updated:** 2026-02-28
