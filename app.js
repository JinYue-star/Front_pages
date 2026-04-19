/**
 * 文档问答前端：侧栏 + 聊天历史 + 异步问答 + 测验子页生成
 * 优化版：增强用户体验，添加新功能
 *
 * 后端开启访问令牌时：在控制台执行
 *   localStorage.setItem('RAG_ACCESS_TOKEN', '与服务器 RAG_ACCESS_TOKEN 相同的字符串')
 * 然后刷新页面。未设置时请求不会带 Authorization（需服务端 RAG_REQUIRE_ACCESS_TOKEN=0）。
 */

const isGitHubPages = window.location.hostname.endsWith('github.io');

/** 与 uvicorn 同端口打开页面时用当前 origin；Live Server 等独立端口仍默认连本机 :8000 */
function resolveDefaultApiBase() {
    if (isGitHubPages) {
        return 'https://kitty-collapse-ivory-vol.trycloudflare.com';
    }
    if (window.location.protocol === 'file:') {
        return 'http://127.0.0.1:8000';
    }
    const port = window.location.port;
    const devFrontendPorts = new Set(['5500', '5501', '3000', '5173', '4173', '8080']);
    if (port && devFrontendPorts.has(port)) {
        return `${window.location.protocol}//${window.location.hostname}:8000`;
    }
    return window.location.origin;
}

const DEFAULT_API_BASE = resolveDefaultApiBase();
const storedApiBase = localStorage.getItem('RAG_API_BASE');
const staleApiBases = new Set([
    'http://35.77.38.184:8000',
    'http://35.77.38.184:8001',
    'https://kitty-collapse-ivory-vol.trycloudflare.com'
]);
const runtimeApiBase =
    window.__API_BASE__ ||
    (storedApiBase && !staleApiBases.has(storedApiBase) ? storedApiBase : DEFAULT_API_BASE);
const normalizedApiBase = String(runtimeApiBase).replace(/\/+$/, '');

const CONFIG = {
    API_BASE: normalizedApiBase,
    API_HEALTH: '/health',
    API_SESSIONS: '/api/v1/sessions',
    SESSION_ID_KEY: 'RAG_SESSION_ID',
    SESSION_SECRET_KEY: 'RAG_SESSION_SECRET',
    LAST_QUIZ_KEY: 'RAG_LAST_QUIZ',
    ALLOWED_TYPES: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/msword',
        'text/plain',
        'text/markdown',
        'text/html',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.ms-powerpoint',
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/gif',
        'image/bmp',
        'image/tiff'
    ],
    MAX_FILES: 5,
    POLL_MS: 450
};

const state = {
    serverFiles: [],
    isLoading: false,
    isUploading: false,
    chatMutating: false,
    messages: []
};

const elements = {
    uploadZone: document.getElementById('uploadZone'),
    fileInput: document.getElementById('fileInput'),
    fileList: document.getElementById('fileList'),
    questionInput: document.getElementById('questionInput'),
    topKSelect: document.getElementById('topKSelect'),
    submitBtn: document.getElementById('submitBtn'),
    chatMessages: document.getElementById('chatMessages'),
    clearChatBtn: document.getElementById('clearChatBtn'),
    generateBar: document.getElementById('generateBar'),
    generateQuizBtn: document.getElementById('generateQuizBtn'),
    resultSection: document.getElementById('resultSection'),
    sourcesCard: document.getElementById('sourcesCard'),
    sourcesBody: document.getElementById('sourcesBody'),
    sourcesList: document.getElementById('sourcesList'),
    sourcesCount: document.getElementById('sourcesCount'),
    toggleSources: document.getElementById('toggleSources'),
    kbNotice: document.getElementById('kbNotice'),
    toast: document.getElementById('toast')
};

function showToast(message, isError = false, isSuccess = false) {
    const toast = elements.toast;
    const messageEl = toast.querySelector('.toast-message');
    messageEl.textContent = message;
    
    // 重置样式
    toast.className = 'toast';
    
    if (isError) {
        toast.classList.add('error');
    } else if (isSuccess) {
        toast.classList.add('success');
    }
    
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3500);
}

