/**
 * Webhaus Editor v1.4.1
 * 
 * On-canvas inline editor for vibe-coded sites.
 * Edit text and images directly on any localhost page.
 * Writes changes to source files via the File System Access API.
 * 
 * Editing feels like Google Docs: single click positions cursor,
 * double-click selects word, drag selects range — all native browser behavior.
 *
 * v1.4.1 — Diagnostics + escape hatch:
 *   - Verbose indexing logs (every directory entered, every error caught)
 *   - window.webhausEditor debug API (diagnostics, files, find, fiber, write, reindex)
 *   - Manual search modal in the failure toast
 *   - Low-file-count warning when index looks suspiciously small
 * 
 * Requirements: Chrome/Edge (File System Access API)
 */
;(function () {
  'use strict'

  const WEBHAUS_EDITOR_VERSION = '1.4.1'

  // Bail if already loaded
  if (window.__webhausEditor) {
    console.log(`[Webhaus Editor] Already loaded (v${window.__webhausEditor})`)
    return
  }
  window.__webhausEditor = WEBHAUS_EDITOR_VERSION

  // ---------------------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------------------

  const IGNORED_DIRS = [
    'node_modules', '.git', '.next', '.vercel', '.astro', '.svelte-kit',
    'dist', 'build', 'out', '.cache', '.turbo', '__pycache__', '.DS_Store'
  ]

  const SOURCE_EXTENSIONS = [
    // Templates and components
    '.html', '.htm', '.jsx', '.tsx', '.js', '.ts', '.cjs', '.mjs',
    '.astro', '.vue', '.svelte', '.njk', '.ejs', '.hbs',
    // Content & markdown
    '.md', '.mdx',
    // Data files (common for vibe-coded sites with content separated from components)
    '.json', '.jsonc', '.yaml', '.yml', '.toml', '.txt', '.csv', '.xml'
  ]

  const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif', '.ico']

  const SKIP_ELEMENTS = ['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'SVG', 'PATH', 'CIRCLE', 'RECT', 'LINE', 'POLYGON', 'IFRAME']

  // ---------------------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------------------

  let dirHandle = null
  let fileIndex = new Map()   // relativePath -> { handle, content }
  let editMode = false
  let activeElement = null     // currently-focused editable element (or null)
  let editCount = 0
  let editLog = []             // { timestamp, path, oldText, newText, oldFileContent, handle }

  // ---------------------------------------------------------------------------
  // PERSISTENT FOLDER HANDLE (IndexedDB)
  // ---------------------------------------------------------------------------
  // The File System Access API allows folder handles to be stored in IndexedDB.
  // On reload we try to restore the previously granted folder for this origin —
  // no more re-picking your project folder on every page refresh.

  const IDB_NAME = 'webhaus-editor'
  const IDB_STORE = 'handles'
  const IDB_KEY = `folder:${location.origin}`

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async function idbSaveHandle(handle) {
    try {
      const db = await idbOpen()
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY)
      return new Promise(res => { tx.oncomplete = () => res(); tx.onerror = () => res() })
    } catch (_) { /* ignore */ }
  }

  async function idbLoadHandle() {
    try {
      const db = await idbOpen()
      const tx = db.transaction(IDB_STORE, 'readonly')
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY)
      return new Promise(res => {
        req.onsuccess = () => res(req.result || null)
        req.onerror = () => res(null)
      })
    } catch (_) { return null }
  }

  async function idbClearHandle() {
    try {
      const db = await idbOpen()
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).delete(IDB_KEY)
    } catch (_) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // STYLES
  // ---------------------------------------------------------------------------

  function injectStyles() {
    const style = document.createElement('style')
    style.id = 'webhaus-editor-styles'
    style.textContent = `
      /* Toolbar */
      #wh-toolbar {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 6px;
        background: #1a1a1a;
        color: #e0e0e0;
        padding: 8px 12px;
        border-radius: 10px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08);
        user-select: none;
        transition: opacity 0.2s;
      }
      #wh-toolbar button {
        background: transparent;
        border: 1px solid rgba(255,255,255,0.12);
        color: #e0e0e0;
        padding: 5px 10px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-family: inherit;
        transition: all 0.15s;
        white-space: nowrap;
      }
      #wh-toolbar button:hover {
        background: rgba(255,255,255,0.08);
        border-color: rgba(255,255,255,0.2);
      }
      #wh-toolbar button.wh-active {
        background: #2563eb;
        border-color: #2563eb;
        color: #fff;
      }
      #wh-toolbar .wh-status {
        font-size: 11px;
        color: #888;
        padding: 0 4px;
      }
      #wh-toolbar .wh-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #555;
        flex-shrink: 0;
      }
      #wh-toolbar .wh-dot.wh-connected { background: #22c55e; }
      #wh-toolbar .wh-dot.wh-editing   { background: #eab308; }
      #wh-toolbar .wh-badge {
        background: #2563eb;
        color: #fff;
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 9px;
        font-weight: 600;
      }
      #wh-toolbar .wh-logo {
        font-weight: 700;
        font-size: 12px;
        letter-spacing: -0.02em;
        color: #fff;
        padding-right: 4px;
        border-right: 1px solid rgba(255,255,255,0.1);
        margin-right: 2px;
      }

      /* Hover outlines in edit mode */
      .wh-edit-mode [data-wh-editable]:hover {
        outline: 2px solid rgba(37, 99, 235, 0.5) !important;
        outline-offset: 2px;
        cursor: text !important;
      }
      .wh-edit-mode img[data-wh-editable]:hover {
        cursor: pointer !important;
      }

      /* Active editing */
      [data-wh-editing="true"] {
        outline: 2px solid #2563eb !important;
        outline-offset: 2px;
        background: rgba(37, 99, 235, 0.04) !important;
      }

      /* Element-level feedback states */
      [data-wh-state="saving"] {
        position: relative;
        outline: 2px solid #eab308 !important;
        outline-offset: 2px;
      }
      [data-wh-state="saving"]::after {
        content: '';
        position: absolute;
        top: 50%;
        right: -22px;
        width: 12px;
        height: 12px;
        margin-top: -6px;
        border: 2px solid #eab308;
        border-top-color: transparent;
        border-radius: 50%;
        animation: wh-spin 0.7s linear infinite;
        z-index: 999999;
      }
      [data-wh-state="success"] {
        animation: wh-pulse-success 0.7s ease-out;
      }
      [data-wh-state="error"] {
        animation: wh-pulse-error 0.7s ease-out;
      }
      @keyframes wh-spin {
        to { transform: rotate(360deg); }
      }
      @keyframes wh-pulse-success {
        0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5); }
        100% { box-shadow: 0 0 0 14px rgba(34, 197, 94, 0); }
      }
      @keyframes wh-pulse-error {
        0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5); }
        100% { box-shadow: 0 0 0 14px rgba(239, 68, 68, 0); }
      }

      /* Image hover overlay */
      .wh-img-overlay {
        position: absolute;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,0.5);
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        font-size: 13px;
        font-weight: 500;
        border-radius: 4px;
        pointer-events: none;
        z-index: 999998;
        opacity: 0;
        transition: opacity 0.15s;
      }
      .wh-img-overlay.wh-visible { opacity: 1; }

      /* Toast */
      #wh-toast-container {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 9999999;
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: none;
      }
      .wh-toast {
        font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        font-size: 13px;
        padding: 10px 16px;
        border-radius: 8px;
        background: #1a1a1a;
        color: #e0e0e0;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.08);
        transform: translateX(120%);
        transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s;
        max-width: 340px;
        word-break: break-word;
      }
      .wh-toast.wh-show { transform: translateX(0); }
      .wh-toast.wh-hide { opacity: 0; transform: translateX(40%); }
      .wh-toast.wh-error { border-left: 3px solid #ef4444; }
      .wh-toast.wh-success { border-left: 3px solid #22c55e; }
      .wh-toast.wh-info { border-left: 3px solid #2563eb; }

      /* File picker modal */
      #wh-file-picker {
        position: fixed;
        inset: 0;
        z-index: 99999999;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,0.6);
        font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      }
      #wh-file-picker .wh-modal {
        background: #1a1a1a;
        color: #e0e0e0;
        border-radius: 12px;
        padding: 20px;
        max-width: 480px;
        width: 90%;
        box-shadow: 0 8px 40px rgba(0,0,0,0.5);
      }
      #wh-file-picker h3 {
        margin: 0 0 4px;
        font-size: 15px;
        font-weight: 600;
        color: #fff;
      }
      #wh-file-picker .wh-subtitle {
        font-size: 12px;
        color: #888;
        margin-bottom: 14px;
      }
      #wh-file-picker .wh-option {
        padding: 8px 12px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        color: #ccc;
        transition: background 0.1s;
        font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      }
      #wh-file-picker .wh-option:hover {
        background: rgba(255,255,255,0.08);
        color: #fff;
      }

      /* Edit log panel */
      #wh-log-panel {
        position: fixed;
        bottom: 64px;
        right: 20px;
        z-index: 999998;
        width: 380px;
        max-height: 320px;
        background: #1a1a1a;
        border-radius: 10px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08);
        font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        font-size: 12px;
        color: #e0e0e0;
        overflow: hidden;
        display: none;
      }
      #wh-log-panel.wh-open { display: block; }
      #wh-log-panel .wh-log-header {
        padding: 10px 14px;
        font-size: 12px;
        font-weight: 600;
        color: #fff;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      #wh-log-panel .wh-log-list {
        overflow-y: auto;
        max-height: 268px;
        padding: 6px 0;
      }
      #wh-log-panel .wh-log-entry {
        padding: 8px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      #wh-log-panel .wh-log-file {
        font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        font-size: 11px;
        color: #888;
        margin-bottom: 3px;
      }
      #wh-log-panel .wh-log-diff {
        font-size: 12px;
        line-height: 1.4;
      }
      #wh-log-panel .wh-log-old {
        color: #f87171;
        text-decoration: line-through;
      }
      #wh-log-panel .wh-log-new {
        color: #4ade80;
      }
      #wh-log-panel .wh-log-time {
        font-size: 10px;
        color: #555;
        margin-top: 3px;
      }
      #wh-log-panel .wh-log-empty {
        padding: 20px 14px;
        color: #555;
        text-align: center;
      }
      #wh-log-panel button.wh-undo-btn {
        background: transparent;
        border: 1px solid rgba(255,255,255,0.12);
        color: #e0e0e0;
        padding: 2px 8px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 11px;
        font-family: inherit;
      }
      #wh-log-panel button.wh-undo-btn:hover {
        background: rgba(255,255,255,0.08);
      }

      /* Failure toast action buttons */
      .wh-toast-btn {
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.12);
        color: #e0e0e0;
        padding: 4px 10px;
        border-radius: 5px;
        cursor: pointer;
        font-size: 11px;
        font-family: inherit;
        transition: background 0.15s;
      }
      .wh-toast-btn:hover {
        background: rgba(255,255,255,0.16);
      }

      /* Manual search modal */
      #wh-manual-search {
        position: fixed;
        inset: 0;
        z-index: 99999999;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,0.6);
        font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      }
      #wh-manual-search .wh-search-modal {
        background: #1a1a1a;
        color: #e0e0e0;
        border-radius: 12px;
        padding: 20px;
        max-width: 600px;
        width: 90%;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 8px 40px rgba(0,0,0,0.5);
      }
      #wh-manual-search h3 {
        margin: 0 0 4px;
        font-size: 15px;
        font-weight: 600;
        color: #fff;
      }
      #wh-manual-search .wh-search-sub {
        font-size: 12px;
        color: #888;
        margin-bottom: 10px;
      }
      #wh-manual-search input {
        background: #0d0d0d;
        border: 1px solid rgba(255,255,255,0.12);
        color: #e0e0e0;
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 13px;
        font-family: inherit;
        width: 100%;
        box-sizing: border-box;
        outline: none;
      }
      #wh-manual-search input:focus {
        border-color: #2563eb;
      }
      #wh-manual-search .wh-search-info {
        font-size: 11px;
        color: #888;
        margin: 8px 0;
      }
      #wh-manual-search .wh-search-results {
        flex: 1;
        overflow-y: auto;
        max-height: 300px;
        margin-bottom: 10px;
      }
      #wh-manual-search .wh-search-result {
        padding: 8px 10px;
        border-radius: 6px;
        cursor: pointer;
        margin-bottom: 4px;
        transition: background 0.1s;
      }
      #wh-manual-search .wh-search-result:hover {
        background: rgba(255,255,255,0.04);
      }
      #wh-manual-search .wh-search-result.wh-selected {
        background: rgba(37, 99, 235, 0.2);
        border-left: 2px solid #2563eb;
      }
      #wh-manual-search .wh-search-path {
        font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        font-size: 11px;
        color: #aaa;
        margin-bottom: 2px;
      }
      #wh-manual-search .wh-search-snippet {
        font-size: 11px;
        color: #777;
        font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #wh-manual-search .wh-search-replace-section {
        border-top: 1px solid rgba(255,255,255,0.08);
        padding-top: 12px;
        margin-top: 6px;
      }
    `
    document.head.appendChild(style)
  }

  // ---------------------------------------------------------------------------
  // TOAST NOTIFICATIONS
  // ---------------------------------------------------------------------------

  function ensureToastContainer() {
    if (!document.getElementById('wh-toast-container')) {
      const c = document.createElement('div')
      c.id = 'wh-toast-container'
      document.body.appendChild(c)
    }
    return document.getElementById('wh-toast-container')
  }

  function toast(message, type = 'info') {
    const container = ensureToastContainer()
    const el = document.createElement('div')
    el.className = `wh-toast wh-${type}`
    el.textContent = message
    container.appendChild(el)

    requestAnimationFrame(() => {
      requestAnimationFrame(() => el.classList.add('wh-show'))
    })

    setTimeout(() => {
      el.classList.remove('wh-show')
      el.classList.add('wh-hide')
      setTimeout(() => el.remove(), 300)
    }, 3000)
  }

  // ---------------------------------------------------------------------------
  // FILE SYSTEM ACCESS
  // ---------------------------------------------------------------------------

  async function pickProjectFolder() {
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
      await idbSaveHandle(dirHandle)
      fileIndex.clear()
      toast('Indexing project files…', 'info')
      await indexDirectory(dirHandle, '')
      toast(`Ready — ${fileIndex.size} source files indexed`, 'success')
      updateToolbar()
      return true
    } catch (err) {
      if (err.name === 'AbortError') return false
      toast(`Error: ${err.message}`, 'error')
      return false
    }
  }

  /**
   * Try to restore a previously granted folder handle from IndexedDB.
   * If permission is still granted (Chrome remembers per-origin), restore silently.
   * If permission needs to be re-requested, show a one-click reconnect button.
   */
  async function tryRestoreFolder() {
    const saved = await idbLoadHandle()
    if (!saved) return false

    try {
      const perm = await saved.queryPermission({ mode: 'readwrite' })

      if (perm === 'granted') {
        dirHandle = saved
        await indexDirectory(dirHandle, '')
        updateToolbar()
        toast(`Restored "${dirHandle.name}" — ${fileIndex.size} files`, 'success')
        return true
      }

      if (perm === 'prompt') {
        // Need a user gesture to re-grant — show reconnect button
        showReconnectButton(saved)
        return false
      }

      // Denied
      await idbClearHandle()
      return false
    } catch (err) {
      // Handle is no longer valid (folder moved/deleted)
      await idbClearHandle()
      return false
    }
  }

  async function reconnectFolder(saved) {
    try {
      const perm = await saved.requestPermission({ mode: 'readwrite' })
      if (perm === 'granted') {
        dirHandle = saved
        fileIndex.clear()
        await indexDirectory(dirHandle, '')
        updateToolbar()
        toast(`Reconnected "${dirHandle.name}"`, 'success')
        const btn = document.getElementById('wh-btn-reconnect')
        if (btn) btn.remove()
      } else {
        toast('Permission denied', 'error')
      }
    } catch (err) {
      toast(`Reconnect failed: ${err.message}`, 'error')
    }
  }

  function showReconnectButton(saved) {
    const folderBtn = document.getElementById('wh-btn-folder')
    if (!folderBtn) return
    folderBtn.textContent = `Reconnect "${saved.name}"`
    folderBtn.classList.add('wh-active')
    folderBtn.onclick = async () => {
      folderBtn.classList.remove('wh-active')
      folderBtn.onclick = null
      await reconnectFolder(saved)
      // Re-bind original handler
      folderBtn.addEventListener('click', async () => await pickProjectFolder())
    }
  }

  // Indexing diagnostics — populated each time we rebuild the index
  let indexStats = null

  async function indexDirectory(handle, basePath) {
    // Top-level call (no basePath) → initialize stats
    const isTopLevel = !basePath
    if (isTopLevel) {
      indexStats = {
        dirsEntered: [],
        dirsSkipped: [],
        filesAdded: 0,
        filesSkippedByExt: 0,
        readErrors: [],
        extensionBreakdown: {},
        startedAt: performance.now()
      }
    }

    try {
      for await (const [name, entry] of handle.entries()) {
        // Skip dot-prefixed names (hidden files/folders like .git, .env, .DS_Store)
        if (name.startsWith('.')) continue

        const fullPath = basePath ? `${basePath}/${name}` : name

        if (entry.kind === 'directory') {
          if (IGNORED_DIRS.includes(name)) {
            indexStats.dirsSkipped.push(`${fullPath} (ignored by name)`)
            continue
          }
          indexStats.dirsEntered.push(fullPath)
          try {
            await indexDirectory(entry, fullPath)
          } catch (err) {
            indexStats.readErrors.push({ path: fullPath, kind: 'directory', error: err.message })
          }
        } else if (entry.kind === 'file') {
          const ext = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : ''
          if (!SOURCE_EXTENSIONS.includes(ext)) {
            indexStats.filesSkippedByExt++
            continue
          }
          try {
            const file = await entry.getFile()
            const content = await file.text()
            fileIndex.set(fullPath, { handle: entry, content })
            indexStats.filesAdded++
            indexStats.extensionBreakdown[ext] = (indexStats.extensionBreakdown[ext] || 0) + 1
          } catch (err) {
            indexStats.readErrors.push({ path: fullPath, kind: 'file', error: err.message })
          }
        }
      }
    } catch (err) {
      indexStats.readErrors.push({ path: basePath || '(root)', kind: 'iteration', error: err.message })
    }

    if (isTopLevel) {
      indexStats.durationMs = Math.round(performance.now() - indexStats.startedAt)
      console.groupCollapsed(
        `%c[Webhaus Editor] Index complete — ${indexStats.filesAdded} files in ${indexStats.durationMs}ms`,
        'color:#2563eb;font-weight:bold'
      )
      console.log('Files added by extension:', indexStats.extensionBreakdown)
      console.log('Directories entered:', indexStats.dirsEntered.length, indexStats.dirsEntered)
      if (indexStats.dirsSkipped.length) {
        console.log('Directories skipped:', indexStats.dirsSkipped)
      }
      console.log('Files skipped (extension not indexed):', indexStats.filesSkippedByExt)
      if (indexStats.readErrors.length) {
        console.warn('Read errors:', indexStats.readErrors)
      }
      console.groupEnd()

      // Warn if the file count looks suspiciously low
      if (indexStats.filesAdded < 30 && indexStats.dirsEntered.length < 5) {
        setTimeout(() => toast(
          `Only ${indexStats.filesAdded} files indexed. You may have picked a subfolder — check the console for details.`,
          'error'
        ), 100)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // REACT FIBER SOURCE DETECTION
  // ---------------------------------------------------------------------------
  // In dev mode, every DOM element rendered by React has internal fiber data
  // including `_debugSource` (file + line where the JSX is) and `_debugOwner`
  // (parent component that rendered it). We walk the fiber tree from the
  // clicked element to collect all component source files in the rendering
  // chain — text in props/variables almost always lives in one of these files.

  /** Find the React internal fiber attached to a DOM element. */
  function findReactFiber(el) {
    if (!el) return null
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        return el[key]
      }
    }
    return null
  }

  /**
   * Walk the React fiber tree to collect all source file paths in the
   * rendering chain (this element, its parents, and the components that
   * rendered them). Returns an array of absolute file paths, ordered most-
   * specific-first.
   */
  function getReactSourceFiles(el) {
    const paths = []
    const seen = new Set()
    let fiber = findReactFiber(el)
    if (!fiber) return paths

    let cursor = fiber
    while (cursor) {
      // The fiber's own source location
      if (cursor._debugSource && cursor._debugSource.fileName) {
        const fn = cursor._debugSource.fileName
        if (!seen.has(fn)) { paths.push(fn); seen.add(fn) }
      }
      // The component that rendered this element
      if (cursor._debugOwner && cursor._debugOwner._debugSource) {
        const fn = cursor._debugOwner._debugSource.fileName
        if (fn && !seen.has(fn)) { paths.push(fn); seen.add(fn) }
      }
      cursor = cursor.return
    }
    return paths
  }

  /**
   * Match an absolute file path (from React fiber) to one of our indexed paths.
   * Tries longest-suffix match.
   */
  function matchAbsToIndexed(absolutePath) {
    if (!absolutePath) return null
    // Normalize separators
    const abs = absolutePath.replace(/\\/g, '/')

    let best = null
    for (const [path, entry] of fileIndex) {
      const idx = path.replace(/\\/g, '/')
      if (abs.endsWith('/' + idx) || abs.endsWith(idx) || abs === idx) {
        if (!best || idx.length > best.path.length) {
          best = { path, ...entry }
        }
      }
    }
    return best
  }

  /**
   * Get a prioritized list of indexed files that React thinks rendered the
   * element. Returns objects with { path, handle, content } — same shape as
   * searchFiles results.
   */
  function getReactHintFiles(el) {
    const absPaths = getReactSourceFiles(el)
    const hints = []
    const seen = new Set()
    for (const abs of absPaths) {
      const match = matchAbsToIndexed(abs)
      if (match && !seen.has(match.path)) {
        hints.push(match)
        seen.add(match.path)
      }
    }
    return hints
  }

  /**
   * Extract import paths from a source file. Captures both
   * `import x from "..."` and `import "..."` syntax.
   * Returns an array of raw import path strings.
   */
  function extractImports(content) {
    const imports = []
    if (!content) return imports
    // ES module imports
    const importRegex = /import\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/g
    let m
    while ((m = importRegex.exec(content)) !== null) {
      imports.push(m[1])
    }
    // CommonJS requires
    const requireRegex = /require\s*\(\s*["']([^"']+)["']\s*\)/g
    while ((m = requireRegex.exec(content)) !== null) {
      imports.push(m[1])
    }
    return imports
  }

  /**
   * Find an indexed file matching a raw import path.
   * Handles common Next.js/Vite path aliases (@/, ~/, src/) and relative paths.
   * Returns { path, handle, content } or null.
   */
  function resolveImportToIndexed(importPath, fromPath) {
    // Skip external npm packages (anything not starting with . / @/ ~ / src/)
    if (!importPath.startsWith('.') &&
        !importPath.startsWith('@/') &&
        !importPath.startsWith('~/') &&
        !importPath.startsWith('/') &&
        !importPath.startsWith('src/')) {
      return null
    }

    // Strip common path alias prefixes — we'll match by suffix instead
    let stripped = importPath
      .replace(/^@\//, '')
      .replace(/^~\//, '')
      .replace(/^\.\//, '')
      .replace(/^\//, '')

    // Strip any explicit extension so we can match the indexed file's ext
    stripped = stripped.replace(/\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yaml|yml|toml|astro|vue|svelte)$/, '')

    // Match candidates by path suffix. Prefer longest, most specific match.
    let best = null
    for (const [path, entry] of fileIndex) {
      const cleanIndexed = path.replace(/\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yaml|yml|toml|astro|vue|svelte)$/, '')

      // Direct file match: e.g. "lib/content/brake-repairs" matches "src/lib/content/brake-repairs.ts"
      if (cleanIndexed === stripped || cleanIndexed.endsWith('/' + stripped)) {
        if (!best || path.length > best.path.length) best = { path, ...entry }
      }
      // Index file match: e.g. "lib/content" matches "src/lib/content/index.ts"
      else if (cleanIndexed.endsWith('/' + stripped + '/index') || cleanIndexed === stripped + '/index') {
        if (!best || path.length > best.path.length) best = { path, ...entry }
      }
    }

    return best
  }

  /**
   * Expand React hint files by following their import statements.
   * This is how we find DATA FILES — e.g. when a page imports content from
   * "@/lib/content/brake-repairs", that file isn't in the React render chain
   * (React doesn't track plain data imports as owners) but it's where the
   * actual text lives. We follow imports recursively up to `depth` levels.
   */
  function expandHintsWithImports(hintFiles, depth = 2) {
    const result = [...hintFiles]
    const seen = new Set(hintFiles.map(h => h.path))

    let current = hintFiles
    for (let level = 0; level < depth; level++) {
      const next = []
      for (const hint of current) {
        const imports = extractImports(hint.content)
        for (const imp of imports) {
          const resolved = resolveImportToIndexed(imp, hint.path)
          if (resolved && !seen.has(resolved.path)) {
            seen.add(resolved.path)
            result.push(resolved)
            next.push(resolved)
          }
        }
      }
      current = next
      if (current.length === 0) break
    }
    return result
  }

  // ---------------------------------------------------------------------------
  // RUNTIME SOURCE INSTRUMENTATION
  // ---------------------------------------------------------------------------
  // When edit mode turns on, walk every tagged element and copy its React
  // fiber's _debugSource (file + line + column) onto the DOM as a
  // `data-wh-source="path/to/file.tsx:42:8"` attribute. Then at edit time
  // we go straight to that exact file/line instead of searching the whole
  // project. This is the single biggest reliability improvement available.
  //
  // For prop-passed text (where the element's own source is the COMPONENT
  // not where the literal lives), we also store the owner's source as
  // `data-wh-owner` so the search cascade has a second target to try.

  function instrumentElementSources() {
    let instrumented = 0
    document.querySelectorAll('[data-wh-editable]').forEach(el => {
      if (el.hasAttribute('data-wh-source')) return // already instrumented

      const fiber = findReactFiber(el)
      if (!fiber) return

      // The element's own JSX location
      if (fiber._debugSource && fiber._debugSource.fileName) {
        const { fileName, lineNumber, columnNumber } = fiber._debugSource
        const match = matchAbsToIndexed(fileName)
        if (match) {
          el.setAttribute('data-wh-source',
            `${match.path}:${lineNumber || 0}:${columnNumber || 0}`)
          instrumented++
        }
      }

      // The component that rendered this element (for prop-passed text)
      if (fiber._debugOwner && fiber._debugOwner._debugSource) {
        const { fileName, lineNumber, columnNumber } = fiber._debugOwner._debugSource
        const match = matchAbsToIndexed(fileName)
        if (match) {
          el.setAttribute('data-wh-owner',
            `${match.path}:${lineNumber || 0}:${columnNumber || 0}`)
        }
      }
    })
    if (instrumented > 0) {
      console.log(`[Webhaus Editor] Instrumented ${instrumented} elements with React source locations`)
    }
  }

  /**
   * Parse a "path:line:col" source attribute into its components.
   */
  function parseSourceAttr(value) {
    if (!value) return null
    const lastColon = value.lastIndexOf(':')
    const secondLast = value.lastIndexOf(':', lastColon - 1)
    if (secondLast === -1) return null
    return {
      path: value.substring(0, secondLast),
      line: parseInt(value.substring(secondLast + 1, lastColon), 10) || 0,
      col: parseInt(value.substring(lastColon + 1), 10) || 0
    }
  }

  // ---------------------------------------------------------------------------
  // SEARCH
  // ---------------------------------------------------------------------------

  /**
   * Escape special regex characters in a string.
   */
  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * Build a regex that matches the given text with flexible whitespace AND
   * smart-quote tolerance. Source code often has straight quotes ("hello")
   * while DOM might render smart quotes ("hello"), or vice versa in MDX.
   * "Welcome to Our Platform" matches "Welcome\n  to Our\n  Platform" in source.
   */
  function buildFlexiblePattern(text) {
    const trimmed = text.trim()
    if (!trimmed) return null

    // Split into words, escape each for regex safety
    const words = trimmed.split(/\s+/).filter(Boolean)
    if (words.length === 0) return null

    // Escape regex special chars, then make quote/dash characters interchangeable
    const escapedWords = words.map(w => {
      let escaped = escapeRegex(w)
      // Treat any quote variant as equivalent
      escaped = escaped.replace(/['\u2018\u2019\u201A\u201B]/g, "['\\u2018\\u2019\\u201A\\u201B]")
      escaped = escaped.replace(/["\u201C\u201D\u201E\u201F]/g, '["\\u201C\\u201D\\u201E\\u201F]')
      // Treat any dash/hyphen variant as equivalent
      escaped = escaped.replace(/[\-\u2013\u2014]/g, '[\\-\\u2013\\u2014]')
      // Treat HTML entity for & as equivalent to literal &
      escaped = escaped.replace(/&amp;/g, '(?:&|&amp;)')
      return escaped
    })

    // Allow any whitespace (spaces, tabs, newlines) between words
    return new RegExp(escapedWords.join('[\\s\\n\\r]+'), 'g')
  }

  /**
   * Search all indexed source files for text, using flexible whitespace matching.
   * Returns array of { path, handle, content, match, occurrences }
   * where `match` is the exact substring found in the source (preserving original whitespace).
   */
  function searchFiles(searchText) {
    const results = []
    const trimmed = searchText.trim()
    if (!trimmed) return results

    // Strategy 1: exact match (fastest, most precise)
    for (const [path, { handle, content }] of fileIndex) {
      if (content.includes(trimmed)) {
        results.push({ path, handle, content, match: trimmed, occurrences: 1 })
      }
    }
    if (results.length > 0) return results

    // Strategy 2: flexible whitespace match (handles JSX line breaks)
    const pattern = buildFlexiblePattern(trimmed)
    if (!pattern) return results

    for (const [path, { handle, content }] of fileIndex) {
      const matches = [...content.matchAll(pattern)]
      if (matches.length > 0) {
        // Store the actual matched text from the source (with original whitespace)
        results.push({
          path, handle, content,
          match: matches[0][0],
          occurrences: matches.length
        })
      }
    }
    if (results.length > 0) return results

    // Strategy 3: try matching just a long-enough unique substring
    // (handles cases where only part of the visible text is in one source location)
    const words = trimmed.split(/\s+/)
    if (words.length >= 4) {
      // Try the first 3/4 of words as a shorter search
      const partial = words.slice(0, Math.ceil(words.length * 0.75)).join(' ')
      const partialPattern = buildFlexiblePattern(partial)
      if (partialPattern) {
        for (const [path, { handle, content }] of fileIndex) {
          const matches = [...content.matchAll(partialPattern)]
          if (matches.length > 0) {
            results.push({
              path, handle, content,
              match: matches[0][0],
              occurrences: matches.length,
              partial: true
            })
          }
        }
      }
    }

    return results
  }

  /**
   * Search ONE specific file for text, preferring occurrences near a hint line.
   * Used when we have a data-wh-source attribute giving us the exact file and
   * line where React said this element was rendered.
   *
   * Returns { path, handle, content, match, position, line, distance } or null.
   */
  function searchInFileNearLine(filePath, searchText, lineHint, lineWindow = 30) {
    const entry = fileIndex.get(filePath)
    if (!entry) return null

    const trimmed = searchText.trim()
    if (!trimmed) return null

    const content = entry.content
    const occurrences = []

    // First try exact text matches
    let idx = content.indexOf(trimmed)
    while (idx !== -1) {
      occurrences.push({ position: idx, match: trimmed })
      idx = content.indexOf(trimmed, idx + 1)
    }

    // If no exact, try flexible-whitespace pattern (handles JSX line breaks)
    if (occurrences.length === 0) {
      const pattern = buildFlexiblePattern(trimmed)
      if (pattern) {
        let m
        while ((m = pattern.exec(content)) !== null) {
          occurrences.push({ position: m.index, match: m[0] })
        }
      }
    }

    if (occurrences.length === 0) return null

    // Compute line numbers and distance from hint
    const lineOf = (pos) => {
      let line = 1
      for (let i = 0; i < pos; i++) if (content.charCodeAt(i) === 10) line++
      return line
    }

    if (lineHint) {
      occurrences.forEach(o => {
        o.line = lineOf(o.position)
        o.distance = Math.abs(o.line - lineHint)
      })
      occurrences.sort((a, b) => a.distance - b.distance)

      // Only return if the closest is within the window
      if (occurrences[0].distance <= lineWindow) {
        return {
          path: filePath, handle: entry.handle, content,
          match: occurrences[0].match,
          position: occurrences[0].position,
          line: occurrences[0].line,
          distance: occurrences[0].distance,
          occurrences: occurrences.length
        }
      }
      return null
    }

    // No line hint — return first occurrence
    return {
      path: filePath, handle: entry.handle, content,
      match: occurrences[0].match,
      position: occurrences[0].position,
      occurrences: occurrences.length
    }
  }

  /**
   * Write updated content to a source file.
   * Re-reads the file fresh from disk first to avoid overwriting external changes
   * (e.g. if Claude Code or your editor modified the file between our index and write).
   *
   * Two modes:
   *   - Default: replaces the FIRST occurrence of searchText in the file
   *   - Position-aware (when `position` is a number): verifies the text at that
   *     exact position and replaces at that exact spot. This is critical when
   *     using data-wh-source — without it, we'd always replace the first match
   *     in the file even if the React-identified occurrence was further down.
   *
   * Returns { success, occurrences, freshContent } or { success: false, reason }
   */
  async function writeFile(fileHandle, cachedContent, searchText, replaceText, position = null) {
    // Re-read fresh content from disk
    let freshContent
    try {
      const file = await fileHandle.getFile()
      freshContent = await file.text()
    } catch (err) {
      return { success: false, reason: `Could not re-read file: ${err.message}` }
    }

    // Count occurrences in fresh content (transparency for user)
    let occurrences = 0
    let idx = -1
    while ((idx = freshContent.indexOf(searchText, idx + 1)) !== -1) occurrences++

    if (occurrences === 0) {
      return {
        success: false,
        reason: 'Text no longer present in file (it may have been edited externally)'
      }
    }

    let newContent
    if (typeof position === 'number') {
      // Position-aware replacement: verify text is still at that exact position
      const atPos = freshContent.substring(position, position + searchText.length)
      if (atPos === searchText) {
        newContent = freshContent.substring(0, position)
          + replaceText
          + freshContent.substring(position + searchText.length)
      } else {
        // File shifted (lines added/removed externally). Search within ±500 chars of expected position.
        const windowStart = Math.max(0, position - 500)
        const nearbyIdx = freshContent.indexOf(searchText, windowStart)
        if (nearbyIdx === -1 || nearbyIdx > position + 500) {
          return { success: false, reason: 'Text moved beyond recovery window' }
        }
        newContent = freshContent.substring(0, nearbyIdx)
          + replaceText
          + freshContent.substring(nearbyIdx + searchText.length)
      }
    } else {
      // Default: replace first occurrence (string-based)
      newContent = freshContent.replace(searchText, replaceText)
    }

    if (newContent === freshContent) {
      return { success: false, reason: 'No changes detected' }
    }

    const writable = await fileHandle.createWritable()
    await writable.write(newContent)
    await writable.close()

    // Update the cache with the fresh content
    for (const [path, entry] of fileIndex) {
      if (entry.handle === fileHandle) {
        fileIndex.set(path, { handle: fileHandle, content: newContent })
        break
      }
    }
    return { success: true, occurrences, freshContent }
  }

  // ---------------------------------------------------------------------------
  // FILE PICKER MODAL (for disambiguation)
  // ---------------------------------------------------------------------------

  function showFilePicker(filePaths, previewText) {
    return new Promise((resolve) => {
      const existing = document.getElementById('wh-file-picker')
      if (existing) existing.remove()

      const modal = document.createElement('div')
      modal.id = 'wh-file-picker'

      const preview = previewText.length > 60
        ? previewText.substring(0, 57) + '…'
        : previewText

      modal.innerHTML = `
        <div class="wh-modal">
          <h3>Text found in multiple files</h3>
          <div class="wh-subtitle">"${preview.replace(/</g, '&lt;')}"</div>
          ${filePaths.map(p => `<div class="wh-option" data-path="${p}">${p}</div>`).join('')}
        </div>
      `

      modal.addEventListener('click', (e) => {
        const option = e.target.closest('.wh-option')
        if (option) {
          modal.remove()
          resolve(option.dataset.path)
        } else if (e.target === modal) {
          modal.remove()
          resolve(null)
        }
      })

      document.body.appendChild(modal)
    })
  }

  // ---------------------------------------------------------------------------
  // IMAGE EDITING
  // ---------------------------------------------------------------------------

  async function handleImageEdit(imgEl) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'

    input.onchange = async () => {
      const file = input.files[0]
      if (!file) return

      // Find the image src in source files
      const currentSrc = imgEl.getAttribute('src')
      if (!currentSrc) {
        toast('No src attribute found', 'error')
        return
      }

      setElementState(imgEl, 'saving')

      // Determine target filename and path
      const newFileName = file.name
      const srcParts = currentSrc.split('/')
      srcParts[srcParts.length - 1] = newFileName
      const newSrc = srcParts.join('/')

      // Write the image file to the project directory
      try {
        // Navigate to the correct subdirectory
        const pathParts = newSrc.replace(/^\//, '').split('/')
        let targetDir = dirHandle

        for (let i = 0; i < pathParts.length - 1; i++) {
          try {
            targetDir = await targetDir.getDirectoryHandle(pathParts[i])
          } catch {
            targetDir = await targetDir.getDirectoryHandle(pathParts[i], { create: true })
          }
        }

        const imgHandle = await targetDir.getFileHandle(newFileName, { create: true })
        const writable = await imgHandle.createWritable()
        await writable.write(file)
        await writable.close()

        // Update the src in source files (only if filename changed)
        let srcUpdateNote = ''
        if (currentSrc !== newSrc) {
          const results = searchFiles(currentSrc)
          if (results.length > 0) {
            const target = results.length === 1
              ? results[0]
              : await pickFromResults(results, currentSrc)

            if (target) {
              const result = await writeFile(target.handle, target.content, currentSrc, newSrc)
              if (result.success) {
                logEdit(target.path, currentSrc, newSrc, result.freshContent, target.handle)
                srcUpdateNote = ` & updated src in ${target.path}`
              }
            }
          }
        }

        // Update preview immediately
        imgEl.src = URL.createObjectURL(file)
        setElementState(imgEl, 'success')
        toast(`Image replaced → ${newFileName}${srcUpdateNote}`, 'success')
      } catch (err) {
        setElementState(imgEl, 'error')
        toast(`Image save failed: ${err.message}`, 'error')
      }
    }

    input.click()
  }

  async function pickFromResults(results, text) {
    const chosenPath = await showFilePicker(results.map(r => r.path), text)
    return chosenPath ? results.find(r => r.path === chosenPath) : null
  }

  // ---------------------------------------------------------------------------
  // TEXT EDITING — Google Docs style
  // ---------------------------------------------------------------------------
  // Editable text elements have contentEditable=true set upfront (in tagEditableElements)
  // so the BROWSER handles cursor placement, double-click word select, and drag-to-select
  // natively. We just react to focus/blur to track which element is being edited.

  function handleFocusIn(e) {
    const el = e.target
    if (!el || !el.getAttribute) return
    if (el.getAttribute('data-wh-editable') !== 'text') return

    // Capture the original text on first focus so we can diff it later
    if (!el.hasAttribute('data-wh-original')) {
      el.setAttribute('data-wh-original', el.innerText)
    }
    el.setAttribute('data-wh-editing', 'true')
    activeElement = el
  }

  function handleFocusOut(e) {
    const el = e.target
    if (!el || !el.getAttribute) return
    if (el.getAttribute('data-wh-editable') !== 'text') return
    if (!el.hasAttribute('data-wh-editing')) return

    // Defer briefly so click-to-element-B can complete before we save A
    setTimeout(() => {
      // Only finish if focus actually left this element
      if (document.activeElement !== el && el.hasAttribute('data-wh-editing')) {
        finishEditing(el)
      }
    }, 100)
  }

  /**
   * Diff old and new text at the word level to find what changed,
   * PLUS surrounding context words for safe, unambiguous searching.
   *
   * "We Build Amazing Websites" → "We Build Incredible Websites"
   *   => { oldChanged: "Amazing", newChanged: "Incredible",
   *        contextBefore: "We Build", contextAfter: "Websites" }
   */
  function diffTexts(oldText, newText) {
    const oldWords = oldText.trim().split(/\s+/)
    const newWords = newText.trim().split(/\s+/)

    // Find common prefix length
    let prefixLen = 0
    while (
      prefixLen < oldWords.length &&
      prefixLen < newWords.length &&
      oldWords[prefixLen] === newWords[prefixLen]
    ) {
      prefixLen++
    }

    // Find common suffix length (from end, not overlapping prefix)
    let suffixLen = 0
    while (
      suffixLen < oldWords.length - prefixLen &&
      suffixLen < newWords.length - prefixLen &&
      oldWords[oldWords.length - 1 - suffixLen] === newWords[newWords.length - 1 - suffixLen]
    ) {
      suffixLen++
    }

    const endSlice = suffixLen > 0 ? -suffixLen : undefined
    const oldChanged = oldWords.slice(prefixLen, endSlice).join(' ')
    const newChanged = newWords.slice(prefixLen, endSlice).join(' ')

    // Grab up to 3 words before and after as context for safe matching
    const ctxBefore = oldWords.slice(Math.max(0, prefixLen - 3), prefixLen)
    const ctxAfterStart = oldWords.length - suffixLen
    const ctxAfter = oldWords.slice(ctxAfterStart, Math.min(oldWords.length, ctxAfterStart + 3))

    return {
      oldChanged,
      newChanged,
      contextBefore: ctxBefore.join(' '),
      contextAfter: ctxAfter.join(' ')
    }
  }

  /**
   * Log an edit and store enough info to undo it.
   */
  function logEdit(path, oldText, newText, oldFileContent, fileHandle) {
    editLog.push({
      timestamp: new Date().toISOString(),
      path,
      oldText,
      newText,
      oldFileContent,
      handle: fileHandle
    })
    editCount++
    updateToolbar()
  }

  /**
   * Undo the most recent edit by restoring the previous file content.
   */
  async function undoLastEdit() {
    if (editLog.length === 0) {
      toast('Nothing to undo', 'info')
      return
    }

    const last = editLog.pop()
    try {
      const writable = await last.handle.createWritable()
      await writable.write(last.oldFileContent)
      await writable.close()

      // Update cache
      for (const [path, entry] of fileIndex) {
        if (entry.handle === last.handle) {
          fileIndex.set(path, { handle: last.handle, content: last.oldFileContent })
          break
        }
      }

      editCount = Math.max(0, editCount - 1)
      updateToolbar()
      toast(`Undone → ${last.path}`, 'success')
    } catch (err) {
      editLog.push(last) // put it back if undo failed
      toast(`Undo failed: ${err.message}`, 'error')
    }
  }

  /**
   * Apply a visual feedback state to an element (saving, success, error).
   * Auto-clears after the animation.
   */
  function setElementState(el, state) {
    if (!el) return
    el.setAttribute('data-wh-state', state)
    if (state === 'success' || state === 'error') {
      setTimeout(() => {
        if (el.getAttribute('data-wh-state') === state) {
          el.removeAttribute('data-wh-state')
        }
      }, 700)
    }
  }

  function clearElementState(el) {
    if (el) el.removeAttribute('data-wh-state')
  }

  /**
   * When no match can be found, offer two recovery paths:
   *   1. Copy a Claude Code prompt (handles dynamic text)
   *   2. Manual search dialog (handles indexing gaps / missing React debug info)
   */
  function offerClaudePrompt(oldText, newText, hintFiles = []) {
    const fileList = hintFiles.length > 0
      ? `\n\nReact says this element was rendered by these files (in order of specificity):\n${hintFiles.map(h => `- ${h.path}`).join('\n')}`
      : ''

    const prompt = `In my codebase, change the text "${oldText.trim()}" to "${newText.trim()}". It may be inside a variable, prop, translation key, or external file rather than inline in the JSX.${fileList}`

    const container = ensureToastContainer()
    const el = document.createElement('div')
    el.className = 'wh-toast wh-error'
    el.style.pointerEvents = 'auto'
    el.style.minWidth = '320px'

    const hintHtml = hintFiles.length > 0
      ? `<div style="font-size:10px;color:#888;margin-top:8px;font-family:'SF Mono',monospace">React source: ${hintFiles[0].path}${hintFiles.length > 1 ? ` (+${hintFiles.length - 1} more)` : ''}</div>`
      : `<div style="font-size:10px;color:#888;margin-top:8px;font-family:'SF Mono',monospace">React source: (none — _debugSource not populated)</div>`

    el.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px">Couldn't find this text in your source files</div>
      <div style="font-size:11px;color:#aaa;margin-bottom:10px">
        Indexed ${fileIndex.size} files. Try a manual search, or copy a Claude Code prompt.
      </div>
      <div style="display:flex;gap:6px">
        <button class="wh-toast-btn wh-search-btn">Search manually</button>
        <button class="wh-toast-btn wh-claude-btn">Copy Claude prompt</button>
      </div>
      ${hintHtml}
    `

    el.querySelector('.wh-claude-btn').addEventListener('click', async (e) => {
      e.stopPropagation()
      try {
        await navigator.clipboard.writeText(prompt)
        toast('Prompt copied — paste into Claude Code', 'success')
        el.classList.remove('wh-show')
        el.classList.add('wh-hide')
        setTimeout(() => el.remove(), 300)
      } catch (_) {
        toast('Could not copy to clipboard', 'error')
      }
    })

    el.querySelector('.wh-search-btn').addEventListener('click', (e) => {
      e.stopPropagation()
      el.remove()
      openManualSearch(oldText, newText)
    })

    container.appendChild(el)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => el.classList.add('wh-show'))
    })

    setTimeout(() => {
      if (el.parentNode) {
        el.classList.remove('wh-show')
        el.classList.add('wh-hide')
        setTimeout(() => el.remove(), 300)
      }
    }, 15000)
  }

  /**
   * Manual search modal. Lets the user type any search term, see matching files,
   * pick one to apply the edit to. Last-resort escape hatch when auto-detection fails.
   */
  function openManualSearch(originalText, newText) {
    const existing = document.getElementById('wh-manual-search')
    if (existing) existing.remove()

    const modal = document.createElement('div')
    modal.id = 'wh-manual-search'
    modal.innerHTML = `
      <div class="wh-search-modal">
        <h3>Manual search</h3>
        <div class="wh-search-sub">
          ${fileIndex.size} files indexed. Type any unique part of the text you're trying to find.
        </div>
        <input type="text" id="wh-search-input" placeholder="Search text..." />
        <div class="wh-search-info" id="wh-search-info">Type to search</div>
        <div class="wh-search-results" id="wh-search-results"></div>
        <div class="wh-search-replace-section" id="wh-search-replace-section" style="display:none">
          <div class="wh-search-sub">Replace with:</div>
          <input type="text" id="wh-search-replace" />
          <div style="display:flex;gap:6px;margin-top:10px">
            <button class="wh-toast-btn wh-search-apply">Apply to selected file</button>
            <button class="wh-toast-btn wh-search-cancel">Cancel</button>
          </div>
        </div>
      </div>
    `
    document.body.appendChild(modal)

    const input = document.getElementById('wh-search-input')
    const results = document.getElementById('wh-search-results')
    const info = document.getElementById('wh-search-info')
    const replaceSection = document.getElementById('wh-search-replace-section')
    const replaceInput = document.getElementById('wh-search-replace')
    let selectedResult = null

    // Pre-fill with a reasonable substring of the original text
    const initial = (originalText || '').trim().split(/\s+/).slice(0, 4).join(' ')
    input.value = initial
    replaceInput.value = newText.trim()

    const renderResults = () => {
      const query = input.value.trim()
      if (!query) {
        info.textContent = 'Type to search'
        results.innerHTML = ''
        replaceSection.style.display = 'none'
        return
      }

      const hits = searchFiles(query)
      info.textContent = `${hits.length} file${hits.length === 1 ? '' : 's'} contain "${query}"`

      results.innerHTML = hits.slice(0, 50).map((r, i) => {
        const idx = r.content.indexOf(r.match)
        const lineNum = r.content.substring(0, idx).split('\n').length
        // Show a snippet of context around the match
        const snippet = r.content
          .substring(Math.max(0, idx - 40), Math.min(r.content.length, idx + r.match.length + 40))
          .replace(/\n/g, ' ')
          .replace(/</g, '&lt;')
        return `
          <div class="wh-search-result" data-idx="${i}">
            <div class="wh-search-path">${r.path}:${lineNum}</div>
            <div class="wh-search-snippet">…${snippet}…</div>
          </div>
        `
      }).join('')

      results.querySelectorAll('.wh-search-result').forEach(el => {
        el.addEventListener('click', () => {
          results.querySelectorAll('.wh-search-result').forEach(r => r.classList.remove('wh-selected'))
          el.classList.add('wh-selected')
          selectedResult = hits[parseInt(el.dataset.idx, 10)]
          replaceSection.style.display = 'block'
        })
      })
    }

    input.addEventListener('input', renderResults)
    renderResults()

    modal.querySelector('.wh-search-apply').addEventListener('click', async () => {
      if (!selectedResult) return
      const findText = selectedResult.match
      const replaceText = replaceInput.value
      try {
        const result = await writeFile(
          selectedResult.handle, selectedResult.content,
          findText, replaceText
        )
        if (result.success) {
          logEdit(selectedResult.path, findText, replaceText, result.freshContent, selectedResult.handle)
          toast(`Saved → ${selectedResult.path}`, 'success')
          modal.remove()
        } else {
          toast(`Write failed: ${result.reason}`, 'error')
        }
      } catch (err) {
        toast(`Write failed: ${err.message}`, 'error')
      }
    })

    modal.querySelector('.wh-search-cancel').addEventListener('click', () => modal.remove())
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove()
    })

    input.focus()
    input.select()
  }

  /**
   * Given an array of search results and a list of React-hinted files,
   * return only the results that match a hint (if any do). Falls back to
   * all results if no hint matches.
   */
  function preferHints(results, hintPaths) {
    if (!hintPaths || hintPaths.length === 0) return results
    const hinted = results.filter(r => hintPaths.includes(r.path))
    return hinted.length > 0 ? hinted : results
  }

  async function finishEditing(el) {
    if (!el || !el.hasAttribute('data-wh-editing')) return

    // Read original text from the element itself, not from a global.
    // This makes editing state element-local and prevents races when
    // the user clicks between elements rapidly.
    const originalText = el.getAttribute('data-wh-original') || ''
    const newText = el.innerText

    // Capture React fiber hints BEFORE we mutate any state. These tell us
    // which source files React thinks rendered this element. We expand the
    // hint scope to include files imported by those components (data files,
    // content modules) — that's where text usually lives in vibe-coded sites.
    const directHints = getReactHintFiles(el)
    const hintFiles = expandHintsWithImports(directHints, 2)
    const hintPaths = hintFiles.map(h => h.path)

    // ---- Diagnostic logging (open DevTools console to see) ----
    console.groupCollapsed(
      `%c[Webhaus Editor] Edit attempt`,
      'color:#2563eb;font-weight:bold'
    )
    console.log('Element:', el)
    console.log('Original text:', JSON.stringify(originalText))
    console.log('New text:', JSON.stringify(newText))
    console.log('Indexed files:', fileIndex.size)
    console.log('React-detected source files:', directHints.map(h => h.path))
    console.log('Expanded hint scope (with imports):', hintPaths)
    console.groupEnd()

    // Clean up tracking attributes — but keep contentEditable since edit mode is still on
    el.removeAttribute('data-wh-editing')
    el.removeAttribute('data-wh-original')
    if (activeElement === el) activeElement = null

    if (newText.trim() === originalText.trim()) {
      return
    }

    if (!dirHandle) {
      toast('No project folder selected', 'error')
      setElementState(el, 'error')
      el.innerText = originalText
      return
    }

    // Show saving state on the element itself
    setElementState(el, 'saving')

    const finalize = (state, restoreOriginal = false) => {
      if (restoreOriginal) el.innerText = originalText
      setElementState(el, state)
    }

    // ---- Strategy 0: direct file:line edit using data-wh-source ----
    // The element has data-wh-source set by React fiber instrumentation.
    // Go straight to that file and find the text near that line — no global search.
    const sourceAttr = el.getAttribute('data-wh-source')
    const ownerAttr = el.getAttribute('data-wh-owner')
    const sourceLocations = [sourceAttr, ownerAttr].filter(Boolean).map(parseSourceAttr).filter(Boolean)

    if (sourceLocations.length > 0) {
      console.log('[Webhaus Editor] Strategy 0 sources:', sourceLocations)

      for (const loc of sourceLocations) {
        // Try the full original text first
        let scoped = searchInFileNearLine(loc.path, originalText.trim(), loc.line)
        let usedDiff = false
        let changedText = null
        let replacementText = newText.trim()

        // If the full text isn't there (prop-passed text → component file has no literal),
        // try the diff-extracted changed portion
        if (!scoped) {
          const diffForScoped = diffTexts(originalText, newText)
          if (diffForScoped.oldChanged) {
            scoped = searchInFileNearLine(loc.path, diffForScoped.oldChanged, loc.line)
            if (scoped) {
              usedDiff = true
              changedText = diffForScoped.oldChanged
              replacementText = diffForScoped.newChanged
            }
          }
        }

        if (scoped) {
          console.log('[Webhaus Editor] Strategy 0 matched in', scoped.path,
            'line', scoped.line, '(distance', scoped.distance, ')')

          try {
            const result = await writeFile(
              scoped.handle, scoped.content,
              scoped.match, replacementText,
              scoped.position // position-aware write — replaces at exact location
            )
            if (result.success) {
              const logFrom = usedDiff ? changedText : scoped.match
              logEdit(scoped.path, logFrom, replacementText, result.freshContent, scoped.handle)
              const noteDetail = usedDiff
                ? ` ("${changedText}" → "${replacementText}")`
                : ''
              toast(`Saved → ${scoped.path}:${scoped.line}${noteDetail}`, 'success')
              return finalize('success')
            } else {
              console.warn('[Webhaus Editor] Strategy 0 write failed:', result.reason)
            }
          } catch (err) {
            toast(`Write failed: ${err.message}`, 'error')
            return finalize('error', true)
          }
        }
      }
      console.log('[Webhaus Editor] Strategy 0: no match in any sourced file, falling through')
    }

    // ---- Strategy 1: full text search ----
    let results = searchFiles(originalText.trim())
    console.log('[Webhaus Editor] Strategy 1 (full text):', results.length, 'matches')
    results = preferHints(results, hintPaths)

    if (results.length > 0) {
      let target
      if (results.length === 1) {
        target = results[0]
      } else {
        target = await pickFromResults(results, originalText.trim())
      }

      if (target) {
        try {
          const result = await writeFile(
            target.handle, target.content,
            target.match, newText.trim()
          )
          if (result.success) {
            logEdit(target.path, target.match, newText.trim(), result.freshContent, target.handle)
            const occNote = result.occurrences > 1
              ? ` · ${result.occurrences} matches in file (first changed — undo if wrong)`
              : ''
            const partialNote = target.partial ? ' (partial match)' : ''
            toast(`Saved → ${target.path}${partialNote}${occNote}`, 'success')
            return finalize('success')
          }
        } catch (err) {
          toast(`Write failed: ${err.message}`, 'error')
          return finalize('error', true)
        }
      }
    }

    // ---- Strategy 2: context-aware diff search ----
    const diff = diffTexts(originalText, newText)
    console.log('[Webhaus Editor] Diff:', diff)

    if (diff.oldChanged) {
      const contextPhrase = [diff.contextBefore, diff.oldChanged, diff.contextAfter]
        .filter(Boolean).join(' ')
      console.log('[Webhaus Editor] Strategy 2 context phrase:', JSON.stringify(contextPhrase))

      let diffResults = searchFiles(contextPhrase)
      console.log('[Webhaus Editor] Strategy 2 (context diff):', diffResults.length, 'matches')
      diffResults = preferHints(diffResults, hintPaths)

      if (diffResults.length > 0) {
        let target
        if (diffResults.length === 1) {
          target = diffResults[0]
        } else {
          target = await pickFromResults(diffResults, contextPhrase)
        }

        if (target) {
          try {
            const matchedContext = target.match
            const changedPattern = buildFlexiblePattern(diff.oldChanged)
            if (changedPattern) {
              const newContext = matchedContext.replace(changedPattern, diff.newChanged)
              const result = await writeFile(
                target.handle, target.content,
                matchedContext, newContext
              )
              if (result.success) {
                logEdit(target.path, diff.oldChanged, diff.newChanged, result.freshContent, target.handle)
                toast(`Saved → ${target.path} ("${diff.oldChanged}" → "${diff.newChanged}")`, 'success')
                return finalize('success')
              }
            }
          } catch (err) {
            toast(`Write failed: ${err.message}`, 'error')
            return finalize('error', true)
          }
        }
      }
    }

    // ---- Strategy 3: hint-scoped diff search ----
    // The changed word almost always exists as a literal in one of the
    // expanded hint files (components + their imported data files).
    if (hintFiles.length > 0 && diff.oldChanged) {
      const allMatches = searchFiles(diff.oldChanged)
      const hintMatches = allMatches.filter(r => hintPaths.includes(r.path))
      console.log('[Webhaus Editor] Strategy 3 (hint-scoped diff):',
        allMatches.length, 'global,', hintMatches.length, 'in hint scope')

      if (hintMatches.length > 0) {
        let target = hintMatches.length === 1
          ? hintMatches[0]
          : await pickFromResults(hintMatches, diff.oldChanged)

        if (target) {
          try {
            const result = await writeFile(
              target.handle, target.content,
              target.match, diff.newChanged
            )
            if (result.success) {
              logEdit(target.path, diff.oldChanged, diff.newChanged, result.freshContent, target.handle)
              const occNote = result.occurrences > 1
                ? ` · ${result.occurrences} matches in file (first changed — undo if wrong)`
                : ''
              toast(`Saved → ${target.path} via React source ("${diff.oldChanged}" → "${diff.newChanged}")${occNote}`, 'success')
              return finalize('success')
            }
          } catch (err) {
            toast(`Write failed: ${err.message}`, 'error')
            return finalize('error', true)
          }
        }
      }
    }

    // ---- Strategy 4: global diff search (last resort, only if uniquely identifiable) ----
    // No hints worked. As a last resort, search ALL files for the changed word.
    // Only proceed if the changed text is found in exactly ONE file globally —
    // otherwise it's too dangerous to guess.
    if (diff.oldChanged) {
      const globalMatches = searchFiles(diff.oldChanged)
      console.log('[Webhaus Editor] Strategy 4 (global diff):', globalMatches.length, 'matches')

      if (globalMatches.length === 1) {
        const target = globalMatches[0]
        try {
          const result = await writeFile(
            target.handle, target.content,
            target.match, diff.newChanged
          )
          if (result.success) {
            logEdit(target.path, diff.oldChanged, diff.newChanged, result.freshContent, target.handle)
            toast(`Saved → ${target.path} (global match, "${diff.oldChanged}" → "${diff.newChanged}")`, 'success')
            return finalize('success')
          }
        } catch (err) {
          toast(`Write failed: ${err.message}`, 'error')
          return finalize('error', true)
        }
      } else if (globalMatches.length > 1) {
        // Multiple matches and no React hint to disambiguate.
        // Show picker so user can choose.
        const target = await pickFromResults(globalMatches, diff.oldChanged)
        if (target) {
          try {
            const result = await writeFile(
              target.handle, target.content,
              target.match, diff.newChanged
            )
            if (result.success) {
              logEdit(target.path, diff.oldChanged, diff.newChanged, result.freshContent, target.handle)
              toast(`Saved → ${target.path} ("${diff.oldChanged}" → "${diff.newChanged}")`, 'success')
              return finalize('success')
            }
          } catch (err) {
            toast(`Write failed: ${err.message}`, 'error')
            return finalize('error', true)
          }
        }
      }
    }

    // ---- All strategies failed ----
    console.warn('[Webhaus Editor] All strategies failed. Text may be computed at runtime.')
    offerClaudePrompt(originalText, newText, hintFiles)
    finalize('error', true)
  }

  // ---------------------------------------------------------------------------
  // ELEMENT TAGGING
  // ---------------------------------------------------------------------------

  function tagEditableElements() {
    // Remove old tags AND restore contentEditable to whatever it was before.
    // IMPORTANT: don't strip data-wh-editing / data-wh-original here — a focusout
    // may have scheduled a deferred finishEditing that still needs to run.
    document.querySelectorAll('[data-wh-editable]').forEach(el => {
      el.removeAttribute('data-wh-editable')
      el.removeAttribute('data-wh-source')
      el.removeAttribute('data-wh-owner')
      if (el.hasAttribute('data-wh-was-managed')) {
        el.removeAttribute('contenteditable')
        el.removeAttribute('data-wh-was-managed')
      }
    })

    if (!editMode) return

    // Tag text elements AND set contentEditable on them now (not on click).
    // This lets the browser handle click positioning, double-click word select,
    // and drag-to-select natively — exactly like Google Docs.
    const textSelectors = 'h1, h2, h3, h4, h5, h6, p, span, a, li, td, th, blockquote, figcaption, label, dt, dd, button, [class*="title"], [class*="heading"], [class*="text"], [class*="description"], [class*="subtitle"]'

    document.querySelectorAll(textSelectors).forEach(el => {
      if (SKIP_ELEMENTS.includes(el.tagName)) return
      if (el.closest('#wh-toolbar, #wh-toast-container, #wh-file-picker, #wh-log-panel')) return
      if (el.children.length > 3) return // Skip containers with many children

      // Only tag if it has meaningful direct text content
      const directText = getDirectText(el)
      if (directText.trim().length > 0) {
        el.setAttribute('data-wh-editable', 'text')

        // Set contentEditable now (don't wait for click) — but remember whether
        // we added it so we can clean up properly when leaving edit mode
        if (!el.hasAttribute('contenteditable')) {
          el.setAttribute('contenteditable', 'true')
          el.setAttribute('data-wh-was-managed', 'true')
        }
        // Disable spellcheck red squiggles which are visually noisy
        el.setAttribute('spellcheck', 'false')
      }
    })

    // Tag images (these still use click-to-replace)
    document.querySelectorAll('img').forEach(el => {
      if (el.closest('#wh-toolbar, #wh-toast-container')) return
      el.setAttribute('data-wh-editable', 'image')
    })

    // Now that everything is tagged, walk React fibers and stamp data-wh-source
    // onto each element so finishEditing knows the exact file:line:col without searching.
    instrumentElementSources()
  }

  /** Get only the direct text content of an element, not its children's text */
  function getDirectText(el) {
    let text = ''
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent
      }
    }
    return text
  }

  // ---------------------------------------------------------------------------
  // EVENT HANDLING
  // ---------------------------------------------------------------------------

  function handleClick(e) {
    if (!editMode) return

    const editable = e.target.closest('[data-wh-editable]')
    if (!editable) return

    const type = editable.getAttribute('data-wh-editable')

    if (type === 'image') {
      // Images: intercept the click entirely to show the file picker
      e.preventDefault()
      e.stopPropagation()
      handleImageEdit(editable)
      return
    }

    // For text: stopPropagation to prevent the page's own click handlers
    // (links navigating, buttons activating modals, etc.) from firing in edit mode.
    // But DON'T preventDefault — that would break native cursor placement,
    // double-click word selection, and drag-to-select.
    e.stopPropagation()
  }

  function handleKeydown(e) {
    // Global Cmd/Ctrl+E: toggle edit mode (works even while editing — blurs first to save)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
      if (!dirHandle) {
        toast('Select a project folder first', 'info')
        return
      }
      e.preventDefault()
      // If editing, blur first so focusout fires and the in-progress edit gets saved
      if (activeElement) activeElement.blur()
      editMode = !editMode
      document.body.classList.toggle('wh-edit-mode', editMode)
      tagEditableElements()
      updateToolbar()
      return
    }

    // Global undo: Cmd/Ctrl+Z when NOT editing an element
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !activeElement && editLog.length > 0) {
      e.preventDefault()
      undoLastEdit()
      renderLog()
      return
    }

    if (!activeElement) return

    // Escape cancels editing (restore original, no save)
    if (e.key === 'Escape') {
      const el = activeElement
      const original = el.getAttribute('data-wh-original') || ''
      el.innerText = original
      el.removeAttribute('data-wh-editing')
      el.removeAttribute('data-wh-original')
      clearElementState(el)
      el.blur()
      activeElement = null
      return
    }

    // Enter (without shift) saves for single-line elements
    if (e.key === 'Enter' && !e.shiftKey) {
      const tag = activeElement.tagName
      if (['H1','H2','H3','H4','H5','H6','SPAN','A','BUTTON','LABEL','LI'].includes(tag)) {
        e.preventDefault()
        activeElement.blur()  // triggers focusout → finishEditing
      }
    }

    // Prevent formatting shortcuts
    if ((e.metaKey || e.ctrlKey) && ['b','i','u'].includes(e.key.toLowerCase())) {
      e.preventDefault()
    }
  }

  // ---------------------------------------------------------------------------
  // TOOLBAR
  // ---------------------------------------------------------------------------

  function createToolbar() {
    const bar = document.createElement('div')
    bar.id = 'wh-toolbar'
    bar.innerHTML = `
      <span class="wh-logo" title="Webhaus Editor v${WEBHAUS_EDITOR_VERSION}">W</span>
      <span class="wh-dot" id="wh-dot"></span>
      <button id="wh-btn-folder" title="Select your project folder">Open Folder</button>
      <button id="wh-btn-edit" title="Toggle edit mode (⌘E)">Edit Mode</button>
      <button id="wh-btn-undo" style="display:none" title="Undo last edit (⌘Z)">⌘Z Undo</button>
      <button id="wh-btn-log" style="display:none" title="Show edit log">Log</button>
      <span class="wh-status" id="wh-status">No folder selected</span>
    `
    document.body.appendChild(bar)

    // Log panel (hidden by default)
    const logPanel = document.createElement('div')
    logPanel.id = 'wh-log-panel'
    logPanel.innerHTML = `
      <div class="wh-log-header">
        <span>Edit Log</span>
        <button class="wh-undo-btn" id="wh-log-undo">Undo Last</button>
      </div>
      <div class="wh-log-list" id="wh-log-list">
        <div class="wh-log-empty">No edits yet</div>
      </div>
    `
    document.body.appendChild(logPanel)

    document.getElementById('wh-btn-folder').addEventListener('click', async () => {
      await pickProjectFolder()
    })

    document.getElementById('wh-btn-edit').addEventListener('click', () => {
      if (!dirHandle) {
        toast('Select a project folder first', 'info')
        return
      }
      // If editing, blur first so focusout fires and the in-progress edit gets saved
      if (activeElement) activeElement.blur()
      editMode = !editMode
      document.body.classList.toggle('wh-edit-mode', editMode)
      tagEditableElements()
      updateToolbar()
    })

    document.getElementById('wh-btn-undo').addEventListener('click', async () => {
      await undoLastEdit()
      renderLog()
    })

    document.getElementById('wh-log-undo').addEventListener('click', async () => {
      await undoLastEdit()
      renderLog()
    })

    document.getElementById('wh-btn-log').addEventListener('click', () => {
      const panel = document.getElementById('wh-log-panel')
      panel.classList.toggle('wh-open')
      renderLog()
    })
  }

  function truncate(str, len) {
    return str.length > len ? str.substring(0, len - 1) + '…' : str
  }

  function renderLog() {
    const list = document.getElementById('wh-log-list')
    if (!list) return

    if (editLog.length === 0) {
      list.innerHTML = '<div class="wh-log-empty">No edits yet</div>'
      return
    }

    // Show most recent first
    list.innerHTML = [...editLog].reverse().map((entry, i) => {
      const time = new Date(entry.timestamp).toLocaleTimeString()
      return `
        <div class="wh-log-entry">
          <div class="wh-log-file">${entry.path}</div>
          <div class="wh-log-diff">
            <span class="wh-log-old">${truncate(entry.oldText, 60)}</span>
            → <span class="wh-log-new">${truncate(entry.newText, 60)}</span>
          </div>
          <div class="wh-log-time">${time}</div>
        </div>
      `
    }).join('')
  }

  function updateToolbar() {
    const dot = document.getElementById('wh-dot')
    const status = document.getElementById('wh-status')
    const editBtn = document.getElementById('wh-btn-edit')
    const folderBtn = document.getElementById('wh-btn-folder')
    const undoBtn = document.getElementById('wh-btn-undo')
    const logBtn = document.getElementById('wh-btn-log')

    if (!dot) return

    // Show/hide undo and log buttons based on edit history
    undoBtn.style.display = editLog.length > 0 ? '' : 'none'
    logBtn.style.display = editLog.length > 0 ? '' : 'none'

    if (!dirHandle) {
      dot.className = 'wh-dot'
      status.textContent = 'No folder selected'
      editBtn.classList.remove('wh-active')
    } else if (editMode) {
      dot.className = 'wh-dot wh-editing'
      status.innerHTML = `Editing${editCount ? ` · <span class="wh-badge">${editCount}</span>` : ''}`
      editBtn.classList.add('wh-active')
      editBtn.textContent = 'Editing'
      folderBtn.textContent = dirHandle.name
    } else {
      dot.className = 'wh-dot wh-connected'
      status.textContent = `${fileIndex.size} files${editCount ? ` · ${editCount} edits` : ''}`
      editBtn.classList.remove('wh-active')
      editBtn.textContent = 'Edit Mode'
      folderBtn.textContent = dirHandle.name
    }
  }

  // ---------------------------------------------------------------------------
  // MUTATION OBSERVER (re-tag after hot reload / DOM changes)
  // ---------------------------------------------------------------------------

  let retagTimeout = null
  function observeDOM() {
    const observer = new MutationObserver(() => {
      if (!editMode) return
      clearTimeout(retagTimeout)
      retagTimeout = setTimeout(() => tagEditableElements(), 300)
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  // ---------------------------------------------------------------------------
  // RE-INDEX ON VISIBILITY (handles switching back to the tab)
  // ---------------------------------------------------------------------------

  function observeVisibility() {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && dirHandle) {
        // Re-index to catch external file changes (e.g. from Claude Code)
        fileIndex.clear()
        await indexDirectory(dirHandle, '')
        updateToolbar()
      }
    })
  }

  // ---------------------------------------------------------------------------
  // DEBUG API (exposed on window.webhausEditor)
  // ---------------------------------------------------------------------------
  // Run these in the DevTools console to diagnose issues without polluting the page UI.

  function setupDebugApi() {
    window.webhausEditor = {
      version: WEBHAUS_EDITOR_VERSION,

      /** Print a complete health report of the current state */
      diagnostics() {
        const reactHook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__
        const reactVersion = reactHook && reactHook.renderers
          ? [...reactHook.renderers.values()][0]?.version
          : null

        // Test fiber detection on the first editable element
        let fiberSample = null
        const sampleEl = document.querySelector('[data-wh-editable]')
        if (sampleEl) {
          const fiber = findReactFiber(sampleEl)
          fiberSample = {
            element: sampleEl,
            hasFiber: !!fiber,
            hasDebugSource: !!(fiber && fiber._debugSource),
            hasDebugOwner: !!(fiber && fiber._debugOwner),
            debugSource: fiber && fiber._debugSource,
            availableKeys: fiber ? Object.keys(fiber).filter(k => k.startsWith('_')) : []
          }
        }

        const report = {
          version: WEBHAUS_EDITOR_VERSION,
          folder: dirHandle ? dirHandle.name : '(none selected)',
          indexedFiles: fileIndex.size,
          editMode,
          editsThisSession: editCount,
          reactVersion,
          fiberSample,
          indexStats: indexStats ? {
            directoriesEntered: indexStats.dirsEntered.length,
            directoriesSkipped: indexStats.dirsSkipped.length,
            filesSkippedByExt: indexStats.filesSkippedByExt,
            readErrors: indexStats.readErrors.length,
            extensionBreakdown: indexStats.extensionBreakdown,
            durationMs: indexStats.durationMs
          } : null
        }
        console.log('%c[Webhaus Editor] Diagnostics', 'color:#2563eb;font-weight:bold', report)
        return report
      },

      /** List all indexed files, optionally filtered */
      files(filter) {
        const all = [...fileIndex.keys()]
        const filtered = filter
          ? all.filter(p => p.includes(filter))
          : all
        console.log(`%c[Webhaus Editor] ${filtered.length} files${filter ? ` matching "${filter}"` : ''}`,
          'color:#2563eb;font-weight:bold')
        filtered.forEach(p => console.log('  ' + p))
        return filtered
      },

      /** Search for text across all indexed files */
      find(text) {
        const results = searchFiles(text)
        console.log(`%c[Webhaus Editor] "${text}" found in ${results.length} files`,
          'color:#2563eb;font-weight:bold')
        results.forEach(r => {
          const lineNumber = r.content.substring(0, r.content.indexOf(r.match)).split('\n').length
          console.log(`  ${r.path}:${lineNumber}`)
        })
        return results
      },

      /** Inspect the React fiber for a given DOM element (or first editable if none passed) */
      fiber(el) {
        el = el || document.querySelector('[data-wh-editable]')
        if (!el) {
          console.warn('No element provided and no editable element found')
          return null
        }
        const fiber = findReactFiber(el)
        if (!fiber) {
          console.warn('No React fiber found on element', el)
          return null
        }
        const result = {
          element: el,
          fiber,
          debugSource: fiber._debugSource,
          debugOwner: fiber._debugOwner ? {
            type: fiber._debugOwner.type,
            debugSource: fiber._debugOwner._debugSource
          } : null,
          sourceFiles: getReactSourceFiles(el),
          hintFiles: getReactHintFiles(el).map(h => h.path)
        }
        console.log('[Webhaus Editor] Fiber info:', result)
        return result
      },

      /** Manually write a find-and-replace to a specific file */
      async write(filePath, find, replace) {
        const entry = fileIndex.get(filePath)
        if (!entry) {
          console.error(`File not in index: ${filePath}`)
          return false
        }
        if (!entry.content.includes(find)) {
          console.error(`Text not found in ${filePath}: ${JSON.stringify(find)}`)
          return false
        }
        const result = await writeFile(entry.handle, entry.content, find, replace)
        if (result.success) {
          console.log(`[Webhaus Editor] Wrote to ${filePath}`)
          logEdit(filePath, find, replace, result.freshContent, entry.handle)
          return true
        } else {
          console.error(`[Webhaus Editor] Write failed: ${result.reason}`)
          return false
        }
      },

      /** Re-index the project (useful if files were added externally) */
      async reindex() {
        if (!dirHandle) {
          console.warn('No project folder selected')
          return
        }
        fileIndex.clear()
        await indexDirectory(dirHandle, '')
        updateToolbar()
        console.log(`[Webhaus Editor] Re-indexed: ${fileIndex.size} files`)
      }
    }
    console.log(
      '%c[Webhaus Editor] Debug API ready. Try webhausEditor.diagnostics() or webhausEditor.find("your text")',
      'color:#888;font-style:italic'
    )
  }

  // ---------------------------------------------------------------------------
  // INIT
  // ---------------------------------------------------------------------------

  async function init() {
    // Check API support
    if (!('showDirectoryPicker' in window)) {
      alert('Webhaus Editor requires Chrome or Edge (File System Access API not supported in this browser).')
      return
    }

    injectStyles()
    createToolbar()
    ensureToastContainer()

    document.addEventListener('click', handleClick, true)
    document.addEventListener('keydown', handleKeydown, true)
    document.addEventListener('focusin', handleFocusIn, true)
    document.addEventListener('focusout', handleFocusOut, true)

    observeDOM()
    observeVisibility()
    setupDebugApi()

    toast(`Webhaus Editor v${WEBHAUS_EDITOR_VERSION} loaded`, 'info')

    // Try to restore previously granted folder for this origin
    await tryRestoreFolder()
  }

  // Run
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
