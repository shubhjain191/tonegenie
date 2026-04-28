let loadedPersonaLibrary = {};
let usageRefreshInterval = null;

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const targetTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById(`${targetTab}-tab`).classList.add('active');
  });
});

function showStatus(message, type) {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
  statusDiv.style.display = 'block';
}

function formatUsageDateKey(dateInput = new Date()) {
  const date = new Date(dateInput);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.floor((ms || 0) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function sumLastNDays(usage, days, includeToday = true) {
  let total = 0;
  const startOffset = includeToday ? 0 : 1;
  for (let i = startOffset; i < days + startOffset; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = formatUsageDateKey(date);
    total += usage[key] || 0;
  }
  return total;
}

async function refreshUsageSummaryDisplay() {
  const data = await chrome.storage.local.get(['xDailyUsageMs']);
  const usage = data.xDailyUsageMs || {};
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayKey = formatUsageDateKey(yesterdayDate);

  const yesterdayMs = usage[yesterdayKey] || 0;
  const last7DaysMs = sumLastNDays(usage, 7, true);
  const last30DaysMs = sumLastNDays(usage, 30, true);

  const yesterdayEl = document.getElementById('yesterdayUsageTime');
  const last7El = document.getElementById('last7DaysUsageTime');
  const last30El = document.getElementById('last30DaysUsageTime');

  if (yesterdayEl) yesterdayEl.textContent = `Yesterday: ${formatDuration(yesterdayMs)}`;
  if (last7El) last7El.textContent = `Last 7 days: ${formatDuration(last7DaysMs)}`;
  if (last30El) last30El.textContent = `Last 30 days: ${formatDuration(last30DaysMs)}`;
}

async function notifyTwitterTabs(action = 'apiKeyUpdated') {
  const tabs = await chrome.tabs.query({ url: ['*://twitter.com/*', '*://x.com/*'] });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { action }).catch(() => {
      // Tab might not have content script loaded yet.
    });
  }
}

function isValidPersonaProfile(profile) {
  return Boolean(
    profile &&
    typeof profile === 'object' &&
    typeof profile.handle === 'string' &&
    profile.handle.trim() &&
    typeof profile.tone === 'string'
  );
}

function normalizePersonaProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const handleRaw = (profile.handle || '').toString().trim();
  const handle = handleRaw.startsWith('@') ? handleRaw : (handleRaw ? `@${handleRaw}` : '');
  if (!handle || typeof profile.tone !== 'string') return null;

  return {
    ...profile,
    handle,
    displayName: (profile.displayName || handle).toString().trim(),
    tone: (profile.tone || '').toString().trim(),
    niche: (profile.niche || '').toString().trim(),
    avoids: Array.isArray(profile.avoids) ? profile.avoids.map(v => (v || '').toString().trim()).filter(Boolean) : [],
    signaturePatterns: Array.isArray(profile.signaturePatterns) ? profile.signaturePatterns.map(v => (v || '').toString().trim()).filter(Boolean) : [],
    hookTypes: Array.isArray(profile.hookTypes) ? profile.hookTypes.map(v => (v || '').toString().trim()).filter(Boolean) : [],
    examples: Array.isArray(profile.examples) ? profile.examples.map(v => (v || '').toString().trim()).filter(Boolean) : []
  };
}

function renderPersonaDropdown(activePersonaHandle = '') {
  const personaSelect = document.getElementById('personaSelect');
  const personaCount = document.getElementById('personaCount');
  personaSelect.innerHTML = '<option value="">No profile selected</option>';

  const entries = Object.values(loadedPersonaLibrary)
    .filter(isValidPersonaProfile)
    .sort((a, b) => (a.displayName || a.handle).localeCompare(b.displayName || b.handle));

  entries.forEach((profile) => {
    const opt = document.createElement('option');
    opt.value = profile.handle;
    opt.textContent = `${profile.displayName || profile.handle} (${profile.handle})`;
    personaSelect.appendChild(opt);
  });

  if (activePersonaHandle && loadedPersonaLibrary[activePersonaHandle]) {
    personaSelect.value = activePersonaHandle;
  }

  personaCount.textContent = `Profiles loaded: ${entries.length}`;
}