function getSessionId() {
    return (localStorage.getItem(CONFIG.SESSION_ID_KEY) || '').trim();
}

function getSessionSecret() {
    return (localStorage.getItem(CONFIG.SESSION_SECRET_KEY) || '').trim();
}

function clearSession() {
    localStorage.removeItem(CONFIG.SESSION_ID_KEY);
    localStorage.removeItem(CONFIG.SESSION_SECRET_KEY);
    state.messages = [];
    renderChat();
}

function authHeaders() {
    const h = {};
    const access = (localStorage.getItem('RAG_ACCESS_TOKEN') || '').trim();
    if (access) {
        h['Authorization'] = `Bearer ${access}`;
    }
    const sec = getSessionSecret();
    if (sec) {
        h['X-Session-Secret'] = sec;
    }
    return h;
}

async function getErrorMessage(response) {
    try {
        const data = await response.json();
        if (data && typeof data.detail === 'string' && data.detail.trim()) {
            return data.detail;
        }
    } catch (_) {
        /* ignore */
    }
    try {
        const text = await response.text();
        if (text.trim()) {
            return text;
        }
    } catch (_) {
        /* ignore */
    }
    return `请求失败 (${response.status})`;
}

async function ensureSession() {
    if (getSessionId() && getSessionSecret()) {
        const check = await fetch(
            `${CONFIG.API_BASE}${CONFIG.API_SESSIONS}/${encodeURIComponent(getSessionId())}/files`,
            { headers: authHeaders() }
        );
        if (check.ok) {
            return;
        }
        if (check.status === 401) {
            throw new Error('访问令牌无效');
        }
        clearSession();
    }
    const res = await fetch(`${CONFIG.API_BASE}${CONFIG.API_SESSIONS}`, {
        method: 'POST',
        headers: authHeaders()
    });
    if (!res.ok) {
        throw new Error(await getErrorMessage(res));
    }
    const data = await res.json();
    localStorage.setItem(CONFIG.SESSION_ID_KEY, data.session_id);
    localStorage.setItem(CONFIG.SESSION_SECRET_KEY, data.session_secret);
}

async function refreshServerFiles() {
    if (!getSessionId() || !getSessionSecret()) {
        state.serverFiles = [];
        updateFileList();
        return;
    }
    const res = await fetch(
        `${CONFIG.API_BASE}${CONFIG.API_SESSIONS}/${encodeURIComponent(getSessionId())}/files`,
        { headers: authHeaders() }
    );
    if (!res.ok) {
        if (res.status === 403 || res.status === 404) {
            clearSession();
        }
        state.serverFiles = [];
        updateFileList();
        return;
    }
    state.serverFiles = await res.json();
    updateFileList();
}

async function loadChatMessages() {
    if (!getSessionId() || !getSessionSecret()) {
        state.messages = [];
        renderChat();
        return;
    }
    const res = await fetch(
        `${CONFIG.API_BASE}${CONFIG.API_SESSIONS}/${encodeURIComponent(getSessionId())}/messages`,
        { headers: authHeaders() }
    );
    if (!res.ok) {
        state.messages = [];
        renderChat();
        return;
    }
    state.messages = await res.json();
    renderChat();
}

async function deleteChatMessage(messageId) {
    if (!messageId || !getSessionId() || !getSessionSecret()) {
        return;
    }
    state.chatMutating = true;
    updateClearChatButton();
    updateGenerateButtonState();
    updateSubmitButton();
    try {
        const res = await fetch(
            `${CONFIG.API_BASE}${CONFIG.API_SESSIONS}/${encodeURIComponent(getSessionId())}/messages/${encodeURIComponent(messageId)}`,
            { method: 'DELETE', headers: authHeaders() }
        );
        if (!res.ok) {
            throw new Error(await getErrorMessage(res));
        }
        await loadChatMessages();
        showToast('已删除消息', false, true);
    } catch (err) {
        console.error(err);
        showToast(err.message || '删除失败', true);
    } finally {
        state.chatMutating = false;
        updateClearChatButton();
        updateGenerateButtonState();
        updateSubmitButton();
    }
}

