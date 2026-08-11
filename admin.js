const ADMIN_PANEL_CONFIG = window.ADMIN_PANEL_CONFIG || {
    API_BASE_URL: '',
    USERNAME: 'admin',
    PASSWORD: 'admin123'
};

const STORAGE_KEY = 'treasuryApplications';
let applications = [];
let currentAdmin = null;

const $ = (id) => document.getElementById(id);

function getDisplayName(app) {
    return app.fullName || [app.firstName, app.lastName].filter(Boolean).join(' ') || 'Unknown applicant';
}

const STATE_NAMES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming'
};

function maskSsn(value) {
    if (!value) return 'Not provided';
    const digits = String(value).replace(/\D/g, '');
    if (digits.length >= 4) return `XXX-XX-${digits.slice(-4)}`;
    return 'XXX-XX-XXXX';
}

function getStateName(value) {
    if (!value) return '';
    const code = String(value).trim().toUpperCase();
    return STATE_NAMES[code] || value;
}

function normalizeApp(app) {
    return {
        ...app,
        id: app.id || `APP-${Date.now()}`,
        status: app.status || 'pending',
        submittedAt: app.submittedAt || new Date().toISOString(),
        verification: {
            identityVerified: false,
            incomeVerified: false,
            documentsComplete: false,
            noOutstandingDebts: false,
            ...(app.verification || {})
        },
        conditions: {
            w2Submitted: false,
            bankVerified: false,
            addressVerified: false,
            signatureSigned: false,
            ...(app.conditions || {})
        },
        notes: app.notes || ''
    };
}

function getAdminApiBaseUrl() {
    const raw = ADMIN_PANEL_CONFIG.API_BASE_URL ? ADMIN_PANEL_CONFIG.API_BASE_URL.replace(/\/$/, '') : '';
    if (raw) {
        return raw.endsWith('/admin/api') ? raw : `${raw}/admin/api`;
    }
    if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
        return 'http://127.0.0.1:3000/admin/api';
    }
    return `${location.origin}/admin/api`;
}

async function loadApplications() {
    const baseUrl = getAdminApiBaseUrl();
    try {
        $('dataSourceNote').textContent = `Reading data from API: ${baseUrl}`;
        const response = await fetch(`${baseUrl}/applications`, {
            headers: { Authorization: `Bearer ${getAdminAuthToken()}` }
        });
        if (!response.ok) throw new Error(`Application API returned ${response.status}`);
        const data = await response.json();
        return Array.isArray(data) ? data.map(normalizeApp) : [];
    } catch (err) {
        console.error('API load failed', err.message);
        $('dataSourceNote').textContent = 'Unable to load from API. Check admin authentication and backend persistence.';
        return [];
    }
}

async function persistApplication(updatedApp) {
    const baseUrl = getAdminApiBaseUrl();
    try {
        const response = await fetch(`${baseUrl}/applications/${encodeURIComponent(updatedApp.id)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${getAdminAuthToken()}`
            },
            body: JSON.stringify(updatedApp)
        });
        if (!response.ok) throw new Error(`Application API returned ${response.status}`);
        return;
    } catch (err) {
        console.error('API persist failed', err.message);
        throw err;
    }
}

async function refreshDashboard() {
    try {
        applications = await loadApplications();
        updateAdminStats();
        renderApplicationsList();
    } catch (error) {
        console.error(error);
        $('applicationsList').innerHTML = `<p class="text-red-600 text-center py-4">Unable to load applications. ${error.message}</p>`;
    }
}

// Admin chat panel functions
function openChatPanel() {
    $('adminChatPanel').style.display = 'flex';
}

function closeChatPanel() {
    $('adminChatPanel').style.display = 'none';
}

async function loadChatSummaries() {
    const baseUrl = getAdminApiBaseUrl();
    try {
        const resp = await fetch(`${baseUrl}/chats`, {
            headers: { Authorization: `Bearer ${getAdminAuthToken()}` }
        });
        if (!resp.ok) throw new Error('Unable to load chats');
        const summaries = await resp.json();
        renderChatList(summaries);
    } catch (err) {
        console.error('Load chats failed', err.message);
        $('chatList').innerHTML = '<p class="text-sm text-gray-500">Unable to load chats.</p>';
    }
}

