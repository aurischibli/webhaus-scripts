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
   * Search all indexed source files for an exact text match.
   * Returns array of { path, handle, content, occurrences }
   */
  function searchFiles(searchText) {
    const results = []
    const needle = searchText.trim()
    if (!needle) return results

    for (const [path, { handle, content }] of fileIndex) {
      // Count occurrences in this file
      let count = 0
      let idx = -1
      while ((idx = content.indexOf(needle, idx + 1)) !== -1) count++
      if (count > 0) {
        results.push({ path, handle, content, occurrences: count })
      }
    }
    return results
  }

  /**
   * Write updated content to a source file.
   */
  async function writeFile(fileHandle, oldContent, searchText, replaceText) {
    const newContent = oldContent.replace(searchText, replaceText)
    if (newContent === oldContent) return false

    const writable = await fileHandle.createWritable()
    await writable.write(newContent)
    await writable.close()

    // Update the cache
    for (const [path, entry] of fileIndex) {
      if (entry.handle === fileHandle) {
        fileIndex.set(path, { handle: fileHandle, content: newContent })
        break
      }
    }
    return true
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

        // Update the src in source files
        if (currentSrc !== newSrc) {
          const results = searchFiles(currentSrc)
          if (results.length > 0) {
            const target = results.length === 1
              ? results[0]
              : await pickFromResults(results, currentSrc)

            if (target) {
              await writeFile(target.handle, target.content, currentSrc, newSrc)
            }
          }
        }

        // Update preview immediately
        imgEl.src = URL.createObjectURL(file)
        editCount++
        updateToolbar()
        toast(`Image replaced → ${newFileName}`, 'success')
      } catch (err) {
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
    el.focus()

    // Select all text for convenience
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
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
      el.innerText = originalText
      activeElement = null
      return
    }

    // Search for the original text in source files
    // Try the raw text first, then try with common HTML patterns
    let results = searchFiles(originalText.trim())

    // If not found, try searching for just the first line (handles multi-line)
    if (results.length === 0) {
      const firstLine = originalText.trim().split('\n')[0].trim()
      if (firstLine.length > 10) {
        results = searchFiles(firstLine)
      }
    }

    if (results.length === 0) {
      toast('Could not find text in source files', 'error')
      el.innerText = originalText
      activeElement = null
      return
    }

    let target
    if (results.length === 1) {
      target = results[0]
    } else {
      target = await pickFromResults(results, originalText.trim())
    }

    if (!target) {
      el.innerText = originalText
      activeElement = null
      return
    }

    try {
      const success = await writeFile(
        target.handle,
        target.content,
        originalText.trim(),
        newText.trim()
      )

      if (success) {
        editCount++
        updateToolbar()
        toast(`Saved → ${target.path}`, 'success')
      } else {
        toast('No changes detected in file', 'error')
        el.innerText = originalText
      }
    } catch (err) {
      toast(`Write failed: ${err.message}`, 'error')
      el.innerText = originalText
    }

    activeElement = null
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
    if (!activeElement) return

    // Escape cancels editing
    if (e.key === 'Escape') {
      activeElement.innerText = originalText
      activeElement.removeAttribute('contenteditable')
      activeElement.removeAttribute('data-wh-editing')
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
      <button id="wh-btn-folder">Open Folder</button>
      <button id="wh-btn-edit">Edit Mode</button>
      <span class="wh-status" id="wh-status">No folder selected</span>
    `
    document.body.appendChild(bar)

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
  }

  function updateToolbar() {
    const dot = document.getElementById('wh-dot')
    const status = document.getElementById('wh-status')
    const editBtn = document.getElementById('wh-btn-edit')
    const folderBtn = document.getElementById('wh-btn-folder')

    if (!dot) return

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

  function init() {
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
  }

  // Run
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
