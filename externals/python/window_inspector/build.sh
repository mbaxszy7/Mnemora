#!/bin/bash

# Build script for window_inspector Python executable
# Requires: Python 3, pyinstaller, pyobjc-framework-Quartz

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DIST_EXE="$SCRIPT_DIR/dist/window_inspector/window_inspector"

if [ -x "$DIST_EXE" ] && [ -z "$FORCE_REBUILD" ]; then
    echo "Existing executable found, skipping rebuild: $DIST_EXE"
    echo "Delete dist/ or set FORCE_REBUILD=1 to rebuild."
    exit 0
fi

echo "=== Building window_inspector ==="

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "Error: python3 is required"
    exit 1
fi

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate venv
source venv/bin/activate

# Install dependencies
echo "Installing dependencies..."
pip install --upgrade pip
pip install pyinstaller pyobjc-framework-Quartz

# Build with PyInstaller
echo "Building executable..."
pyinstaller --clean -y window_inspector.spec

echo "=== Build complete ==="
echo "Executable: $SCRIPT_DIR/dist/window_inspector/window_inspector"

# Deactivate venv
deactivate