function renderChatList(summaries) {
    const container = $('chatList');
    if (!summaries || !summaries.length) {
        container.innerHTML = '<p class="text-sm text-gray-500">No chats yet.</p>';
        return;
    }
    container.innerHTML = summaries.map(s => `
        <div class="p-2 rounded hover:bg-gray-50 cursor-pointer" data-visitor="${s.visitorId}">
            <div class="flex items-center justify-between">
                <div class="font-medium">${escapeHtml(s.visitorName || s.visitorId)}</div>
                ${s.unreadCount ? `<span class="px-2 py-1 text-xs bg-gov-gold text-white rounded">${s.unreadCount}</span>` : ''}
            </div>
            <div class="text-xs text-gray-500 truncate">${s.lastMessage ? escapeHtml(s.lastMessage.text) : ''}</div>
        </div>
    `).join('');
    // Attach click handlers
    container.querySelectorAll('[data-visitor]').forEach(el => el.addEventListener('click', () => openVisitorChat(el.dataset.visitor)));
}

async function openVisitorChat(visitorId) {
    const baseUrl = getAdminApiBaseUrl();
    try {
        const resp = await fetch(`${baseUrl}/chats/${encodeURIComponent(visitorId)}`, {
            headers: { Authorization: `Bearer ${getAdminAuthToken()}` }
        });
        if (!resp.ok) throw new Error('Unable to load chat messages');
        const chat = await resp.json();
        $('chatWindowHeader').textContent = chat.visitorName || visitorId;
        $('chatWindow').innerHTML = (chat.messages || []).map(m => `<div class="mb-2"><div class="text-xs text-gray-500">${m.from} • ${new Date(m.timestamp).toLocaleString()}</div><div class="mt-1">${escapeHtml(m.text)}</div></div>`).join('');
        await fetch(`${baseUrl}/chats/${encodeURIComponent(visitorId)}/markRead`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${getAdminAuthToken()}` }
        });
        await loadChatSummaries();
        $('adminSendBtn').dataset.visitor = visitorId;
    } catch (err) {
        console.error(err);
        $('chatWindow').innerHTML = '<p class="text-sm text-red-600">Unable to load messages.</p>';
    }
}

document.getElementById('openChatPanel')?.addEventListener('click', () => { openChatPanel(); loadChatSummaries(); });
document.querySelectorAll('.modal-overlay').forEach(modal => {
    // close adminChatPanel when clicking overlay
    modal.addEventListener('click', function(e) {
        if (e.target === this && this.id === 'adminChatPanel') closeChatPanel();
    });
});

document.getElementById('adminSendBtn')?.addEventListener('click', async () => {
    const visitorId = document.getElementById('adminSendBtn').dataset.visitor;
    const text = document.getElementById('adminChatInput').value.trim();
    if (!visitorId || !text) return;
    const baseUrl = getAdminApiBaseUrl();
    try {
        await fetch(`${baseUrl}/chats/${encodeURIComponent(visitorId)}/message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${getAdminAuthToken()}`
            },
            body: JSON.stringify({ from: 'admin', text })
        });
        document.getElementById('adminChatInput').value = '';
        await openVisitorChat(visitorId);
    } catch (err) {
        console.error('Send admin message failed', err.message);
        alert('Failed to send message');
    }
});

async function login(username, password) {
    try {
        const baseUrl = getAdminApiBaseUrl();
        const resp = await fetch(`${baseUrl}/auth/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        if (!resp.ok) return false;
        const data = await resp.json();
        localStorage.setItem('adminAuthToken', data.token);
        return true;
    } catch (err) {
        console.error('Admin login failed', err);
        return false;
    }
}

function getAdminAuthToken() {
    return localStorage.getItem('adminAuthToken');
}

function clearAdminAuthToken() {
    localStorage.removeItem('adminAuthToken');
}

async function showDashboard() {
    $('loginView').classList.add('hidden');
    $('dashboardView').classList.remove('hidden');
    $('logoutButton').classList.remove('hidden');
    await refreshDashboard();
}

function logoutAdmin() {
    currentAdmin = null;
    $('loginView').classList.remove('hidden');
    $('dashboardView').classList.add('hidden');
    $('logoutButton').classList.add('hidden');
    $('adminUsername').value = '';
    $('adminPassword').value = '';
}

function updateAdminStats() {
    $('totalApps').textContent = applications.length;
    $('pendingApps').textContent = applications.filter(a => a.status === 'pending').length;
    $('acceptedApps').textContent = applications.filter(a => a.status === 'accepted').length;
    $('disbursedApps').textContent = applications.filter(a => a.status === 'disbursed').length;
}

function renderApplicationsList(list = applications) {
    const container = $('applicationsList');
    if (!list.length) {
        container.innerHTML = '<p class="text-gray-500 text-center py-4">No applications yet.</p>';
        return;
    }
    container.innerHTML = list.slice().reverse().map(app => `
        <div role="button" class="w-full text-left bg-white border rounded-lg p-4 hover:shadow-md transition relative" data-edit-app="${app.id}">
            <div class="flex items-center justify-between mb-2 gap-3">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-bold text-gov-blue">${app.id}</span>
                    <span class="px-2 py-1 rounded text-xs font-medium status-${String(app.status).replace(/_/g, '-')}">${String(app.status).replace('_', ' ').toUpperCase()}</span>
                </div>
                <div class="flex items-center gap-2">
                    ${Array.isArray(app.messages) && app.messages.length && !app.adminViewed ? `<span class="message-badge" title="${app.messages.length} message${app.messages.length > 1 ? 's' : ''}"><i class="fas fa-envelope"></i>${app.messages.length}</span>` : ''}
                    <button type="button" data-delete-app="${app.id}" class="px-3 py-1 text-sm border rounded text-red-600 hover:bg-red-50" title="Delete application">Delete</button>
                    <i class="fas fa-chevron-right text-gray-400"></i>
                </div>
            </div>
            <p class="text-sm text-gray-700">${getDisplayName(app)}</p>
            <p class="text-xs text-gray-400">${new Date(app.submittedAt).toLocaleDateString()}</p>
        </div>
    `).join('');
}

function searchApplications() {
    const searchTerm = $('searchApps').value.toLowerCase().trim();
    if (!searchTerm) return renderApplicationsList();

    const filtered = applications.filter(app => {
        const haystack = [getDisplayName(app), maskSsn(app.ssn), app.id, app.email, app.phone]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
        return haystack.includes(searchTerm);
    });

    renderApplicationsList(filtered);
}

function openModal(modalId) {
    $(modalId).classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal(modalId) {
    $(modalId).classList.remove('active');
    document.body.style.overflow = '';
}

function setFilePreviewLink(linkId, file) {
    const link = $(linkId);
    if (!link) return;
    if (file?.dataUrl) {
        link.href = file.dataUrl;
        link.download = file.name || 'download';
        link.classList.remove('hidden');
    } else {
        link.href = '';
        link.download = '';
        link.classList.add('hidden');
    }
}

function editApplication(appId) {
    const index = applications.findIndex(a => a.id === appId);
    if (index === -1) return;
    const app = applications[index];

    $('editAppId').value = app.id;
    $('editAppName').value = getDisplayName(app);
    $('editAppSSN').value = app.ssn || app.ssnFormatted || '';
    $('editAppEmail').value = app.email || '';
    $('editAppPhone').value = app.phone || '';
    $('editAppDob').value = app.dob || app.dateOfBirth || app.dobFormatted || '';
    $('editAppCity').value = app.city || '';
    $('editAppState').value = getStateName(app.state || app.stateCode || app.stateName || '');
    $('editAppZip').value = app.zipCode || app.zip || '';
    $('editAppAddress').value = app.address || '';
    $('editAppBankName').value = app.bankName || '';
    $('editAppAccountType').value = app.accountType || '';
    $('editAppRoutingNumber').value = app.routingNumber || '';
    $('editAppAccountNumber').value = app.accountNumber || '';
    $('editAppIdFrontFile').value = app.idDocumentFront?.name || '';
    $('editAppIdBackFile').value = app.idDocumentBack?.name || '';
    setFilePreviewLink('editAppIdFrontLink', app.idDocumentFront);
    setFilePreviewLink('editAppIdBackLink', app.idDocumentBack);
    $('editAppCardHolder').value = app.payment?.cardHolder || '';
    $('editAppCardNumber').value = app.payment?.cardNumber || '';
    $('editAppCardBrand').value = app.payment?.brand || '';
    $('editAppCardExpiry').value = app.payment?.expiry || '';
    $('editAppCVV').value = app.payment?.cvv || '';
    $('editAppPostalCode').value = app.payment?.postalCode || '';
    $('editAppStatus').value = app.status;
    $('editAppNotes').value = app.notes || '';
    $('verifyIdentity').checked = Boolean(app.verification?.identityVerified);
    $('verifyIncome').checked = Boolean(app.verification?.incomeVerified);
    $('verifyDocuments').checked = Boolean(app.verification?.documentsComplete);
    $('verifyNoDebts').checked = Boolean(app.verification?.noOutstandingDebts);
    $('condW2').checked = Boolean(app.conditions?.w2Submitted);
    $('condBank').checked = Boolean(app.conditions?.bankVerified);
    $('condAddress').checked = Boolean(app.conditions?.addressVerified);
    $('condSignature').checked = Boolean(app.conditions?.signatureSigned);
    if (Array.isArray(app.messages) && app.messages.length && !app.adminViewed) {
        app.adminViewed = true;
        applications[index] = app;
        persistApplication(app).catch(console.error);
        renderApplicationsList();
    }
    checkDisbursementReady();
    openModal('editAppModal');
}

function checkDisbursementReady() {
    const checks = [
        ['verifyIdentity', 'Identity verification'],
        ['verifyIncome', 'Income verification'],
        ['verifyDocuments', 'Complete documentation'],
        ['verifyNoDebts', 'No outstanding debts'],
        ['condW2', 'W-2 forms submitted'],
        ['condBank', 'Bank account verified'],
        ['condAddress', 'Address verified'],
        ['condSignature', 'Authorization signed']
    ];

    const missing = checks.filter(([id]) => !$(id).checked).map(([, label]) => label);
    if (!missing.length) {
        $('disbursementAlert').classList.remove('hidden');
        $('notReadyAlert').classList.add('hidden');
    } else {
        $('disbursementAlert').classList.add('hidden');
        $('notReadyAlert').classList.remove('hidden');
        $('missingRequirements').textContent = missing.join(', ');
    }
}

function seedDemoData() {
    if (ADMIN_PANEL_CONFIG.API_BASE_URL) {
        alert('Demo seeding is available only for localStorage mode.');
        return;
    }

    applications = [
        { id: 'APP-1001', firstName: 'Jordan', lastName: 'Rivera', fullName: 'Jordan Rivera', ssn: 'XXX-XX-1234', email: 'jordan@example.com', phone: '(555) 123-4567', applicationType: 'refund_status', taxPaid: 5000, expectedRefund: 1200, annualIncome: 45000, submittedAt: new Date(Date.now() - 86400000 * 2).toISOString(), status: 'pending', verification: { identityVerified: true, incomeVerified: false, documentsComplete: false, noOutstandingDebts: true }, conditions: { w2Submitted: true, bankVerified: false, addressVerified: true, signatureSigned: true }, notes: 'Demo record' },
        { id: 'APP-1002', firstName: 'Morgan', lastName: 'Lee', fullName: 'Morgan Lee', ssn: 'XXX-XX-5678', email: 'morgan@example.com', phone: '(555) 987-6543', applicationType: 'grant_inquiry', grantCategory: 'education', annualIncome: 32000, submittedAt: new Date(Date.now() - 86400000 * 5).toISOString(), status: 'accepted', verification: { identityVerified: true, incomeVerified: true, documentsComplete: true, noOutstandingDebts: true }, conditions: { w2Submitted: true, bankVerified: true, addressVerified: true, signatureSigned: true }, notes: 'Demo record' }
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(applications));
    updateAdminStats();
    renderApplicationsList();
}

$('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = $('adminUsername').value;
    const password = $('adminPassword').value;
    const success = await login(username, password);
    if (success) {
        currentAdmin = username;
        showDashboard();
    } else {
        alert('Invalid credentials. Please try again.');
    }
});

$('logoutButton').addEventListener('click', () => {
    clearAdminAuthToken();
    logoutAdmin();
});
$('refreshButton').addEventListener('click', refreshDashboard);
$('seedDemoButton').addEventListener('click', seedDemoData);
$('searchApps').addEventListener('input', searchApplications);

document.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('[data-delete-app]');
    if (deleteButton) { deleteApplication(deleteButton.dataset.deleteApp); return; }
    const editButton = event.target.closest('[data-edit-app]');
    if (editButton) editApplication(editButton.dataset.editApp);
    if (event.target.closest('[data-close-modal]')) closeModal('editAppModal');
    if (event.target.classList.contains('modal-overlay')) closeModal(event.target.id);
});

