/* ═══════════════════════════════════════════════════════════
   DOCCHAIN — app.js
   Conectado al chaincode docregistry (LevelDB)
   Incluye RegisterAccess y RegisterDeletion
═══════════════════════════════════════════════════════════ */

'use strict';

/* ── 0. CONFIGURACIÓN IPFS ───────────────────────────── */
let IPFS_GATEWAY = 'http://localhost:8080';

async function loadConfig() {
  try {
    const cfg = await apiFetch('/api/config');
    if (cfg && cfg.ipfsGateway) IPFS_GATEWAY = cfg.ipfsGateway;
  } catch (_) { /* usa el valor por defecto */ }
}

/* ── 1. ESTADO ───────────────────────────────────────────── */

const state = {
  currentUser: { name: '', org: '', orgLabel: '', initials: '', id: '' },
  view:        'inbox',
  filter:      'all',
  searchQuery: '',
  selectedId:  null,
  shipments:   [],
  loading:     false,
  userMap:     {}, // mapa de chaincodeId -> displayName
};


/* ── 2. CLIENTE API ──────────────────────────────────────── */

// Traduce un ID largo de chaincode a un nombre legible
// Ej: "MinisterioMSP::eDUw..." -> "User1 — Ministerio de Justicia"
function resolveId(id) {
  if (!id) return id;
  if (state.userMap[id]) return state.userMap[id];
  // Si no está en el mapa, mostrar solo la parte antes de ::
  const parts = id.split('::');
  return parts[0] || id;
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || 'Error en la petición');
  }
  return res.json();
}


/* ── 3. CARGA DE DATOS ───────────────────────────────────── */

async function loadCurrentUser() {
  try {
    const user = await apiFetch('/api/me');
    state.currentUser = user;
    document.getElementById('user-avatar-sidebar').textContent = user.initials;
    document.getElementById('user-name-sidebar').textContent   = user.name;
    document.getElementById('user-org-sidebar').textContent    = user.orgLabel || user.org;

    // Cargar mapa de IDs a nombres para resolver hashes en la interfaz
    // /api/users devuelve todos menos el usuario actual, con su chaincodeId real
    const usersWithChaincode = await apiFetch('/api/users');
    state.userMap = {};
    usersWithChaincode.forEach(u => {
      state.userMap[u.chaincodeId] = u.displayName;
    });
    // Añadir el usuario actual (viene de /api/me con su chaincodeId)
    state.userMap[user.id] = user.name;

  } catch (e) {
    window.location.href = '/login.html';
  }
}

async function loadShipments() {
  setLoading(true);
  try {
    const endpoint =
      state.view === 'inbox' ? '/api/chaincode/inbox'       :
      state.view === 'sent'  ? '/api/chaincode/sent'        :
                               '/api/chaincode/my-shipments';
    const data = await apiFetch(endpoint);
    state.shipments = (data || []).map(s => ({
      ...s,
      direction: s.senderId === state.currentUser.id ? 'sent' : 'inbox',
      unread:    s.status === 'PENDING' && s.recipientId === state.currentUser.id,
    }));
    state.loading = false;  // ← desactivar ANTES de renderizar
    renderAll();
  } catch (e) {
    showToast('error', 'Error al cargar envíos: ' + e.message);
  } finally {
    state.loading = false;  // ← también aquí por si hay error
  }
}


/* ── 4. UTILIDADES ───────────────────────────────────────── */

const STATUS_LABELS = {
  PENDING:   'Pendiente',
  READ:      'Leído',
  CONFIRMED: 'Confirmado',
  REJECTED:  'Rechazado',
};

const STATUS_ICONS = {
  PENDING:   'fa-clock',
  READ:      'fa-eye',
  CONFIRMED: 'fa-circle-check',
  REJECTED:  'fa-circle-xmark',
};

const FILE_ICONS = {
  'application/pdf':    'fa-file-pdf',
  'application/msword': 'fa-file-word',
  'image/jpeg':         'fa-file-image',
  'image/png':          'fa-file-image',
  'application/zip':    'fa-file-zipper',
};