async function clearAllChatMessages() {
    if (!getSessionId() || !getSessionSecret() || state.messages.length === 0) {
        return;
    }
    if (!window.confirm('确定清空本会话的全部聊天记录？此操作不可恢复。')) {
        return;
    }
    state.chatMutating = true;
    updateClearChatButton();
    updateGenerateButtonState();
    updateSubmitButton();
    try {
        const res = await fetch(
            `${CONFIG.API_BASE}${CONFIG.API_SESSIONS}/${encodeURIComponent(getSessionId())}/messages`,
            { method: 'DELETE', headers: authHeaders() }
        );
        if (!res.ok) {
            throw new Error(await getErrorMessage(res));
        }
        await loadChatMessages();
        showToast('已清空聊天记录', false, true);
    } catch (err) {
        console.error(err);
        showToast(err.message || '清空失败', true);
    } finally {
        state.chatMutating = false;
        updateClearChatButton();
        updateGenerateButtonState();
        updateSubmitButton();
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function getFileExtension(filename) {
    return filename.split('.').pop().toLowerCase();
}

function getFileIcon(filename) {
    const ext = getFileExtension(filename);
    const icons = {
        pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10,9 9,9 8,9"/></svg>',
        docx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><path d="M8 12h8"/><path d="M8 16h8"/><path d="M16 10v4"/></svg>',
        doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><path d="M8 12h8"/><path d="M8 16h8"/><path d="M16 10v4"/></svg>',
        txt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="14" y2="9"/></svg>',
        md: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><path d="M9 13h6"/><path d="M9 17h6"/><circle cx="12" cy="9" r="2"/></svg>',
        xlsx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><path d="M16 13v-1a2 2 0 0 0-2-2H9m5 4v-1a2 2 0 0 0-2-2H9m0 5h6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="16" y2="16"/></svg>',
        xls: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><path d="M16 13v-1a2 2 0 0 0-2-2H9m5 4v-1a2 2 0 0 0-2-2H9m0 5h6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="16" y2="16"/></svg>',
        pptx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><rect x="8" y="12" width="8" height="3" rx="1"/><path d="M8 12H9a2 2 0 0 1 2 2v3H8z"/><path d="M16 12h1a2 2 0 0 1 2 2v3h-4z"/></svg>',
        ppt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><rect x="8" y="12" width="8" height="3" rx="1"/><path d="M8 12H9a2 2 0 0 1 2 2v3H8z"/><path d="M16 12h1a2 2 0 0 1 2 2v3h-4z"/></svg>',
        png: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5"/></svg>',
        jpg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5"/></svg>',
        jpeg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5"/></svg>',
        webp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5"/><path d="M12 12v8"/><path d="M12 12h8"/></svg>',
        bmp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5"/><rect x="12" y="12" width="8" height="8" rx="1"/></svg>',
        gif: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5"/><path d="M16 12v4h-4"/><path d="M16 16h-4"/></svg>',
        tiff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5"/><path d="M12 16h8"/><path d="M16 12v4"/></svg>'
    };
    return icons[ext] || icons.txt;
}

function isValidFile(file) {
    const validExtensions = [
        'pdf',
        'docx',
        'doc',
        'txt',
        'md',
        'html',
        'xlsx',
        'xls',
        'pptx',
        'ppt',
        'png',
        'jpg',
        'jpeg',
        'webp',
        'bmp',
        'gif',
        'tif',
        'tiff'
    ];
    return validExtensions.includes(getFileExtension(file.name));
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function updateFileList() {
    elements.fileList.innerHTML = '';
    
    if (state.serverFiles.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'file-item empty-state';
        emptyState.style.justifyContent = 'center';
        emptyState.style.color = 'var(--color-gray-400)';
        emptyState.style.background = 'transparent';
        emptyState.style.border = 'none';
        emptyState.style.boxShadow = 'none';
        emptyState.textContent = '暂无上传文件';
        elements.fileList.appendChild(emptyState);
        return;
    }
    
    state.serverFiles.forEach((file) => {
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';
        fileItem.innerHTML = `
            <span class="file-icon">${getFileIcon(file.original_name)}</span>
            <span class="file-name" title="${file.original_name}">${file.original_name}</span>
            <span class="file-size">${formatBytes(file.size_bytes)}</span>
            <button type="button" class="remove-btn" data-file-id="${file.id}" title="删除文件">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        `;
        elements.fileList.appendChild(fileItem);
    });
    elements.fileList.querySelectorAll('.remove-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteServerFile(btn.dataset.fileId);
        });
    });
    updateSubmitButton();
}

