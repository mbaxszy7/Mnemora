# -*- mode: python ; coding: utf-8 -*-

"""
PyInstaller spec file for window_inspector
Compiles the Python script to a standalone executable for macOS
"""

block_cipher = None

a = Analysis(
    ['window_inspector.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        # PyObjC bridge modules required for Quartz
        'Quartz',
        'Quartz.CoreGraphics',
        'AppKit',
        'Foundation',
        'CoreFoundation',
        'CoreServices',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='window_inspector',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='window_inspector'
)
