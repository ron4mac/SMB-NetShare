'use strict';

// ── STATE ──────────────────────────────────────────────────────────────────
const state = {
	sessionId: null,
	currentShare: null,
	shareConfig: null,
	path: [],
	pathHistory: [],
	entries: [],
	view: 'list',
	selected: new Set(),
	sortKey: 'name',
	sortAsc: true,
	filter: '',
	loading: false,
	knownShares: [],
	recentFiles: [],
};

// ── API HELPERS ────────────────────────────────────────────────────────────
const apiBase = () => document.getElementById('backendUrl').value.replace(/\/$/, '');

async function apiFetch(path, opts = {}) {
	const res = await fetch(apiBase() + path, {
		headers: {
			'Content-Type': 'application/json',
			...(opts.headers || {})
		},
		...opts,
	});
	const ct = res.headers.get('content-type') || '';
	const body = ct.includes('application/json') ? await res.json() : null;
	if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
	return body;
}

// ── HEALTH CHECK ───────────────────────────────────────────────────────────
async function checkHealth() {
	const el = document.getElementById('backendStatus');
	el.textContent = 'checking…';
	el.style.color = 'var(--yellow)';
	try {
		const d = await apiFetch('/api/health');
		const extra = d.php ? ` · PHP ${d.php}` : '';
		const smb = d.smbclient === false ? ' ⚠ smbclient missing' : '';
		el.textContent = `✓ online · ${d.sessions} session(s)${extra}${smb}`;
		el.style.color = d.smbclient === false ? 'var(--yellow)' : 'var(--green)';
	} catch (e) {
		el.textContent = `✗ ${e.message}`;
		el.style.color = 'var(--red)';
	}
}

// ── CONNECT ────────────────────────────────────────────────────────────────
async function doConnect() {
	const host = document.getElementById('m_host').value.trim();
	const port = document.getElementById('m_port').value.trim() || '445';
	const share = document.getElementById('m_share').value.trim();
	const user = document.getElementById('m_user').value.trim() || 'guest';
	const pass = document.getElementById('m_pass').value;
	const domain = document.getElementById('m_domain').value.trim() || 'WORKGROUP';

	const errEl = document.getElementById('connectError');
	errEl.classList.remove('show');

	if (!host || !share) {
		errEl.textContent = 'Host and Share Name are required.';
		errEl.classList.add('show');
		return;
	}

	const btn = document.getElementById('connectBtn');
	btn.disabled = true;
	btn.textContent = 'Connecting…';
	document.getElementById('connectProgress').style.display = 'block';

	let pct = 0;
	const ticker = setInterval(() => {
		pct = Math.min(pct + Math.random() * 18, 85);
		document.getElementById('connectFill').style.width = pct + '%';
	}, 200);

	try {
		const data = await apiFetch('/api/connect', {
			method: 'POST',
			body: JSON.stringify({
				host,
				port: Number(port),
				share,
				username: user,
				password: pass,
				domain
			}),
		});

		clearInterval(ticker);
		document.getElementById('connectFill').style.width = '100%';

		state.sessionId = data.sessionId;
		state.currentShare = share;
		state.shareConfig = {
			host,
			share
		};
		state.path = [];
		state.pathHistory = [];
		state.selected.clear();

		if (!state.knownShares.find(s => s.host === host && s.share === share)) {
			state.knownShares.push({
				host,
				share,
				sessionId: data.sessionId
			});
		}

		setConnected(true, `\\\\${host}\\${share}`);
		renderSidebar();
		closeModal('connectModal');
		await loadDirectory();
		notify('success', `Connected to \\\\${host}\\${share}`);
	} catch (e) {
		clearInterval(ticker);
		errEl.textContent = e.message;
		errEl.classList.add('show');
	} finally {
		btn.disabled = false;
		btn.textContent = 'Connect';
		document.getElementById('connectProgress').style.display = 'none';
		document.getElementById('connectFill').style.width = '0%';
	}
}

async function disconnect() {
	if (!state.sessionId) return;
	try {
		await apiFetch(`/api/connect/${state.sessionId}`, {
			method: 'DELETE'
		});
	} catch (_) {}
	state.sessionId = null;
	state.currentShare = null;
	state.shareConfig = null;
	state.path = [];
	state.pathHistory = [];
	state.entries = [];
	state.selected.clear();
	state.knownShares = [];
	setConnected(false);
	renderSidebar();
	renderFiles();
	document.getElementById('statItems').textContent = '—';
	document.getElementById('statSelected').textContent = 'nothing selected';
	notify('info', 'Disconnected.');
}

