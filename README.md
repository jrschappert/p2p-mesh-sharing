# Babylon + FAL Trellis — Quick Setup Guide

This project uses Babylon.js and FAL (Flux + Trellis) to generate and place AI-made 3D models in a scene. Follow these steps to get it running locally.

---

## Requirements

* **Node.js** 20 or 22 (LTS recommended)
* **Git**
* **FAL API key** with access to `fal-ai/flux-pro/v1.1` and `fal-ai/trellis`

If you don’t have Node or npm yet, install them below.

### macOS (zsh)

1. Install [nvm](https://github.com/nvm-sh/nvm):

   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
   ```
2. Reload your terminal, then install Node:

   ```bash
   nvm install --lts
   nvm use --lts
   node -v
   npm -v
   ```

### Windows (PowerShell)

1. Install [nvm-windows](https://github.com/coreybutler/nvm-windows/releases) using the setup `.exe`.
2. Open PowerShell and run:

   ```powershell
   nvm install lts
   nvm use lts
   node -v
   npm -v
   ```
3. If needed, update npm:

   ```powershell
   npm install -g npm
   ```

---

## 1. Clone and Install

```bash
git clone <YOUR_REPO_URL>
cd <YOUR_REPO_DIR>
npm install
```

Dependencies are automatically installed from `package.json`:

* @babylonjs/core **7.54.3**
* @babylonjs/loaders **7.54.3**
* @fal-ai/client **1.7.0**
* vite **5.4.21**
* typescript **5.9.3**

---

## 2. Add Your FAL API Key

Create a file named `.env` in the project root:

```
VITE_FAL_KEY=YOUR_FAL_KEY_HERE
```

(Do **not** commit this file.)

Optional one-liners:

```bash
# macOS (zsh)
echo "VITE_FAL_KEY=YOUR_FAL_KEY_HERE" > .env
```

```powershell
# Windows (PowerShell)
"VITE_FAL_KEY=YOUR_FAL_KEY_HERE" | Out-File -FilePath .env -Encoding utf8 -NoNewline
```

If you only want to set it for one session:

* macOS: `export VITE_FAL_KEY=... && npm run dev`
* PowerShell: `$env:VITE_FAL_KEY='...' ; npm run dev`

---

## 3. Run the App

```bash
npm run dev
```

Then open the printed URL (usually `http://localhost:5173`) in your browser.

Click the ground to open the modal → type a prompt → generate a model, or use **Test Model** if `public/models/test_model.glb` exists.

### Run the server
1. `cd server`
2. `npm start`

---

## 4. Common Issues

* **Blank screen** → Check your `<canvas id="renderCanvas">` and restart Vite.
* **401 FAL error** → Verify `.env` and restart the dev server.
* **Version mismatch** → Ensure Node LTS is active (`nvm use --lts`).
* **PowerShell env lost after restart** → Use `.env` instead of setting `$env:` manually.

---

## 5. File Overview

* **`src/main.ts`** — contains all Babylon.js client logic (scene setup, lighting, camera, model placement, and FAL integration).
* **`index.html`** — defines the render canvas and the on-screen instruction text overlay.

---

That’s it — just `npm install`, set up `.env`, and `npm run dev`. 🚀