function updateClearChatButton() {
    if (!elements.clearChatBtn) return;
    elements.clearChatBtn.disabled =
        !getSessionId() ||
        !getSessionSecret() ||
        state.messages.length === 0 ||
        state.isLoading ||
        state.isUploading ||
        state.chatMutating;
}

function renderChat() {
    if (state.messages.length === 0) {
        elements.chatMessages.innerHTML = `
            <div class="chat-msg chat-msg--assistant">
                <div class="chat-msg-inner">
                    <div class="chat-bubble">
                        你好！请先上传文档，然后我可以回答你关于文档内容的问题。
                        <br><br>
                        <strong>支持功能：</strong>
                        <ul>
                            <li>📄 多格式文档上传</li>
                            <li>❓ 基于文档内容的问答</li>
                            <li>🔍 可配置检索片段数量</li>
                            <li>📝 根据对话生成练习题</li>
                            <li>📚 查看引用的文档片段</li>
                        </ul>
                    </div>
                </div>
            </div>
        `;
        updateGenerateButtonState();
        updateClearChatButton();
        return;
    }
    
    elements.chatMessages.innerHTML = '';
    const frag = document.createDocumentFragment();

    state.messages.forEach((m) => {
        const row = document.createElement('div');
        row.className = `chat-msg chat-msg--${m.role}`;
        row.dataset.messageId = m.id;

        const inner = document.createElement('div');
        inner.className = 'chat-msg-inner';

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        bubble.textContent = m.content || '';
        inner.appendChild(bubble);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'chat-msg-delete';
        delBtn.title = '删除本条消息';
        delBtn.setAttribute('aria-label', '删除本条消息');
        delBtn.dataset.messageId = m.id;
        delBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
        inner.appendChild(delBtn);
        row.appendChild(inner);

        if (m.role === 'assistant') {
            const pick = document.createElement('label');
            pick.className = 'quiz-pick';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'quiz-pick-cb';
            cb.dataset.messageId = m.id;
            cb.checked = false;
            pick.appendChild(cb);
            pick.appendChild(document.createTextNode(' 纳入本次出题'));
            const countInput = document.createElement('input');
            countInput.type = 'number';
            countInput.className = 'quiz-count-input';
            countInput.min = '1';
            countInput.max = '20';
            countInput.value = '1';
            countInput.title = '本段生成题目数量';
            pick.appendChild(document.createTextNode(' 出题数 '));
            pick.appendChild(countInput);
            row.appendChild(pick);
        }

        frag.appendChild(row);
    });

    elements.chatMessages.appendChild(frag);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    updateGenerateButtonState();
    updateClearChatButton();

    elements.chatMessages.querySelectorAll('.chat-msg-delete').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteChatMessage(btn.dataset.messageId);
        });
    });

    elements.chatMessages.querySelectorAll('.quiz-pick-cb').forEach((cb) => {
        cb.addEventListener('change', updateGenerateButtonState);
    });
    elements.chatMessages.querySelectorAll('.quiz-count-input').forEach((inp) => {
        inp.addEventListener('input', updateGenerateButtonState);
        inp.addEventListener('change', updateGenerateButtonState);
    });
}