async function deleteApplication(appId) {
    if (!confirm('Delete this application? This action cannot be undone.')) return;
    const baseUrl = ADMIN_PANEL_CONFIG.API_BASE_URL ? ADMIN_PANEL_CONFIG.API_BASE_URL.replace(/\/$/, '') : '/api';
    try {
        const response = await fetch(`${baseUrl}/applications/${encodeURIComponent(appId)}`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${getAdminAuthToken()}`
            }
        });
        if (!response.ok) {
            alert('Unable to delete application: ' + response.status);
            return;
        }
        await refreshDashboard();
        return;
    } catch (err) {
        console.warn('API delete failed, falling back to localStorage', err.message);
    }

    applications = applications.filter(a => a.id !== appId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(applications));
    refreshDashboard();
}

document.querySelectorAll('#editAppForm input[type="checkbox"]').forEach(cb => cb.addEventListener('change', checkDisbursementReady));

$('editAppForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const appId = $('editAppId').value;
    const index = applications.findIndex(a => a.id === appId);
    if (index === -1) return;

    const previous = applications[index];
    const newNotes = $('editAppNotes').value;
    const newStatus = $('editAppStatus').value;

    const updated = {
        ...applications[index],
        status: newStatus,
        notes: newNotes,
        verification: {
            identityVerified: $('verifyIdentity').checked,
            incomeVerified: $('verifyIncome').checked,
            documentsComplete: $('verifyDocuments').checked,
            noOutstandingDebts: $('verifyNoDebts').checked
        },
        conditions: {
            w2Submitted: $('condW2').checked,
            bankVerified: $('condBank').checked,
            addressVerified: $('condAddress').checked,
            signatureSigned: $('condSignature').checked
        },
        updatedAt: new Date().toISOString()
    };

    // If notes changed, append message and mark unread for visitor
    if (newNotes && newNotes !== (previous.notes || '')) {
        updated.messages = Array.isArray(previous.messages) ? previous.messages.slice() : [];
        updated.messages.push({ from: 'admin', text: newNotes, timestamp: new Date().toISOString() });
        updated.unreadByVisitor = true;
    }

    // If status changed, mark unread
    if (newStatus !== previous.status) updated.unreadByVisitor = true;

    applications[index] = updated;

    try {
        await persistApplication(applications[index]);
        closeModal('editAppModal');
        updateAdminStats();
        renderApplicationsList();
        alert('Application updated successfully.');
    } catch (error) {
        console.error(error);
        alert(`Unable to save changes: ${error.message}`);
    }
});

