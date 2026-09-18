let isVaultUnlocked = sessionStorage.getItem('memoro_unlocked') === 'true';
let allRecords = [];
let selectedFolder = 'ALL';

const captureForm = document.getElementById('capture-form');
const formNameInput = document.getElementById('form-name');
const formContentInput = document.getElementById('form-content');
const isSensitiveCheckbox = document.getElementById('is-sensitive');
const recordsList = document.getElementById('records-list');
const filterInput = document.getElementById('filter-input');
const folderPillsContainer = document.getElementById('folder-pills');

const vaultPinInput = document.getElementById('vault-pin');
const btnUnlockVault = document.getElementById('btn-unlock-vault');
const vaultStatus = document.getElementById('vault-status');

const askInput = document.getElementById('ask-input');
const btnAsk = document.getElementById('btn-ask');
const askResult = document.getElementById('ask-result');
const resultSource = document.getElementById('result-source');
const resultAnswer = document.getElementById('result-answer');

const btnExport = document.getElementById('btn-export');
const importFileInput = document.getElementById('import-file');

function updateVaultUI() {
  if (isVaultUnlocked) {
    vaultStatus.textContent = '🔓 Active';
    vaultStatus.className = 'badge active';
    btnUnlockVault.textContent = '🔒 Lock Vault';
    vaultPinInput.style.display = 'none';
  } else {
    vaultStatus.textContent = '🔒 Locked';
    vaultStatus.className = 'badge locked';
    btnUnlockVault.textContent = '🔓 Unlock Vault';
    vaultPinInput.style.display = 'inline-block';
    vaultPinInput.value = '';
  }
}

async function fetchRecords() {
  try {
    const res = await fetch('/api/records', {
      headers: { 'x-vault-unlocked': isVaultUnlocked ? 'true' : 'false' },
    });
    allRecords = await res.json();
    renderFolderPills();
    applyFilterAndRender();
  } catch (err) {
    console.error('Failed to load records:', err);
  }
}

function renderFolderPills() {
  const folders = new Map();

  allRecords.forEach((rec) => {
    const cat = rec.category || 'General';
    folders.set(cat, (folders.get(cat) || 0) + 1);
  });

  folderPillsContainer.innerHTML = '';

  const allPill = document.createElement('button');
  allPill.className = `folder-pill ${selectedFolder === 'ALL' ? 'active' : ''}`;
  allPill.textContent = `All (${allRecords.length})`;
  allPill.onclick = () => {
    selectedFolder = 'ALL';
    renderFolderPills();
    applyFilterAndRender();
  };
  folderPillsContainer.appendChild(allPill);

  folders.forEach((count, name) => {
    const pill = document.createElement('button');
    pill.className = `folder-pill ${selectedFolder === name ? 'active' : ''}`;
    pill.textContent = `${name} (${count})`;
    pill.onclick = () => {
      selectedFolder = name;
      renderFolderPills();
      applyFilterAndRender();
    };
    folderPillsContainer.appendChild(pill);
  });
}

function applyFilterAndRender() {
  const query = filterInput.value.toLowerCase().trim();

  const filtered = allRecords.filter((rec) => {
    const recFolder = rec.category || 'General';
    const matchesFolder = selectedFolder === 'ALL' || recFolder === selectedFolder;
    const matchesQuery =
      !query ||
      rec.form_name.toLowerCase().includes(query) ||
      recFolder.toLowerCase().includes(query) ||
      (rec.tags && rec.tags.toLowerCase().includes(query)) ||
      rec.content.toLowerCase().includes(query);

    return matchesFolder && matchesQuery;
  });

  renderRecords(filtered);
}

function renderRecords(records) {
  recordsList.innerHTML = '';

  if (records.length === 0) {
    recordsList.innerHTML = '<p class="empty-state">No matching memories found.</p>';
    return;
  }

  records.forEach((rec) => {
    const card = document.createElement('div');
    card.className = 'record-card';
    card.id = `card-${rec.id}`;

    const header = document.createElement('div');
    header.className = 'record-header';

    const titleContainer = document.createElement('div');
    titleContainer.className = 'record-title-container';

    const title = document.createElement('h3');
    title.textContent = rec.form_name;
    titleContainer.appendChild(title);

    if (rec.category) {
      const folderBadge = document.createElement('span');
      folderBadge.className = 'badge folder';
      folderBadge.textContent = `📁 ${rec.category}`;
      titleContainer.appendChild(folderBadge);
    }

    if (rec.is_sensitive === 1) {
      const badge = document.createElement('span');
      badge.className = 'badge sensitive';
      badge.textContent = '🔒 Locked Vault';
      titleContainer.appendChild(badge);
    }

    const date = document.createElement('span');
    date.className = 'record-date';
    date.textContent = new Date(rec.last_updated).toLocaleString();

    header.appendChild(titleContainer);
    header.appendChild(date);

    const body = document.createElement('p');
    body.className = 'record-content';
    body.id = `content-${rec.id}`;
    body.textContent = rec.content;

    const actions = document.createElement('div');
    actions.className = 'record-actions';

    // Copy Action
    const btnCopy = document.createElement('button');
    btnCopy.className = 'btn-card-action';
    btnCopy.innerHTML = '📋 Copy';
    btnCopy.onclick = async () => {
      await navigator.clipboard.writeText(rec.content);
      btnCopy.innerHTML = '✅ Copied!';
      setTimeout(() => (btnCopy.innerHTML = '📋 Copy'), 1500);
    };

    // Edit Action (In-Place)
    const btnEdit = document.createElement('button');
    btnEdit.className = 'btn-card-action';
    btnEdit.innerHTML = '✏️ Edit';
    btnEdit.onclick = () => enableInPlaceEdit(rec, card, body, actions);

    // Delete Action
    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn-card-action delete';
    btnDelete.innerHTML = '🗑️ Delete';
    btnDelete.onclick = async () => {
      if (confirm(`Delete "${rec.form_name}"?`)) {
        await fetch(`/api/records/${rec.id}`, { method: 'DELETE' });
        fetchRecords();
      }
    };

    actions.appendChild(btnCopy);
    actions.appendChild(btnEdit);
    actions.appendChild(btnDelete);

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(actions);

    recordsList.appendChild(card);
  });
}