function updateGenerateButtonState() {
    const anyAssistant = state.messages.some((m) => m.role === 'assistant');
    const checked = elements.chatMessages.querySelectorAll('.quiz-pick-cb:checked');
    elements.generateQuizBtn.disabled =
        !anyAssistant || checked.length === 0 || state.isLoading || state.chatMutating;
}

function renderSourcesFromResult(data) {
    elements.kbNotice.style.display = 'none';
    elements.kbNotice.textContent = '';
    elements.sourcesList.innerHTML = '';
    elements.sourcesCard.style.display = '';

    if (data.no_kb_notice) {
        elements.kbNotice.style.display = '';
        elements.kbNotice.textContent = data.no_kb_notice;
    }

    const hits = data.hits || [];
    if (hits.length > 0) {
        elements.sourcesCount.textContent = `(${hits.length})`;
        hits.forEach((hit, index) => {
            const sourceItem = document.createElement('div');
            sourceItem.className = 'source-item';
            sourceItem.style.animationDelay = `${index * 80}ms`;
            sourceItem.innerHTML = `
                <div class="source-meta">
                    <span class="source-score">${(hit.score * 100).toFixed(1)}%</span>
                    <span class="source-page">${hit.page_label || hit.source || '未知来源'}</span>
                </div>
                <div class="source-content">${hit.content || hit.meta || ''}</div>
            `;
            elements.sourcesList.appendChild(sourceItem);
        });
        elements.sourcesCard.classList.remove('collapsed');
    } else {
        elements.sourcesCount.textContent = '';
    }
}

async function pollQaJob(jobId) {
    const sid = getSessionId();
    const url = `${CONFIG.API_BASE}${CONFIG.API_SESSIONS}/${encodeURIComponent(sid)}/qa/jobs/${encodeURIComponent(jobId)}`;
    for (;;) {
        const res = await fetch(url, { headers: authHeaders() });
        if (!res.ok) {
            throw new Error(await getErrorMessage(res));
        }
        const j = await res.json();
        if (j.status === 'done') {
            return j;
        }
        if (j.status === 'error') {
            throw new Error(j.detail || '问答失败');
        }
        await sleep(CONFIG.POLL_MS);
    }
}

async function submitQuestion() {
    const question = elements.questionInput.value.trim();
    if (!question) {
        showToast('请输入问题', true);
        return;
    }
    if (state.serverFiles.length === 0) {
        showToast('请先上传文档', true);
        return;
    }

    state.isLoading = true;
    elements.submitBtn.classList.add('loading');
    elements.submitBtn.disabled = true;
    updateGenerateButtonState();

    // 添加用户消息到界面
    const userMessage = {
        id: 'temp-' + Date.now(),
        role: 'user',
        content: question
    };
    const tempMessages = [...state.messages, userMessage];
    state.messages = tempMessages;
    renderChat();

    try {
        await ensureSession();

        const formData = new FormData();
        formData.append('question', question);
        formData.append('top_k', parseInt(elements.topKSelect.value, 10));

        const start = await fetch(
            `${CONFIG.API_BASE}${CONFIG.API_SESSIONS}/${encodeURIComponent(getSessionId())}/qa/async`,
            { method: 'POST', headers: authHeaders(), body: formData }
        );
        if (!start.ok) {
            throw new Error(await getErrorMessage(start));
        }
        const { job_id: jobId } = await start.json();
        const job = await pollQaJob(jobId);
        const result = job.result;
        if (!result) {
            throw new Error('未收到回答内容');
        }

        renderSourcesFromResult(result);
        elements.resultSection.classList.add('show');
        await loadChatMessages();

        const lastAssistant = [...state.messages].reverse().find((m) => m.role === 'assistant');
        if (lastAssistant) {
            const el = elements.chatMessages.querySelector(
                `.quiz-pick-cb[data-message-id="${lastAssistant.id}"]`
            );
            if (el) {
                el.checked = true;
            }
        }
        updateGenerateButtonState();

        elements.questionInput.value = '';
        showToast('已回答', false, true);
    } catch (err) {
        console.error(err);
        showToast(err.message || '请求失败', true);
        // 移除临时消息
        state.messages = state.messages.filter(m => !m.id.startsWith('temp-'));
        renderChat();
    } finally {
        state.isLoading = false;
        elements.submitBtn.classList.remove('loading');
        updateSubmitButton();
    }
}