// Etiquetas legibles para cada tipo de evento del historial
const QUERY_TYPE_LABELS = {
  'SEND':         'Documento registrado en blockchain',
  'READ':         'Consultado desde la aplicación',
  'FILE_ACCESS':  'Fichero descargado desde IPFS',
  'FILE_DELETED': 'Fichero eliminado de IPFS',
};

function formatQueryType(qt) {
  if (QUERY_TYPE_LABELS[qt]) return QUERY_TYPE_LABELS[qt];
  if (qt.startsWith('STATUS_UPDATE:')) {
    const newStatus = qt.split(':')[1];
    return `Estado actualizado a: ${STATUS_LABELS[newStatus] || newStatus}`;
  }
  return qt;
}

function formatDate(isoString) {
  const d = new Date(isoString);
  const isToday = d.toDateString() === new Date().toDateString();
  return isToday
    ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' });
}

function formatDateLong(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })
    + ' — ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function getFileIcon(fileType) {
  return FILE_ICONS[fileType] || 'fa-file';
}

function countUnread() {
  return state.shipments.filter(s => s.direction === 'inbox' && s.unread).length;
}

function setLoading(on) {
  state.loading = on;
  if (on) {
    document.getElementById('shipment-list').innerHTML = `
      <div class="list-empty">
        <i class="fa-solid fa-circle-notch fa-spin"></i>
        <p>Cargando desde blockchain...</p>
      </div>`;
  }
}


/* ── 5. FILTRADO ─────────────────────────────────────────── */

function getFilteredShipments() {
  let items = state.shipments;
  if (state.view === 'inbox') items = items.filter(s => s.direction === 'inbox');
  else if (state.view === 'sent') items = items.filter(s => s.direction === 'sent');
  if (state.filter !== 'all') items = items.filter(s => s.status === state.filter);
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    items = items.filter(s =>
      s.description?.toLowerCase().includes(q) ||
      s.senderId?.toLowerCase().includes(q)    ||
      s.fileName?.toLowerCase().includes(q)    ||
      s.shipmentId?.toLowerCase().includes(q)
    );
  }
  return items;
}


/* ── 6. RENDER ───────────────────────────────────────────── */

function renderAll() {
  renderBadge();
  renderList();
}

function renderBadge() {
  const badge = document.getElementById('badge-inbox');
  const count = countUnread();
  badge.textContent = count > 0 ? count : '';
}

