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

## System Requirements

### Hardware
- **CPU**: Intel i5/i7 or equivalent (4+ cores)
- **RAM**: 8GB minimum (16GB recommended)
- **GPU**: NVIDIA CUDA-compatible GPU (optional but recommended for real-time inference)
- **Storage**: 50GB+ free space (for model weights and defect data)
- **Camera**: Basler GigE camera (optional) or USB webcam

### Software
- **OS**: Ubuntu 22.04 LTS or later (recommended)
- **Python**: 3.11+
- **Node.js**: 18+ (for frontend)

---

## Installation (Ubuntu Fresh Install)

This guide assumes a fresh Ubuntu 22.04+ installation.

### Step 1: System Packages (apt)

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Essential build tools
sudo apt install -y build-essential git curl wget

# Python build dependencies (required by some pip packages)
sudo apt install -y python3-dev python3-pip python3-venv

# OpenCV system dependencies
sudo apt install -y libgl1-mesa-glx libglib2.0-0 libsm6 libxext6 libxrender-dev

# Network tools (for GigE camera)
sudo apt install -y net-tools
```

### Step 2: NVIDIA GPU Driver & CUDA (Optional - skip if CPU only)

```bash
# Check if NVIDIA GPU is detected
lspci | grep -i nvidia

# Install NVIDIA driver (if GPU found)
sudo apt install -y nvidia-driver-535

# Reboot after driver install
sudo reboot

# Verify driver
nvidia-smi
```

For CUDA toolkit (needed for GPU-accelerated inference):
```bash
# Install CUDA toolkit 11.8 (compatible with PyTorch)
# Visit: https://developer.nvidia.com/cuda-11-8-0-download-archive
# Or install via apt:
sudo apt install -y nvidia-cuda-toolkit
```

### Step 3: Install uv (Python Package Manager)

`uv` is a fast Python package manager that replaces `pip`. It handles virtual environments and dependency resolution automatically.

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh

# Add to PATH (restart terminal or run:)
source $HOME/.local/bin/env

# Verify
uv --version
```

### Step 4: Install Node.js via nvm

`nvm` (Node Version Manager) allows installing and managing multiple Node.js versions.

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# Load nvm (restart terminal or run:)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Install Node.js 20 LTS
nvm install 20
nvm use 20
nvm alias default 20

# Verify
node --version   # v20.x.x
npm --version    # 10.x.x
```

### Step 5: Clone Repository

```bash
cd ~
git clone https://github.com/goddly4123/nongshim_USA_runtime.git
cd nongshim_USA_runtime
```

### Step 6: Install Python Dependencies

```bash
# From the project root directory
cd ~/nongshim_USA_runtime

# Install all Python dependencies (creates .venv automatically)
uv sync

# Verify virtual environment
ls .venv/bin/python
```

**What gets installed:**
| Package | Purpose |
|---------|---------|
| `fastapi` + `uvicorn` | Backend web server |
| `ultralytics` | YOLOv12 object detection |
| `opencv-python` | Image processing |
| `pypylon` | Basler GigE camera driver |
| `paddleocr` + `paddlepaddle` | OCR text recognition |
| `boto3` | AWS S3 integration (optional) |

**GPU support for PyTorch** (if NVIDIA GPU installed):
```bash
# Install CUDA-enabled PyTorch (replace cu118 with your CUDA version)
uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
```

### Step 7: Install Frontend Dependencies

```bash
cd ~/nongshim_USA_runtime/frontend

# Install npm packages
npm install

# Go back to project root
cd ..
```

### Step 8: Verify Installation

```bash
cd ~/nongshim_USA_runtime

# Check Python packages
uv run python -c "import ultralytics; print('ultralytics:', ultralytics.__version__)"
uv run python -c "import cv2; print('opencv:', cv2.__version__)"
uv run python -c "import fastapi; print('fastapi:', fastapi.__version__)"