async function generateQuizNavigate() {
    const checked = Array.from(elements.chatMessages.querySelectorAll('.quiz-pick-cb:checked'));
    if (checked.length === 0) {
        showToast('请勾选至少一条助手消息', true);
        return;
    }
    const segments = checked.map((cb) => {
        const row = cb.closest('.chat-msg');
        const num = row && row.querySelector('.quiz-count-input');
        let c = parseInt(num && num.value, 10);
        if (!Number.isFinite(c) || c < 1) c = 1;
        if (c > 20) c = 20;
        return { message_id: cb.dataset.messageId, count: c };
    });

    elements.generateQuizBtn.disabled = true;
    elements.generateQuizBtn.innerHTML = '<span class="btn-loading"><svg class="spinner" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="60" stroke-linecap="round"/></svg></span>';
    
    try {
        await ensureSession();
        const res = await fetch(
            `${CONFIG.API_BASE}${CONFIG.API_SESSIONS}/${encodeURIComponent(getSessionId())}/quiz/generate`,
            {
                method: 'POST',
                headers: {
                    ...authHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ segments })
            }
        );
        if (!res.ok) {
            throw new Error(await getErrorMessage(res));
        }
        const data = await res.json();
        sessionStorage.setItem(
            CONFIG.LAST_QUIZ_KEY,
            JSON.stringify({ quiz_id: data.quiz_id, items: data.items })
        );
        window.location.href = 'quiz.html';
    } catch (err) {
        console.error(err);
        showToast(err.message || '生成失败', true);
    } finally {
        elements.generateQuizBtn.innerHTML = '<span class="btn-text">🚀 生成测验</span>';
        updateGenerateButtonState();
    }
}

async function addFiles(fileList) {
    const fileArray = Array.from(fileList);
    const validFiles = fileArray.filter(isValidFile);
    
    if (fileArray.length - validFiles.length > 0) {
        showToast('部分文件类型不支持，已跳过', false, false);
    }
    if (validFiles.length === 0) {
        return;
    }
    if (state.serverFiles.length + validFiles.length > CONFIG.MAX_FILES) {
        showToast(`最多支持 ${CONFIG.MAX_FILES} 个文件`, true);
        return;
    }

    state.isUploading = true;
    updateSubmitButton();
    
    // 添加临时文件显示
    const tempFiles = validFiles.map(file => ({
        id: 'temp-' + Date.now() + Math.random(),
        original_name: file.name,
        size_bytes: file.size
    }));
    const tempServerFiles = [...state.serverFiles, ...tempFiles];
    state.serverFiles = tempServerFiles;
    updateFileList();

    try {
        await ensureSession();
        const formData = new FormData();
        validFiles.forEach((f) => formData.append('files', f));
        const res = await fetch(
            `${CONFIG.API_BASE}${CONFIG.API_SESSIONS}/${encodeURIComponent(getSessionId())}/files`,
            { method: 'POST', headers: authHeaders(), body: formData }
        );
        if (!res.ok) {
            throw new Error(await getErrorMessage(res));
        }
        await refreshServerFiles();
        showToast('已上传成功', false, true);
    } catch (err) {
        console.error(err);
        showToast(err.message || '上传失败', true);
        // 恢复原始文件列表
        await refreshServerFiles();
    } finally {
        state.isUploading = false;
        updateSubmitButton();
    }
}