function renderList() {
  if (state.loading) return;
  const container = document.getElementById('shipment-list');
  const items     = getFilteredShipments();

  if (!items.length) {
    container.innerHTML = `
      <div class="list-empty">
        <i class="fa-regular fa-folder-open"></i>
        <p>No hay envíos que mostrar</p>
      </div>`;
    return;
  }

  container.innerHTML = items.map(s => {
    const sid = s.shipmentId || s.id;
    const deletedBadge = s.ipfsDeleted
      ? `<span class="status-badge status-deleted" title="Fichero eliminado de IPFS">
           <i class="fa-solid fa-trash-can" style="margin-right:3px;font-size:10px;"></i>Fichero eliminado
         </span>`
      : '';
    return `
      <div
        class="shipment-item ${s.unread ? 'unread' : ''} ${sid === state.selectedId ? 'selected' : ''}"
        data-id="${sid}"
        role="button" tabindex="0"
      >
        <div class="${s.unread ? 'unread-indicator' : 'read-indicator'}"></div>
        <div class="item-body">
          <div class="item-from">${s.direction === 'inbox' ? resolveId(s.senderId) : 'Para: ' + resolveId(s.recipientId)}</div>
          <div class="item-subject">${s.description || s.fileName}</div>
          <div class="item-preview">${s.fileName} · ${s.fileType}</div>
        </div>
        <div class="item-meta">
          <span class="item-date">${formatDate(s.sentAt)}</span>
          <span class="status-badge status-${s.status}">${STATUS_LABELS[s.status]}</span>
          ${deletedBadge}
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('.shipment-item').forEach(el => {
    el.addEventListener('click',   () => selectShipment(el.dataset.id));
    el.addEventListener('keydown', e => { if (e.key === 'Enter') selectShipment(el.dataset.id); });
  });
}

async function selectShipment(id) {
  state.selectedId = id;
  renderList();

  try {
    // GetShipment registra la consulta READ en el ledger automáticamente
    const s = await apiFetch(`/api/chaincode/shipment/${id}`);
    s.direction = s.senderId === state.currentUser.id ? 'sent' : 'inbox';
    s.unread    = false;

    const idx = state.shipments.findIndex(x => (x.shipmentId || x.id) === id);
    if (idx !== -1) state.shipments[idx] = { ...state.shipments[idx], ...s };

    renderBadge();
    renderDetail(s);
  } catch (e) {
    showToast('error', 'Error al cargar el envío: ' + e.message);
  }
}

function renderDetail(s) {
  document.getElementById('detail-empty').hidden   = true;
  document.getElementById('detail-content').hidden = false;

  const sid = s.shipmentId || s.id;

  document.getElementById('d-subject').textContent    = s.description || s.fileName;
  document.getElementById('d-from').textContent       = resolveId(s.senderId);
  document.getElementById('d-to').textContent         = resolveId(s.recipientId);
  document.getElementById('d-date').textContent       = formatDateLong(s.sentAt);
  document.getElementById('d-status-badge').innerHTML =
    `<span class="status-badge status-${s.status}">
       <i class="fa-solid ${STATUS_ICONS[s.status]}" style="margin-right:4px;font-size:10px;"></i>
       ${STATUS_LABELS[s.status]}
     </span>
     ${s.ipfsDeleted ? '<span class="status-badge status-deleted" style="margin-left:6px;"><i class="fa-solid fa-trash-can" style="margin-right:3px;font-size:10px;"></i>Fichero eliminado</span>' : ''}`;

  const fileIcon    = getFileIcon(s.fileType);
  const fileSizeStr = s.fileSize > 0
    ? (s.fileSize > 1048576
        ? (s.fileSize / 1048576).toFixed(1) + ' MB'
        : Math.round(s.fileSize / 1024) + ' KB')
    : '—';

  // Historial de auditoría
  const auditHtml = (s.queryHistory || []).map(q => {
    const isDelete  = q.queryType === 'FILE_DELETED';
    const isAccess  = q.queryType === 'FILE_ACCESS';
    const dotClass  = isDelete ? 'confirmed' : isAccess ? 'access' : '';
    return `
      <div class="audit-entry">
        <div class="audit-line-wrapper">
          <div class="audit-dot ${dotClass}"></div>
          <div class="audit-line"></div>
        </div>
        <div class="audit-text-block">
          <div class="audit-action">${formatQueryType(q.queryType)}</div>
          <div class="audit-who">${resolveId(q.queryBy)}</div>
          <div class="audit-time">${formatDateLong(q.queryAt)}</div>
        </div>
      </div>`;
  }).join('');

  document.getElementById('d-body').innerHTML = `
    <div class="detail-section">
      <div class="section-title"><i class="fa-solid fa-paperclip" style="font-size:10px;"></i> Documento adjunto</div>
      <div class="doc-card ${s.ipfsDeleted ? 'doc-deleted' : ''}">
        <div class="doc-icon"><i class="fa-solid ${s.ipfsDeleted ? 'fa-file-circle-xmark' : fileIcon}"></i></div>
        <div class="doc-info">
          <div class="doc-name">${s.fileName} ${s.ipfsDeleted ? '<span style="color:var(--red-600);font-size:11px;">(eliminado de IPFS)</span>' : ''}</div>
          <div class="doc-meta">${s.fileType} · ${fileSizeStr}</div>
        </div>
      </div>
    </div>

    <div class="detail-section">
      <div class="section-title"><i class="fa-solid fa-link" style="font-size:10px;"></i> Registro blockchain</div>
      <div class="blockchain-block">
        <div class="blockchain-row">
          <span class="bc-label">ID de envío</span>
          <span class="bc-value">${sid}</span>
        </div>
        <div class="blockchain-row">
          <span class="bc-label">Hash IPFS (CID)</span>
          <span class="bc-value">${s.ipfsHash}</span>
        </div>
        <div class="blockchain-row">
          <span class="bc-label">Fichero en IPFS</span>
          <span class="bc-value" style="color:${s.ipfsDeleted ? 'var(--red-600)' : 'var(--green-600)'};">
            ${s.ipfsDeleted ? '✗ Eliminado' : '✓ Disponible'}
          </span>
        </div>
      </div>
    </div>

    <div class="detail-section">
      <div class="section-title"><i class="fa-solid fa-shield-halved" style="font-size:10px;"></i> Historial de auditoría</div>
      <div class="audit-timeline">${auditHtml || '<p style="font-size:13px;color:var(--gray-400)">Sin registros aún.</p>'}</div>
    </div>
  `;

  renderDetailActions(s);
}

function renderDetailActions(s) {
  const footer      = document.getElementById('d-footer');
  const sid         = s.shipmentId || s.id;
  const isRecipient = s.recipientId === state.currentUser.id;
  const isFinal     = s.status === 'CONFIRMED' || s.status === 'REJECTED';
  const isParty     = s.senderId === state.currentUser.id || isRecipient;

  let html = '';

  // Botón ver/descargar documento (solo si no está eliminado)
  if (!s.ipfsDeleted && isParty) {
    html += `
      <button class="btn btn-outline" data-action="access" data-id="${sid}" data-hash="${s.ipfsHash}">
        <i class="fa-solid fa-file-arrow-down"></i> Ver documento
      </button>`;
  }

  // Botones de confirmación/rechazo (solo destinatario, solo si no es final)
  if (isRecipient && !isFinal) {
    html += `
      <button class="btn btn-success" data-action="confirm" data-id="${sid}">
        <i class="fa-solid fa-circle-check"></i> Confirmar
      </button>
      <button class="btn btn-danger" data-action="reject" data-id="${sid}">
        <i class="fa-solid fa-circle-xmark"></i> Rechazar
      </button>`;
  }

  // Botón eliminar fichero de IPFS (cualquiera de las partes, si no está eliminado)
  if (!s.ipfsDeleted && isParty) {
    html += `
      <button class="btn btn-danger" data-action="delete" data-id="${sid}" data-hash="${s.ipfsHash}">
        <i class="fa-solid fa-trash-can"></i> Eliminar fichero
      </button>`;
  }

  // Si no hay acciones disponibles, mostrar historial
  if (!html) {
    html = `
      <button class="btn btn-outline" data-action="history" data-id="${sid}">
        <i class="fa-solid fa-clock-rotate-left"></i> Ver historial completo
      </button>`;
  }

  footer.innerHTML = html;

  footer.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () =>
      handleAction(btn.dataset.action, btn.dataset.id, btn.dataset.hash));
  });
}

async function handleAction(action, shipmentId, ipfsHash) {
  if (action === 'access') {
    // 1. Registrar acceso on-chain
    try {
      await apiFetch('/api/chaincode/access', {
        method: 'POST',
        body: JSON.stringify({ shipmentId }),
      });
    } catch (e) {
      showToast('error', 'Error al registrar acceso: ' + e.message);
      return;
    }
    // 2. Abrir el fichero en IPFS
    window.open(`${IPFS_GATEWAY}/ipfs/${ipfsHash}`, '_blank');
    showToast('success', 'Acceso registrado en blockchain.');
    // 3. Refrescar el detalle para mostrar el nuevo registro en el historial
    await selectShipment(shipmentId);

  } else if (action === 'confirm') {
    try {
      await apiFetch('/api/chaincode/status', {
        method: 'POST',
        body: JSON.stringify({ shipmentId, status: 'CONFIRMED' }),
      });
      showToast('success', 'Recepción confirmada y registrada en blockchain.');
      await selectShipment(shipmentId);
      renderBadge();
    } catch (e) {
      showToast('error', 'Error al confirmar: ' + e.message);
    }

  } else if (action === 'reject') {
    if (!confirm('¿Confirmas que deseas rechazar este envío? Esta acción quedará registrada en la blockchain.')) return;
    try {
      await apiFetch('/api/chaincode/status', {
        method: 'POST',
        body: JSON.stringify({ shipmentId, status: 'REJECTED' }),
      });
      showToast('error', 'Envío rechazado. El registro queda en la blockchain.');
      await selectShipment(shipmentId);
      renderBadge();
    } catch (e) {
      showToast('error', 'Error al rechazar: ' + e.message);
    }

  } else if (action === 'delete') {
    if (!confirm(
      '¿Seguro que quieres eliminar el fichero de IPFS?\n\n' +
      'El registro del envío permanecerá en la blockchain, ' +
      'pero el fichero ya no será accesible. Esta acción no se puede deshacer.'
    )) return;

    try {
      // 1. Aquí iría la llamada a tu nodo IPFS para borrar el pin
      //    await fetch(`/api/ipfs/unpin/${ipfsHash}`, { method: 'DELETE' });

      // 2. Registrar el borrado on-chain
      await apiFetch('/api/chaincode/delete', {
        method: 'POST',
        body: JSON.stringify({ shipmentId }),
      });
      showToast('error', 'Fichero eliminado. El registro queda en la blockchain.');
      await selectShipment(shipmentId);
    } catch (e) {
      showToast('error', 'Error al eliminar: ' + e.message);
    }

  } else if (action === 'history') {
    try {
      const [fabricHistory, shipment] = await Promise.all([
        apiFetch(`/api/chaincode/history/${shipmentId}`),
        apiFetch(`/api/chaincode/shipment/${shipmentId}`),
      ]);
      renderHistoryModal(shipmentId, shipment.queryHistory, fabricHistory);
    } catch (e) {
      showToast('error', 'Error al cargar el historial: ' + e.message);
    }
  }
}


/* ── 7. MODAL ────────────────────────────────────────────── */

function buildSendForm() {
  return `
    <div class="form-group">
      <label for="input-recipient">Destinatario <span class="required">*</span></label>
      <select id="input-recipient">
        <option value="">Cargando usuarios...</option>
      </select>
    </div>
    <div class="form-group">
      <label for="input-subject">Descripcion / Asunto <span class="required">*</span></label>
      <input type="text" id="input-subject" placeholder="Ej: Demanda civil — expediente 123/2025">
    </div>
    <div class="form-group">
      <label for="input-file">Documento <span class="required">*</span></label>
      <input type="file" id="input-file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.zip">
      <span class="form-hint">Se subira automaticamente a IPFS al registrar el envio.</span>
    </div>
    <div class="form-group" id="ipfs-status" style="display:none;">
      <div style="padding:8px 10px;background:var(--green-50);border:1px solid #b8dcbf;border-radius:8px;font-size:12px;color:var(--green-600);">
        <i class="fa-solid fa-circle-check"></i>
        <span id="ipfs-status-text"></span>
      </div>
    </div>
  `;
}


async function loadRecipients() {
  const select = document.getElementById('input-recipient');
  if (!select) return;
  try {
    const users = await apiFetch('/api/users');
    select.innerHTML = '<option value="">-- Selecciona el destinatario --</option>' +
      users.map(u =>
        `<option value="${u.chaincodeId}">${u.displayName}</option>`
      ).join('');
  } catch (e) {
    select.innerHTML = '<option value="">Error al cargar usuarios</option>';
  }
}

function openModal() {
  document.getElementById('modal-title').innerHTML =
    `<i class="fa-solid fa-paper-plane"></i> Nuevo envío de documento`;
  document.querySelector('.modal-body').innerHTML = buildSendForm();
  document.querySelector('.modal-footer').innerHTML = `
    <button class="btn btn-secondary" id="btn-cancel-modal">Cancelar</button>
    <button class="btn btn-primary" id="btn-send-modal">
      <i class="fa-solid fa-paper-plane"></i> Registrar envío
    </button>`;
  document.getElementById('btn-cancel-modal').addEventListener('click', closeModal);
  document.getElementById('btn-send-modal').addEventListener('click', submitNewShipment);
  document.querySelector('.modal').style.maxWidth = '';
  document.getElementById('modal-overlay').classList.add('open');

  // Cargar lista de destinatarios
  loadRecipients();
}

function renderHistoryModal(shipmentId, queryHistory, fabricHistory) {
  document.getElementById('modal-title').innerHTML =
    `<i class="fa-solid fa-clock-rotate-left"></i> Auditoría — ${shipmentId}`;

  // ── Timeline de auditoría interna (queryHistory) ──────────
  const auditHtml = (queryHistory || []).length
    ? (queryHistory).map(q => {
        const isDelete = q.queryType === 'FILE_DELETED';
        const isAccess = q.queryType === 'FILE_ACCESS';
        const isStatus = q.queryType?.startsWith('STATUS_UPDATE:');
        const dotClass = isDelete ? 'confirmed' : isAccess ? 'access' : isStatus ? 'confirmed' : '';
        return `
          <div class="audit-entry">
            <div class="audit-line-wrapper">
              <div class="audit-dot ${dotClass}"></div>
              <div class="audit-line"></div>
            </div>
            <div class="audit-text-block">
              <div class="audit-action">${formatQueryType(q.queryType)}</div>
              <div class="audit-who">${resolveId(q.queryBy)}</div>
              <div class="audit-time">${formatDateLong(q.queryAt)}</div>
            </div>
          </div>`;
      }).join('')
    : '<p style="font-size:13px;color:var(--gray-400);padding:4px 0;">Sin registros aún.</p>';

  // ── Transacciones Fabric (colapsable) ─────────────────────
  const fabricHtml = (fabricHistory || []).map(tx => `
    <div class="blockchain-block" style="margin-bottom:8px;">
      <div class="blockchain-row">
        <span class="bc-label">TX ID</span>
        <span class="bc-value">${tx.txId}</span>
      </div>
      <div class="blockchain-row">
        <span class="bc-label">Timestamp</span>
        <span class="bc-value">${formatDateLong(tx.timestamp)}</span>
      </div>
      <div class="blockchain-row">
        <span class="bc-label">Estado</span>
        <span class="bc-value">${tx.data?.status ? STATUS_LABELS[tx.data.status] : '—'}</span>
      </div>
      <div class="blockchain-row">
        <span class="bc-label">Fichero IPFS</span>
        <span class="bc-value" style="color:${tx.data?.ipfsDeleted ? 'var(--red-600)' : 'var(--green-600)'}">
          ${tx.data?.ipfsDeleted ? '✗ Eliminado' : '✓ Disponible'}
        </span>
      </div>
    </div>`).join('') || '<p style="font-size:13px;color:var(--gray-400);">No hay transacciones Fabric.</p>';

  document.querySelector('.modal-body').innerHTML = `
    <div>
      <div style="font-size:10px;font-weight:600;color:var(--gray-400);letter-spacing:.1em;text-transform:uppercase;margin-bottom:12px;">
        <i class="fa-solid fa-shield-halved" style="font-size:10px;margin-right:4px;"></i> Historial de acciones
      </div>
      <div class="audit-timeline">${auditHtml}</div>
    </div>
    <details style="margin-top:12px;">
      <summary style="font-size:11px;font-weight:600;color:var(--gray-400);letter-spacing:.08em;text-transform:uppercase;cursor:pointer;padding:6px 0;user-select:none;">
        <i class="fa-solid fa-link" style="font-size:10px;margin-right:4px;"></i> Transacciones Fabric
      </summary>
      <div style="margin-top:10px;">${fabricHtml}</div>
    </details>`;

  document.querySelector('.modal-footer').innerHTML =
    `<button class="btn btn-secondary" id="btn-cancel-modal">Cerrar</button>`;
  document.getElementById('btn-cancel-modal').addEventListener('click', closeModal);
  document.querySelector('.modal').style.maxWidth = '620px';
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

async function submitNewShipment() {
  const recipient = document.getElementById('input-recipient').value;
  const subject   = document.getElementById('input-subject').value.trim();
  const fileInput = document.getElementById('input-file');

  if (!recipient)              { alert('Selecciona un destinatario.'); return; }
  if (!subject)                { alert('La descripcion es obligatoria.'); return; }
  if (!fileInput || !fileInput.files[0]) { alert('Selecciona un documento.'); return; }

  const sendBtn = document.getElementById('btn-send-modal');
  sendBtn.disabled = true;

  let ipfsHash, fileName, fileType, fileSize;

  try {
    // Paso 1: subir el fichero a IPFS
    sendBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Subiendo a IPFS...';

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    const uploadRes = await fetch('/api/ipfs/upload', {
      method: 'POST',
      body: formData,
    });
    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      throw new Error(err.message || 'Error al subir a IPFS');
    }
    const uploadData = await uploadRes.json();
    ipfsHash = uploadData.cid;
    fileName = uploadData.fileName;
    fileType = uploadData.fileType;
    fileSize = uploadData.fileSize;

    // Mostrar el CID obtenido
    const statusDiv = document.getElementById('ipfs-status');
    if (statusDiv) {
      statusDiv.style.display = 'block';
      document.getElementById('ipfs-status-text').textContent =
        'Subido a IPFS: ' + ipfsHash.substring(0, 20) + '...';
    }

    // Paso 2: registrar el envio en el chaincode
    sendBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Registrando en blockchain...';

    const { shipmentId } = await apiFetch('/api/chaincode/send', {
      method: 'POST',
      body: JSON.stringify({
        recipientId: recipient,
        ipfsHash,
        fileName,
        fileType,
        fileSize,
        description: subject,
      }),
    });

    closeModal();
    showToast('success', 'Envio registrado en blockchain: ' + shipmentId);
    setView('sent');

  } catch (e) {
    showToast('error', e.message);
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Registrar envio';
  }
}



/* ── 8. NAVEGACIÓN ───────────────────────────────────────── */

const VIEW_TITLES = {
  inbox: 'Recibidos',
  sent:  'Enviados',
  all:   'Todos los envíos',
  audit: 'Auditoría blockchain',
};

function setView(view) {
  state.view       = view;
  state.selectedId = null;
  state.filter     = 'all';

  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.view === view));
  document.getElementById('list-title').textContent = VIEW_TITLES[view] || view;
  document.querySelectorAll('.filter-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.filter === 'all'));
  document.getElementById('detail-empty').hidden   = false;
  document.getElementById('detail-content').hidden = true;

  loadShipments();
}

// Cerrar sesión
async function logout() {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = '/login.html';
  }
}


/* ── 9. TOAST ────────────────────────────────────────────── */

let toastTimeout = null;

function showToast(type, message) {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  const icon = type === 'success' ? 'fa-circle-check'
             : type === 'error'   ? 'fa-circle-xmark'
             : 'fa-circle-info';
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="fa-solid ${icon}"></i> ${message}`;
  clearTimeout(toastTimeout);
  requestAnimationFrame(() => {
    toast.classList.add('show');
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 3500);
  });
}


/* ── 10. ARRANQUE ────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await loadCurrentUser();
  await loadShipments();

  document.getElementById('btn-new-shipment').addEventListener('click', openModal);

  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // Botón de cerrar sesión
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);

  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); setView(el.dataset.view); });
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      renderList();
    });
  });

  document.getElementById('search-input').addEventListener('input', e => {
    state.searchQuery = e.target.value;
    renderList();
  });
});