# Check Node.js packages
cd frontend && npm ls --depth=0 && cd ..
```

---

## Running the Application

### Option 1: Quick Start (start.sh)

```bash
cd ~/nongshim_USA_runtime
chmod +x start.sh
./start.sh
```

This script:
1. Cleans up old processes on ports 8000, 5173
2. Starts FastAPI backend on port 8000
3. Starts React frontend on port 5173
4. Opens browser automatically

### Option 2: Manual Startup

**Terminal 1 - Backend:**
```bash
cd ~/nongshim_USA_runtime
uv run uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

**Terminal 2 - Frontend:**
```bash
cd ~/nongshim_USA_runtime/frontend
npm run dev
```

### Accessing the Dashboard

| Component | URL |
|-----------|-----|
| **Dashboard** | http://localhost:5173 |
| **API Docs** | http://localhost:8000/docs |
| **API ReDoc** | http://localhost:8000/redoc |

### Default Admin Password
- **Password**: `1`
- Change this immediately in `configs/global_settings.json` or via the admin page.

---

## Project Structure

```
nongshim_USA_runtime/
|-- backend/                          # FastAPI backend
|   |-- main.py                      # API endpoints
|   |-- collection.py                # Video collection logic
|   |-- storage.py                   # Data storage manager
|   `-- history_db.py               # History tracking
|
|-- frontend/                         # React dashboard
|   |-- src/
|   |   |-- pages/                  # Dashboard, Lines, Collection, Admin
|   |   |-- components/             # UI components (CameraCard, LineModal)
|   |   `-- api.ts                  # API client
|   |-- package.json
|   `-- vite.config.ts
|
|-- inspection_framework/            # Core AI inspection engine
|   |-- config.py                   # Configuration dataclass
|   |-- camera.py                   # Basler GigE camera interface
|   |-- detector.py                 # Plugin detector system
|   |-- detector_yolo.py            # YOLO object detection
|   |-- detector_paddleocr.py       # Text recognition (OCR)
|   |-- detector_cnn.py             # Image classification
|   |-- rejecter.py                 # Reject signal control
|   |-- datamanager.py              # Data storage & archiving
|   |-- inspection_worker.py        # Background worker thread
|   `-- inspection_runtime.py       # Standalone mode (OpenCV display)
|
|-- configs/                         # Configuration files
|   `-- global_settings.json        # Global settings (storage, admin, layout)
|
|-- workers/                         # Worker directories (auto-created per line)
|   |-- worker-01/
|   |   |-- config.json             # Line-specific config
|   |   |-- camera.pfs              # Basler camera settings
|   |   |-- weights/                # Model files (.pt)
|   |   `-- data/                   # Defect images & archives
|   `-- worker-02/
|       `-- ...
|
|-- pyproject.toml                   # Python dependencies
|-- uv.lock                         # Locked dependency versions
`-- start.sh                        # Quick start script
```

---

## Worker Directory Convention

Each inspection line operates from its own `workers/worker-XX/` directory:
- **config.json** : Line configuration (camera, model, thresholds, reject settings)
- **camera.pfs** : Basler camera settings file (exported from Pylon Viewer)
- **weights/** : Model weight files (.pt for YOLO, .pth for CNN)
- **data/** : Defect images, preview images, and archives

File paths in `config.json` (e.g., `model_path`, `pfs_file`, `save_root`) are **relative to the worker directory**.

---

## Troubleshooting

### Port Already in Use
```bash
lsof -ti :8000 | xargs kill -9
lsof -ti :5173 | xargs kill -9
```

### Camera Not Found (Basler GigE)
```bash
# Ensure camera is on the same subnet
ip addr show | grep inet

# Basler cameras typically use 192.168.1.x
# Set your NIC to same subnet: sudo ip addr add 192.168.1.1/24 dev eth0
```

### CUDA Not Available
```bash
# Check NVIDIA driver
nvidia-smi

# Verify PyTorch CUDA support
uv run python -c "import torch; print('CUDA:', torch.cuda.is_available())"

# If False, install CUDA-enabled PyTorch:
uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
```

### ModuleNotFoundError
```bash
uv sync
```

### Frontend Build Issues
```bash
cd frontend
rm -rf node_modules package-lock.json
npm install
npm run dev
```

---

**Last Updated:** 2026-03-05