async function deleteServerFile(fileId) {
    if (!fileId) {
        return;
    }
    if (!getSessionId() || !getSessionSecret()) {
        showToast('会话无效', true);
        return;
    }
    state.isUploading = true;
    updateSubmitButton();
    try {
        const res = await fetch(
            `${CONFIG.API_BASE}${CONFIG.API_SESSIONS}/${encodeURIComponent(getSessionId())}/files/${encodeURIComponent(fileId)}`,
            { method: 'DELETE', headers: authHeaders() }
        );
        if (!res.ok) {
            throw new Error(await getErrorMessage(res));
        }
        await refreshServerFiles();
        showToast('已删除文件', false, true);
    } catch (err) {
        console.error(err);
        showToast(err.message || '删除失败', true);
    } finally {
        state.isUploading = false;
        updateSubmitButton();
    }
}

function updateSubmitButton() {
    const hasFiles = state.serverFiles.length > 0;
    const hasQuestion = elements.questionInput.value.trim().length > 0;
    elements.submitBtn.disabled =
        !hasFiles ||
        !hasQuestion ||
        state.isLoading ||
        state.isUploading ||
        state.chatMutating;
}

function initEventListeners() {
    // 文件上传事件
    elements.uploadZone.addEventListener('click', () => {
        if (!state.isLoading && !state.isUploading) {
            elements.fileInput.click();
        }
    });
    elements.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            addFiles(e.target.files);
            e.target.value = '';
        }
    });
    elements.uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!state.isLoading && !state.isUploading) {
            elements.uploadZone.classList.add('dragover');
        }
    });
    elements.uploadZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        elements.uploadZone.classList.remove('dragover');
    });
    elements.uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.uploadZone.classList.remove('dragover');
        if (!state.isLoading && !state.isUploading && e.dataTransfer.files.length > 0) {
            addFiles(e.dataTransfer.files);
        }
    });

    // 问题提交事件
    elements.questionInput.addEventListener('input', updateSubmitButton);
    elements.questionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !elements.submitBtn.disabled) {
            e.preventDefault();
            submitQuestion();
        }
    });
    elements.submitBtn.addEventListener('click', submitQuestion);
    elements.generateQuizBtn.addEventListener('click', generateQuizNavigate);
    
    if (elements.clearChatBtn) {
        elements.clearChatBtn.addEventListener('click', clearAllChatMessages);
    }
    
    elements.toggleSources.addEventListener('click', () => {
        elements.sourcesCard.classList.toggle('collapsed');
        const ex = !elements.sourcesCard.classList.contains('collapsed');
        elements.toggleSources.setAttribute('aria-expanded', ex ? 'true' : 'false');
    });
    
    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
        // Ctrl/Cmd + Enter 发送消息
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !elements.submitBtn.disabled) {
            e.preventDefault();
            submitQuestion();
        }
        // Ctrl/Cmd + L 清空聊天
        if ((e.ctrlKey || e.metaKey) && e.key === 'l' && !elements.clearChatBtn.disabled) {
            e.preventDefault();
            clearAllChatMessages();
        }
    });
}

// 检查API健康状态
async function checkApiHealth() {
    try {
        const res = await fetch(`${CONFIG.API_BASE}${CONFIG.API_HEALTH}`);
        if (!res.ok) {
            showToast('API服务可能不可用', true);
        }
    } catch (err) {
        console.warn('API健康检查失败:', err);
    }
}

function init() {
    initEventListeners();
    updateSubmitButton();
    
    // 初始化时检查API健康
    checkApiHealth().catch(() => {});
    
    refreshServerFiles()
        .then(() => loadChatMessages())
        .catch(() => {});
    
    console.log('📚 智能文档问答已加载');
    console.log('API:', CONFIG.API_BASE);
}

document.addEventListener('DOMContentLoaded', init);