async function loadBundledPersonaLibrary() {
  try {
    const indexUrl = chrome.runtime.getURL('personas/index.json');
    const indexRes = await fetch(indexUrl);
    if (!indexRes.ok) {
      return {};
    }

    const indexData = await indexRes.json();
    const files = Array.isArray(indexData.files) ? indexData.files : [];
    const library = {};
    let invalidCount = 0;

    for (const fileName of files) {
      if (!fileName || typeof fileName !== 'string') continue;
      const fileUrl = chrome.runtime.getURL(`personas/${fileName}`);
      try {
        const fileRes = await fetch(fileUrl);
        if (!fileRes.ok) continue;
        const profile = await fileRes.json();
        const normalized = normalizePersonaProfile(profile);
        if (isValidPersonaProfile(normalized)) {
          library[normalized.handle] = normalized;
        } else {
          invalidCount++;
        }
      } catch (e) {
        invalidCount++;
      }
    }
    if (invalidCount > 0) {
      showStatus(`Skipped ${invalidCount} invalid persona file(s).`, 'error');
    }
    return library;
  } catch (error) {
    return {};
  }
}

async function initializePopup() {
  const stored = await chrome.storage.local.get([
    'apiKey',
    'openRouterKey',
    'userPersona',
    'personaLibrary',
    'activePersonaHandle'
  ]);

  if (stored.apiKey) document.getElementById('apiKey').value = stored.apiKey;
  if (stored.openRouterKey) document.getElementById('openRouterKey').value = stored.openRouterKey;
  if (stored.userPersona) document.getElementById('userPersona').value = stored.userPersona;

  const bundledLibrary = await loadBundledPersonaLibrary();
  loadedPersonaLibrary = Object.keys(bundledLibrary).length > 0
    ? bundledLibrary
    : (stored.personaLibrary || {});

  let activePersonaHandle = stored.activePersonaHandle || '';
  if (activePersonaHandle && !loadedPersonaLibrary[activePersonaHandle]) {
    activePersonaHandle = '';
  }
  if (!activePersonaHandle && Object.keys(loadedPersonaLibrary).length > 0) {
    activePersonaHandle = Object.keys(loadedPersonaLibrary)[0];
  }

  renderPersonaDropdown(activePersonaHandle);

  await chrome.storage.local.set({
    personaLibrary: loadedPersonaLibrary,
    activePersonaHandle
  });

  await refreshUsageSummaryDisplay();
  if (usageRefreshInterval) {
    clearInterval(usageRefreshInterval);
  }
  usageRefreshInterval = setInterval(refreshUsageSummaryDisplay, 30000);
}

document.getElementById('personaSelect').addEventListener('change', async (e) => {
  const activePersonaHandle = e.target.value || '';
  await chrome.storage.local.set({ activePersonaHandle });
  await notifyTwitterTabs('personasUpdated');
  showStatus('Persona profile updated.', 'success');
});

// Save button handler
document.getElementById('saveBtn').addEventListener('click', async () => {
  const apiKey = document.getElementById('apiKey').value.trim();
  const openRouterKey = document.getElementById('openRouterKey').value.trim();
  const userPersona = document.getElementById('userPersona').value.trim();
  const activePersonaHandle = document.getElementById('personaSelect').value || '';
  const btn = document.getElementById('saveBtn');

  if (!apiKey) {
    showStatus('Please enter your Groq API key', 'error');
    return;
  }

  if (!apiKey.startsWith('gsk_')) {
    showStatus('Invalid Groq API key format. Should start with "gsk_"', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error('Invalid Groq API key');
    }

    await chrome.storage.local.set({
      apiKey,
      openRouterKey,
      userPersona,
      personaLibrary: loadedPersonaLibrary,
      activePersonaHandle
    });

    await notifyTwitterTabs('apiKeyUpdated');
    showStatus('✓ Settings saved! Persona + API are active on Twitter/X.', 'success');
  } catch (error) {
    showStatus('Invalid API key. Please check and try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Activate';
  }
});

initializePopup().catch(() => {
  showStatus('Could not load persona profiles. Check personas/index.json', 'error');
});

window.addEventListener('beforeunload', () => {
  if (usageRefreshInterval) {
    clearInterval(usageRefreshInterval);
  }
});