// In-Place Editor Mode
function enableInPlaceEdit(rec, card, bodyEl, actionsEl) {
  if (rec.is_sensitive === 1 && !isVaultUnlocked) {
    alert('Please unlock the vault first to edit locked entries.');
    return;
  }

  const editArea = document.createElement('textarea');
  editArea.className = 'edit-inline-textarea';
  editArea.rows = 4;
  editArea.value = rec.content;

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn primary';
  saveBtn.textContent = '💾 Save Changes';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn secondary';
  cancelBtn.textContent = 'Cancel';

  const editBar = document.createElement('div');
  editBar.className = 'record-actions';
  editBar.appendChild(saveBtn);
  editBar.appendChild(cancelBtn);

  bodyEl.style.display = 'none';
  actionsEl.style.display = 'none';

  card.appendChild(editArea);
  card.appendChild(editBar);

  cancelBtn.onclick = () => {
    editArea.remove();
    editBar.remove();
    bodyEl.style.display = 'block';
    actionsEl.style.display = 'flex';
  };

  saveBtn.onclick = async () => {
    const newContent = editArea.value.trim();
    if (!newContent) return;

    await fetch('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        form_name: rec.form_name,
        category: rec.category,
        tags: rec.tags,
        content: newContent,
        is_sensitive: rec.is_sensitive === 1,
      }),
    });

    fetchRecords();
  };
}

filterInput.addEventListener('input', applyFilterAndRender);

captureForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const payload = {
    form_name: formNameInput.value.trim(),
    content: formContentInput.value.trim(),
    is_sensitive: isSensitiveCheckbox.checked,
  };

  try {
    const res = await fetch('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      formNameInput.value = '';
      formContentInput.value = '';
      isSensitiveCheckbox.checked = false;
      fetchRecords();
    }
  } catch (err) {
    console.error('Error saving record:', err);
  }
});

btnUnlockVault.addEventListener('click', async () => {
  if (isVaultUnlocked) {
    isVaultUnlocked = false;
    sessionStorage.removeItem('memoro_unlocked');
    updateVaultUI();
    fetchRecords();
    return;
  }

  const pin = vaultPinInput.value;
  const res = await fetch('/api/vault/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pin }),
  });

  const data = await res.json();
  if (res.ok && data.success) {
    isVaultUnlocked = true;
    sessionStorage.setItem('memoro_unlocked', 'true');
    updateVaultUI();
    fetchRecords();
  } else {
    alert(data.error || 'Incorrect PIN.');
  }
});

btnExport.addEventListener('click', async () => {
  const res = await fetch('/api/export', {
    headers: { 'x-vault-unlocked': isVaultUnlocked ? 'true' : 'false' },
  });
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'memoro-backup.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
});

importFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const fileText = await file.text();
    const parsedData = JSON.parse(fileText);
    const records = parsedData.records || (Array.isArray(parsedData) ? parsedData : null);

    if (!records) return alert('Invalid backup format.');

    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records }),
    });

    const result = await res.json();
    if (res.ok) {
      alert(result.message);
      fetchRecords();
    } else {
      alert(result.error || 'Import failed.');
    }
  } catch (err) {
    alert('Failed to parse backup: ' + err.message);
  } finally {
    importFileInput.value = '';
  }
});

btnAsk.addEventListener('click', async () => {
  const question = askInput.value.trim();
  if (!question) return;

  btnAsk.textContent = 'Thinking...';
  btnAsk.disabled = true;

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-vault-unlocked': isVaultUnlocked ? 'true' : 'false',
      },
      body: JSON.stringify({ question }),
    });

    const data = await res.json();
    askResult.classList.remove('hidden');
    if (data.found) {
      resultSource.textContent = `Found in: ${data.form_name}`;
      resultAnswer.textContent = `"${data.answer}"`;
    } else {
      resultSource.textContent = 'No Match';
      resultAnswer.textContent = data.message;
    }
  } catch (err) {
    console.error('Ask query error:', err);
  } finally {
    btnAsk.textContent = 'Ask Memoro';
    btnAsk.disabled = false;
  }
});

// Auto-sync every 4 seconds
setInterval(() => {
  fetchRecords();
}, 4000);

updateVaultUI();
fetchRecords();