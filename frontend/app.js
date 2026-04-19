/**
 * 文档问答前端：侧栏 + 聊天历史 + 异步问答 + 测验子页生成
 *
 * 后端开启访问令牌时：localStorage.setItem('RAG_ACCESS_TOKEN', '与服务器相同');
 * 或服务端设 RAG_REQUIRE_ACCESS_TOKEN=0 关闭校验。
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

function showToast(message, isError = false) {
    elements.toast.querySelector('.toast-message').textContent = message;
    elements.toast.classList.toggle('error', isError);
    elements.toast.classList.add('show');
    setTimeout(() => elements.toast.classList.remove('show'), 3200);
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
        showToast('已删除');
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
        showToast('已清空聊天记录');
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

function getFileIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14,2 14,8 20,8"/>
    </svg>`;
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
    state.serverFiles.forEach((file) => {
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';
        fileItem.innerHTML = `
            <span class="file-icon">${getFileIcon()}</span>
            <span class="file-name" title="${file.original_name}">${file.original_name}</span>
            <span class="file-size">${formatBytes(file.size_bytes)}</span>
            <button type="button" class="remove-btn" data-file-id="${file.id}" title="删除">
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
        delBtn.title = '删除本条';
        delBtn.setAttribute('aria-label', '删除本条');
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
        showToast('已回答');
    } catch (err) {
        console.error(err);
        showToast(err.message || '请求失败', true);
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
        updateGenerateButtonState();
    }
}

async function addFiles(fileList) {
    const fileArray = Array.from(fileList);
    const validFiles = fileArray.filter(isValidFile);
    if (fileArray.length - validFiles.length > 0) {
        showToast('部分文件类型不支持，已跳过');
    }
    if (validFiles.length === 0) {
        return;
    }
    if (state.serverFiles.length + validFiles.length > CONFIG.MAX_FILES) {
        showToast(`最多 ${CONFIG.MAX_FILES} 个文件`, true);
        return;
    }

    state.isUploading = true;
    updateSubmitButton();
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
        showToast('已上传');
    } catch (err) {
        console.error(err);
        showToast(err.message || '上传失败', true);
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
        showToast('已删除');
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

    elements.questionInput.addEventListener('input', updateSubmitButton);
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
}

function init() {
    initEventListeners();
    updateSubmitButton();
    refreshServerFiles()
        .then(() => loadChatMessages())
        .catch(() => {});
    console.log('API:', CONFIG.API_BASE);
}

document.addEventListener('DOMContentLoaded', init);
