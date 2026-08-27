# PyInstaller spec for backend/main.py — the local agent backend
# (PyAutoGUI + Groq, driving /task automation only). Build with:
#   pyinstaller backend/boltmos_backend.spec --clean --noconfirm --distpath backend/dist --workpath backend/build
#
# --distpath/--workpath are required, not cosmetic: PyInstaller resolves
# dist/build relative to the invoking shell's CWD, not this spec file's
# location, so running the bare command from repo root scatters output at
# <repo>/dist instead of backend/dist - which is where electron/main.js's
# getBackendExePath() and package.json's extraResources both expect it.
#
# Kokoro TTS (and its torch/transformers/spacy dependency chain) used to live
# here too, but voice generation moved to backend/cloud/main.py - bundling
# that stack locally pushed the install past ~1GB and could freeze low-spec
# user machines (8GB RAM, no GPU) just importing torch. This backend now only
# needs to drive /task, so it stays onedir mostly for consistency with how
# it's always been built, not because size still forces the choice.

from PyInstaller.utils.hooks import collect_all, copy_metadata

datas = []
binaries = []
hiddenimports = []

# Packages that dynamically import their own submodules (uvicorn's
# loop/protocol "auto" selection) or ship non-.py data/binaries alongside
# their code. collect_all() = collect_submodules + collect_data +
# collect_dynamic_libs, which is the standard fix for all three failure
# modes at once.
COLLECT_ALL_PACKAGES = [
    "uvicorn",
    "websockets",
    "groq",
    "supabase",
    "httpx",
    "httpcore",
]

for pkg in COLLECT_ALL_PACKAGES:
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# Packages whose code checks importlib.metadata at runtime for
# optional-dependency probes. Without their .dist-info copied into the
# bundle, these checks see "not installed" even though the code is right
# there, and misbehave in ways that don't look like import errors.
COPY_METADATA_PACKAGES = [
    "pyautogui",
]

for pkg in COPY_METADATA_PACKAGES:
    try:
        datas += copy_metadata(pkg)
    except Exception:
        pass

# PyAutoGUI's own dependency tree isn't always fully picked up by static
# analysis because pyautogui imports some of these conditionally per-platform.
hiddenimports += [
    "pymsgbox",
    "pytweening",
    "pyscreeze",
    "pygetwindow",
    "mouseinfo",
    "pyperclip",
]

block_cipher = None

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="boltmos-backend",
    debug=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="boltmos-backend",
)
