/**
 * Webhaus Editor v1.0
 * 
 * On-canvas inline editor for vibe-coded sites.
 * Edit text and images directly on any localhost page.
 * Writes changes to source files via the File System Access API.
 * 
 * Usage:
 *   1. Drag the bookmarklet to your bookmarks bar (see README)
 *   2. Open your site on localhost
 *   3. Click the bookmarklet
 *   4. Pick your project folder (once per session)
 *   5. Click any text or image to edit
 * 
 * Requirements: Chrome/Edge (File System Access API)
 */
;(function () {
  'use strict'

  // Bail if already loaded
  if (window.__webhausEditor) return
  window.__webhausEditor = true

  // ---------------------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------------------

  const IGNORED_DIRS = [
    'node_modules', '.git', '.next', '.vercel', '.astro', '.svelte-kit',
    'dist', 'build', 'out', '.cache', '.turbo', '__pycache__', '.DS_Store'
  ]

  const SOURCE_EXTENSIONS = [
    '.html', '.htm', '.jsx', '.tsx', '.js', '.ts',
    '.astro', '.vue', '.svelte', '.md', '.mdx', '.njk', '.ejs', '.hbs'
  ]

  const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif', '.ico']

  const SKIP_ELEMENTS = ['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'SVG', 'PATH', 'CIRCLE', 'RECT', 'LINE', 'POLYGON', 'IFRAME']

  // ---------------------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------------------

  let dirHandle = null
  let fileIndex = new Map()   // relativePath -> { handle, content }
  let editMode = false
  let activeElement = null
  let originalText = ''
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

  async function indexDirectory(handle, basePath) {
    for await (const [name, entry] of handle.entries()) {
      if (name.startsWith('.') && name !== '.html') continue
      const fullPath = basePath ? `${basePath}/${name}` : name

      if (entry.kind === 'directory') {
        if (!IGNORED_DIRS.includes(name)) {
          await indexDirectory(entry, fullPath)
        }
      } else {
        const ext = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : ''
        if (SOURCE_EXTENSIONS.includes(ext)) {
          try {
            const file = await entry.getFile()
            const content = await file.text()
            fileIndex.set(fullPath, { handle: entry, content })
          } catch (_) { /* skip unreadable files */ }
        }
      }
    }
  }

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
   * Write updated content to a source file.
   * Re-reads the file fresh from disk first to avoid overwriting external changes
   * (e.g. if Claude Code or your editor modified the file between our index and write).
   * Returns { success, occurrences, freshContent } or { success: false, reason }
   */
  async function writeFile(fileHandle, cachedContent, searchText, replaceText) {
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

    const newContent = freshContent.replace(searchText, replaceText)
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
  // TEXT EDITING
  // ---------------------------------------------------------------------------

  function makeEditable(el) {
    if (activeElement) finishEditing(activeElement)

    activeElement = el
    originalText = el.innerText

    el.setAttribute('contenteditable', 'true')
    el.setAttribute('data-wh-editing', 'true')

    // Let the browser place the cursor where the user clicked.
    // Just ensure the element is focused — don't select all.
    el.focus()
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
   * When no match can be found, offer to copy a precise Claude Code prompt
   * so the user can still fix it fast without describing the change from scratch.
   */
  function offerClaudePrompt(oldText, newText) {
    const prompt = `In my codebase, change the text "${oldText.trim()}" to "${newText.trim()}". It may be inside a variable, prop, translation key, or external file rather than inline in the JSX.`

    const container = ensureToastContainer()
    const el = document.createElement('div')
    el.className = 'wh-toast wh-error'
    el.style.pointerEvents = 'auto'
    el.style.cursor = 'pointer'
    el.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px">Couldn't find this text in your source files</div>
      <div style="font-size:11px;color:#aaa;margin-bottom:6px">
        Likely a variable, prop, or translation. Click to copy a Claude Code prompt.
      </div>
    `

    el.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(prompt)
        el.innerHTML = `<div style="color:#4ade80">✓ Copied — paste into Claude Code</div>`
        setTimeout(() => {
          el.classList.remove('wh-show')
          el.classList.add('wh-hide')
          setTimeout(() => el.remove(), 300)
        }, 1500)
      } catch (_) {
        toast('Could not copy to clipboard', 'error')
      }
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
    }, 8000)
  }

  async function finishEditing(el) {
    if (!el || !el.hasAttribute('data-wh-editing')) return

    const newText = el.innerText
    el.removeAttribute('contenteditable')
    el.removeAttribute('data-wh-editing')

    if (newText.trim() === originalText.trim()) {
      activeElement = null
      return
    }

    if (!dirHandle) {
      toast('No project folder selected', 'error')
      setElementState(el, 'error')
      el.innerText = originalText
      activeElement = null
      return
    }

    // Show saving state on the element itself
    setElementState(el, 'saving')

    const finalize = (state, restoreOriginal = false) => {
      if (restoreOriginal) el.innerText = originalText
      setElementState(el, state)
      activeElement = null
    }

    // ---- Strategy 1: full text search (works for simple elements) ----
    let results = searchFiles(originalText.trim())

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
          } else {
            // Fall through to Strategy 2
          }
        } catch (err) {
          toast(`Write failed: ${err.message}`, 'error')
          return finalize('error', true)
        }
      }
    }

    // ---- Strategy 2: context-aware diff search (handles spans, mixed content) ----
    const diff = diffTexts(originalText, newText)

    if (diff.oldChanged) {
      // Build a context phrase: "[words before] [changed word] [words after]"
      // Searching with surrounding context narrows to the right file AND location,
      // far safer than searching for a single word in isolation.
      const contextPhrase = [diff.contextBefore, diff.oldChanged, diff.contextAfter]
        .filter(Boolean).join(' ')

      let diffResults = searchFiles(contextPhrase)

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
                const occNote = result.occurrences > 1
                  ? ` · ${result.occurrences} matches in file`
                  : ''
                toast(`Saved → ${target.path} ("${diff.oldChanged}" → "${diff.newChanged}")${occNote}`, 'success')
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

    // ---- Neither strategy found a match ----
    // Offer a Claude Code prompt so the user can still fix it quickly
    offerClaudePrompt(originalText, newText)
    finalize('error', true)
  }

  // ---------------------------------------------------------------------------
  // ELEMENT TAGGING
  // ---------------------------------------------------------------------------

  function tagEditableElements() {
    // Remove old tags
    document.querySelectorAll('[data-wh-editable]').forEach(el => {
      el.removeAttribute('data-wh-editable')
    })

    if (!editMode) return

    // Tag text elements
    const textSelectors = 'h1, h2, h3, h4, h5, h6, p, span, a, li, td, th, blockquote, figcaption, label, dt, dd, button, [class*="title"], [class*="heading"], [class*="text"], [class*="description"], [class*="subtitle"]'

    document.querySelectorAll(textSelectors).forEach(el => {
      if (SKIP_ELEMENTS.includes(el.tagName)) return
      if (el.closest('#wh-toolbar, #wh-toast-container, #wh-file-picker')) return
      if (el.children.length > 3) return // Skip containers with many children
      
      // Only tag if it has meaningful direct text content
      const directText = getDirectText(el)
      if (directText.trim().length > 0) {
        el.setAttribute('data-wh-editable', 'text')
      }
    })

    // Tag images
    document.querySelectorAll('img').forEach(el => {
      if (el.closest('#wh-toolbar, #wh-toast-container')) return
      el.setAttribute('data-wh-editable', 'image')
    })
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
    if (!editable) {
      if (activeElement) finishEditing(activeElement)
      return
    }

    e.preventDefault()
    e.stopPropagation()

    const type = editable.getAttribute('data-wh-editable')

    if (type === 'image') {
      handleImageEdit(editable)
    } else if (type === 'text') {
      makeEditable(editable)
    }
  }

  function handleKeydown(e) {
    // Global Cmd/Ctrl+E: toggle edit mode (when not actively editing text)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e' && !activeElement) {
      if (!dirHandle) {
        toast('Select a project folder first', 'info')
        return
      }
      e.preventDefault()
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
      activeElement.innerText = originalText
      activeElement.removeAttribute('contenteditable')
      activeElement.removeAttribute('data-wh-editing')
      clearElementState(activeElement)
      activeElement = null
      return
    }

    // Enter (without shift) saves for single-line elements
    if (e.key === 'Enter' && !e.shiftKey) {
      const tag = activeElement.tagName
      if (['H1','H2','H3','H4','H5','H6','SPAN','A','BUTTON','LABEL','LI'].includes(tag)) {
        e.preventDefault()
        finishEditing(activeElement)
      }
    }

    // Prevent formatting shortcuts
    if ((e.metaKey || e.ctrlKey) && ['b','i','u'].includes(e.key.toLowerCase())) {
      e.preventDefault()
    }
  }

  function handleBlur(e) {
    // Small delay to allow click events to process first
    setTimeout(() => {
      if (activeElement && !activeElement.contains(document.activeElement)) {
        finishEditing(activeElement)
      }
    }, 150)
  }

  // ---------------------------------------------------------------------------
  // TOOLBAR
  // ---------------------------------------------------------------------------

  function createToolbar() {
    const bar = document.createElement('div')
    bar.id = 'wh-toolbar'
    bar.innerHTML = `
      <span class="wh-logo">W</span>
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
    document.addEventListener('focusout', handleBlur, true)

    observeDOM()
    observeVisibility()

    toast('Webhaus Editor loaded', 'info')

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