function setConnected(on, label = '') {
	document.getElementById('statusDot').className = 'status-dot ' + (on ? 'connected' : '');
	document.getElementById('hostDisplay').value = on ? label : '';
	document.getElementById('statServer').textContent = on ? label : 'offline';
	['topNewFolderBtn', 'topUploadBtn', 'topDisconnectBtn', 'newFolderBtn', 'uploadBtn', 'refreshBtn']
	.forEach(id => {
		document.getElementById(id).disabled = !on;
	});
}

// ── DIRECTORY LOADING ──────────────────────────────────────────────────────
const currentPathStr = () => state.path.join('/');

async function loadDirectory() {
	if (!state.sessionId) return;
	state.loading = true;
	state.selected.clear();
	renderFiles();

	try {
		const data = await apiFetch(
			`/api/files/${state.sessionId}?path=${encodeURIComponent(currentPathStr())}`
		);
		state.entries = data.entries || [];
		state.loading = false;
		renderFiles();
		updateStatus();
	} catch (e) {
		state.loading = false;
		document.getElementById('fileContainer').innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <h3>Error Loading Directory</h3>
        <p>${e.message}</p>
        <button class="btn sm" onclick="loadDirectory()" style="margin-top:6px">Retry</button>
      </div>`;
		notify('error', e.message);
	}
}

async function refreshDir() {
	document.getElementById('statusDot').className = 'status-dot connecting';
	await loadDirectory();
	if (state.sessionId) document.getElementById('statusDot').className = 'status-dot connected';
}

// ── NAVIGATION ─────────────────────────────────────────────────────────────
async function openFolder(name) {
	state.pathHistory.push([...state.path]);
	state.path.push(name);
	await loadDirectory();
}

async function navigateBack() {
	if (state.path.length > 0) {
		state.pathHistory.push([...state.path]);
		state.path.pop();
		await loadDirectory();
	}
}

async function navBreadcrumb(idx) {
	state.pathHistory.push([...state.path]);
	state.path = idx === -1 ? [] : state.path.slice(0, idx + 1);
	await loadDirectory();
}

async function navToShareEntry(i) {
	const entry = state.knownShares[i];
	if (!entry) return;
	state.sessionId = entry.sessionId;
	state.currentShare = entry.share;
	state.shareConfig = {
		host: entry.host,
		share: entry.share
	};
	state.path = [];
	state.pathHistory = [];
	setConnected(true, `\\\\${entry.host}\\${entry.share}`);
	renderSidebar();
	await loadDirectory();
}

// ── SIDEBAR ────────────────────────────────────────────────────────────────
function renderSidebar() {
	const list = document.getElementById('shareList');
	if (!state.knownShares.length) {
		list.innerHTML = `<div style="padding:16px;font-size:11px;color:var(--text-muted);font-family:var(--mono)">Connect to see shares</div>`;
		return;
	}
	list.innerHTML = state.knownShares.map((s, i) => `
    <div class="sidebar-item ${s.share === state.currentShare && s.host === state.shareConfig?.host ? 'active' : ''}"
         onclick="navToShareEntry(${i})">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.share}</span>
      <span style="margin-left:auto;font-family:var(--mono);font-size:9px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0">${s.host}</span>
    </div>`).join('');
}

// ── RENDER FILES ───────────────────────────────────────────────────────────
function getFiltered() {
	let entries = [...state.entries];
	if (state.filter) {
		const f = state.filter.toLowerCase();
		entries = entries.filter(e => e.name.toLowerCase().includes(f));
	}
	const folders = entries.filter(e => e.type === 'folder');
	const files = entries.filter(e => e.type !== 'folder');
	const cmp = (a, b) => {
		let av = a[state.sortKey] ?? '',
			bv = b[state.sortKey] ?? '';
		if (state.sortKey === 'size') {
			av = av || 0;
			bv = bv || 0;
		}
		if (av < bv) return state.sortAsc ? -1 : 1;
		if (av > bv) return state.sortAsc ? 1 : -1;
		return 0;
	};
	return [...folders.sort(cmp), ...files.sort(cmp)];
}

function renderFiles() {
	const container = document.getElementById('fileContainer');
	const listHeader = document.getElementById('listHeader');

	// Breadcrumb
	const bc = document.getElementById('breadcrumb');
	if (!state.sessionId) {
		bc.innerHTML = `<span style="color:var(--text-muted)">No share selected</span>`;
	} else {
		let html = `<span class="breadcrumb-item" onclick="navBreadcrumb(-1)">${state.currentShare}</span>`;
		state.path.forEach((seg, i) => {
			html += `<span class="breadcrumb-sep">›</span>`;
			html += i < state.path.length - 1 ?
				`<span class="breadcrumb-item" onclick="navBreadcrumb(${i})">${seg}</span>` :
				`<span class="breadcrumb-item current">${seg}</span>`;
		});
		bc.innerHTML = html;
	}

	document.getElementById('backBtn').disabled = state.path.length === 0;

	if (state.loading) {
		listHeader.style.display = 'none';
		container.innerHTML = `<div class="empty-state"><div class="spinner"></div><p style="margin-top:4px">Loading directory…</p></div>`;
		return;
	}

	const entries = getFiltered();

	if (state.view === 'list') {
		listHeader.style.display = 'grid';
		container.innerHTML = entries.length ? entries.map(fileRowHTML).join('') : emptyHTML();
	} else {
		listHeader.style.display = 'none';
		container.innerHTML = entries.length ?
			`<div class="file-grid">${entries.map(gridItemHTML).join('')}</div>` :
			emptyHTML();
	}
}

const emptyHTML = () => `
  <div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
    <h3>Empty Directory</h3>
    <p>This folder is empty. Upload files or create a folder.</p>
  </div>`;

function fileRowHTML(e) {
	const sel = state.selected.has(e.name);
	const dbl = e.type === 'folder' ? `openFolder('${esc(e.name)}')` : `downloadFile('${esc(e.name)}')`;
	return `<div class="file-row ${e.type === 'folder' ? 'folder' : ''} ${sel ? 'selected' : ''}"
    onclick="selectItem(event,'${esc(e.name)}')" ondblclick="${dbl}"
    oncontextmenu="ctxOnItem(event,'${esc(e.name)}')">
    ${iconSVG(e, 18)}
    <div class="file-name">${e.name}</div>
    <div class="meta">${e.type === 'folder' ? '—' : extBadge(e.ext)}</div>
    <div class="meta">${formatSize(e.size)}</div>
    <div class="meta">${fmtDate(e.modified)}</div>
  </div>`;
}

function gridItemHTML(e) {
	const sel = state.selected.has(e.name);
	const dbl = e.type === 'folder' ? `openFolder('${esc(e.name)}')` : `downloadFile('${esc(e.name)}')`;
	return `<div class="grid-item ${sel ? 'selected' : ''}"
    onclick="selectItem(event,'${esc(e.name)}')" ondblclick="${dbl}"
    oncontextmenu="ctxOnItem(event,'${esc(e.name)}')">
    ${iconSVG(e, 40)}
    <div class="grid-name">${e.name}</div>
  </div>`;
}

function updateStatus() {
	const n = getFiltered().length;
	const sel = state.selected.size;
	document.getElementById('statItems').textContent = n + ' item' + (n !== 1 ? 's' : '');
	document.getElementById('statSelected').textContent = sel > 0 ? sel + ' selected' : 'nothing selected';
	document.getElementById('downloadBtn').disabled = sel === 0;
	document.getElementById('deleteBtn').disabled = sel === 0;
}

// ── ICONS & FORMAT HELPERS ─────────────────────────────────────────────────
const EXT_CLR = {
	mp4: '#ff6b6b',
	mkv: '#ff6b6b',
	avi: '#ff6b6b',
	mov: '#ff6b6b',
	webm: '#ff6b6b',
	mp3: '#a78bfa',
	flac: '#a78bfa',
	m4a: '#a78bfa',
	ogg: '#a78bfa',
	jpg: '#f59e0b',
	jpeg: '#f59e0b',
	png: '#f59e0b',
	gif: '#f59e0b',
	webp: '#f59e0b',
	svg: '#f59e0b',
	pdf: '#ef4444',
	xlsx: '#22c55e',
	xls: '#22c55e',
	csv: '#22c55e',
	docx: '#3b82f6',
	doc: '#3b82f6',
	txt: '#9ca3af',
	md: '#9ca3af',
	log: '#9ca3af',
	zip: '#f97316',
	gz: '#f97316',
	tar: '#f97316',
	rar: '#f97316',
	'7z': '#f97316',
	sh: '#facc15',
	py: '#facc15',
	js: '#facc15',
	ts: '#facc15',
	json: '#facc15',
};

function iconSVG(e, s) {
	if (e.type === 'folder')
		return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="#4a9eff" style="flex-shrink:0"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`;
	const c = EXT_CLR[(e.ext || '').toLowerCase()] || '#6b7280';
	return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.5" style="flex-shrink:0"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}

function extBadge(ext) {
	if (!ext) return '—';
	const fg = EXT_CLR[ext.toLowerCase()] || '#6b7280';
	return `<span class="ext-badge" style="background:${fg}18;color:${fg};border:1px solid ${fg}40">${ext.length > 6 ? ext.slice(0,5)+'…' : ext}</span>`;
}

function formatSize(b) {
	if (b == null) return '—';
	if (b < 1024) return b + ' B';
	if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
	if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
	return (b / 1073741824).toFixed(2) + ' GB';
}

function fmtDate(iso) {
	if (!iso) return '—';
	try {
		return new Date(iso).toLocaleString(undefined, {
			dateStyle: 'short',
			timeStyle: 'short'
		});
	} catch (_) {
		return iso.slice(0, 16).replace('T', ' ');
	}
}

function esc(s) {
	return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ── SELECTION ──────────────────────────────────────────────────────────────
function selectItem(e, name) {
	e.stopPropagation();
	if (e.ctrlKey || e.metaKey) {
		state.selected.has(name) ? state.selected.delete(name) : state.selected.add(name);
	} else if (e.shiftKey && state.selected.size > 0) {
		const names = getFiltered().map(f => f.name);
		const last = [...state.selected].pop();
		const a = names.indexOf(last),
			b = names.indexOf(name);
		const [lo, hi] = a < b ? [a, b] : [b, a];
		names.slice(lo, hi + 1).forEach(n => state.selected.add(n));
	} else {
		state.selected.clear();
		state.selected.add(name);
	}
	renderFiles();
	updateStatus();
}

function clearSelection(e) {
	const t = e.target;
	if (t === e.currentTarget || t.id === 'fileContainer' || t.closest('.file-list-header')) {
		state.selected.clear();
		renderFiles();
		updateStatus();
	}
}

// ── DOWNLOAD ───────────────────────────────────────────────────────────────
function downloadFile(name) {
	if (!state.sessionId) return;
	const filePath = [...state.path, name].join('/');
	const url = `${apiBase()}/api/files/${state.sessionId}/download?path=${encodeURIComponent(filePath)}`;
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	addRecent(name);
	notify('info', `Downloading: ${name}`);
}

function downloadSelected() {
	closeCtxMenu();
	[...state.selected].forEach(name => {
		const entry = state.entries.find(e => e.name === name);
		if (entry?.type !== 'folder') downloadFile(name);
	});
}

// ── DELETE ─────────────────────────────────────────────────────────────────
async function confirmDelete() {
	const items = [...state.selected];
	if (!items.length) return;
	closeCtxMenu();
	if (!confirm(`Delete ${items.length} item(s)? This cannot be undone.`)) return;

	let ok = 0,
		fail = 0;
	for (const name of items) {
		const isFolder = state.entries.find(e => e.name === name)?.type === 'folder';
		const p = [...state.path, name].join('/');
		try {
			await apiFetch(`/api/files/${state.sessionId}`, {
				method: 'DELETE',
				body: JSON.stringify({
					path: p,
					recursive: isFolder
				}),
			});
			ok++;
		} catch (e) {
			fail++;
			notify('error', `Failed to delete ${name}: ${e.message}`);
		}
	}
	if (ok) notify('success', `${ok} item(s) deleted.`);
	state.selected.clear();
	await loadDirectory();
}

// ── RENAME ─────────────────────────────────────────────────────────────────
async function ctxRename() {
	closeCtxMenu();
	const name = [...state.selected][0];
	if (!name) return;
	const newName = prompt(`Rename "${name}" to:`, name);
	if (!newName || newName === name) return;
	const from = [...state.path, name].join('/');
	const to = [...state.path, newName].join('/');
	try {
		await apiFetch(`/api/files/${state.sessionId}/rename`, {
			method: 'PATCH',
			body: JSON.stringify({
				from,
				to
			}),
		});
		notify('success', `Renamed → ${newName}`);
		await loadDirectory();
	} catch (e) {
		notify('error', e.message);
	}
}

// ── NEW FOLDER ─────────────────────────────────────────────────────────────
function openNewFolder() {
	if (!state.sessionId) return;
	document.getElementById('newFolderError').classList.remove('show');
	document.getElementById('newFolderName').value = '';
	openModal('newFolderModal');
	setTimeout(() => document.getElementById('newFolderName').focus(), 120);
}

async function createFolder() {
	const name = document.getElementById('newFolderName').value.trim();
	const errEl = document.getElementById('newFolderError');
	const btn = document.getElementById('mkdirBtn');
	errEl.classList.remove('show');
	if (!name) {
		errEl.textContent = 'Name cannot be empty.';
		errEl.classList.add('show');
		return;
	}

	btn.disabled = true;
	btn.textContent = 'Creating…';
	const dirPath = [...state.path, name].join('/');
	try {
		await apiFetch(`/api/files/${state.sessionId}/mkdir`, {
			method: 'POST',
			body: JSON.stringify({
				path: dirPath
			}),
		});
		closeModal('newFolderModal');
		notify('success', `Folder created: ${name}`);
		await loadDirectory();
	} catch (e) {
		errEl.textContent = e.message;
		errEl.classList.add('show');
	} finally {
		btn.disabled = false;
		btn.textContent = 'Create';
	}
}

// ── UPLOAD ─────────────────────────────────────────────────────────────────
function triggerUpload() {
	if (!state.sessionId) return;
	document.getElementById('fileUploadInput').click();
}

async function handleFileUpload(e) {
	const files = [...e.target.files];
	e.target.value = '';
	if (!files.length || !state.sessionId) return;
	await doUpload(files);
}

async function doUpload(files) {
	const listEl = document.getElementById('uploadList');
	const doneBtn = document.getElementById('uploadDoneBtn');
	doneBtn.disabled = true;
	listEl.innerHTML = files.map((f, i) => `
    <div class="upload-item">
      ${iconSVG({type:'file', ext: f.name.split('.').pop()}, 14)}
      <span class="ui-name">${f.name}</span>
      <span class="ui-status pending" id="upst_${i}">waiting…</span>
    </div>`).join('');
	openModal('uploadModal');

	const form = new FormData();
	files.forEach(f => form.append('files', f));
	files.forEach((_, i) => {
		const s = document.getElementById(`upst_${i}`);
		if (s) {
			s.textContent = 'uploading…';
		}
	});

	try {
		const res = await fetch(
			`${apiBase()}/api/files/${state.sessionId}/upload?path=${encodeURIComponent(currentPathStr())}`, {
				method: 'POST',
				body: form
			}
		);
		const data = await res.json();
		(data.results || []).forEach((r, i) => {
			const s = document.getElementById(`upst_${i}`);
			if (!s) return;
			if (r.status === 'ok') {
				s.textContent = '✓ ' + formatSize(r.size);
				s.className = 'ui-status ok';
			} else {
				s.textContent = '✗ ' + (r.error || 'error');
				s.className = 'ui-status error';
			}
		});
		const ok = (data.results || []).filter(r => r.status === 'ok').length;
		if (ok) notify('success', `${ok} file(s) uploaded.`);
		await loadDirectory();
	} catch (e) {
		files.forEach((_, i) => {
			const s = document.getElementById(`upst_${i}`);
			if (s) {
				s.textContent = '✗ ' + e.message;
				s.className = 'ui-status error';
			}
		});
		notify('error', `Upload failed: ${e.message}`);
	} finally {
		doneBtn.disabled = false;
	}
}

// Drag-and-drop
function dragOver(e) {
	e.preventDefault();
	document.getElementById('dropOverlay').classList.add('active');
}

function dragLeave(e) {
	if (!e.relatedTarget || !document.getElementById('fileArea').contains(e.relatedTarget))
		document.getElementById('dropOverlay').classList.remove('active');
}
async function dropFiles(e) {
	e.preventDefault();
	document.getElementById('dropOverlay').classList.remove('active');
	if (!state.sessionId) {
		notify('error', 'Not connected.');
		return;
	}
	const files = [...e.dataTransfer.files];
	if (files.length) await doUpload(files);
}

// ── SORT & FILTER ──────────────────────────────────────────────────────────
function sortBy(key) {
	if (state.sortKey === key) state.sortAsc = !state.sortAsc;
	else {
		state.sortKey = key;
		state.sortAsc = true;
	}
	document.getElementById('sortLabel').textContent = key.toUpperCase() + ' ' + (state.sortAsc ? '↑' : '↓');
	['colName', 'colExt', 'colSize', 'colModified'].forEach(id => document.getElementById(id)?.classList.remove('sorted'));
	const map = {
		name: 'colName',
		ext: 'colExt',
		size: 'colSize',
		modified: 'colModified'
	};
	document.getElementById(map[key])?.classList.add('sorted');
	renderFiles();
}

function applyFilter() {
	state.filter = document.getElementById('searchInput').value;
	renderFiles();
	updateStatus();
}

function setView(v) {
	state.view = v;
	document.getElementById('listViewBtn').classList.toggle('active', v === 'list');
	document.getElementById('gridViewBtn').classList.toggle('active', v === 'grid');
	renderFiles();
}

// ── RECENT ─────────────────────────────────────────────────────────────────
function addRecent(name) {
	state.recentFiles = [name, ...state.recentFiles.filter(n => n !== name)].slice(0, 6);
	document.getElementById('recentSection').style.display = '';
	document.getElementById('recentList').innerHTML = state.recentFiles.map(n => `
    <div class="sidebar-item" onclick="downloadFile('${esc(n)}')">
      ${iconSVG({type:'file', ext: n.split('.').pop()}, 14)}
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${n}</span>
    </div>`).join('');
}

// ── CONTEXT MENU ───────────────────────────────────────────────────────────
function showCtxMenu(e) {
	if (!state.selected.size) return;
	e.preventDefault();
	const m = document.getElementById('ctxMenu');
	m.style.left = Math.min(e.clientX, window.innerWidth - 175) + 'px';
	m.style.top = Math.min(e.clientY, window.innerHeight - 175) + 'px';
	m.classList.add('open');
}

function ctxOnItem(e, name) {
	e.stopPropagation();
	if (!state.selected.has(name)) {
		state.selected.clear();
		state.selected.add(name);
		renderFiles();
		updateStatus();
	}
	showCtxMenu(e);
}

function closeCtxMenu() {
	document.getElementById('ctxMenu').classList.remove('open');
}
document.addEventListener('click', e => {
	if (!e.target.closest('#ctxMenu')) closeCtxMenu();
});

function ctxOpen() {
	closeCtxMenu();
	const name = [...state.selected][0];
	if (!name) return;
	const entry = state.entries.find(e => e.name === name);
	entry?.type === 'folder' ? openFolder(name) : downloadFile(name);
}

function ctxCopyPath() {
	closeCtxMenu();
	const name = [...state.selected][0] || '';
	const p = `\\\\${state.shareConfig?.host}\\${state.currentShare}\\${[...state.path, name].join('\\')}`;
	navigator.clipboard?.writeText(p).catch(() => {});
	notify('info', 'SMB path copied to clipboard.');
}

// ── MODALS ─────────────────────────────────────────────────────────────────
function openModal(id) {
	document.getElementById(id).classList.add('open');
}

function closeModal(id) {
	document.getElementById(id).classList.remove('open');
}
document.querySelectorAll('.modal-overlay').forEach(m =>
	m.addEventListener('click', e => {
		if (e.target === m) closeModal(m.id);
	})
);

// ── NOTIFICATIONS ──────────────────────────────────────────────────────────
function notify(type, msg) {
	const icons = {
		success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
		error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
		info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
	};
	const n = document.createElement('div');
	n.className = `notif ${type}`;
	n.innerHTML = (icons[type] || '') + `<span>${msg}</span>`;
	document.getElementById('notifs').appendChild(n);
	setTimeout(() => n.remove(), 4000);
}

// ── THEME ───────────────────────────────────────────────────────────────────
function applyTheme(theme) {
	document.documentElement.setAttribute('data-theme', theme);
	try {
		localStorage.setItem('netshare-theme', theme);
	} catch (_) {}
}

function toggleTheme() {
	const current = document.documentElement.getAttribute('data-theme');
	// If not explicitly set, detect from OS preference
	const isDark = current === 'dark' ||
		(!current && !window.matchMedia('(prefers-color-scheme: light)').matches);
	applyTheme(isDark ? 'light' : 'dark');
}

// Restore saved preference on load (before first paint)
(function () {
	try {
		const saved = localStorage.getItem('netshare-theme');
		if (saved === 'dark' || saved === 'light') {
			document.documentElement.setAttribute('data-theme', saved);
		}
	} catch (_) {}
})();

// ── INIT ────────────────────────────────────────────────────────────────────
checkHealth();