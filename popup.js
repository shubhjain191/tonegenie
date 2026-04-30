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

function setupSecretFieldControls(inputId, toggleId, copyId, fieldName) {
  const input = document.getElementById(inputId);
  const toggleBtn = document.getElementById(toggleId);
  const copyBtn = document.getElementById(copyId);
  if (!input || !toggleBtn || !copyBtn) return;

  toggleBtn.addEventListener('click', () => {
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    toggleBtn.textContent = isHidden ? '🙈' : '👁️';
    toggleBtn.title = isHidden ? `Hide ${fieldName}` : `Show ${fieldName}`;
    toggleBtn.setAttribute('aria-label', toggleBtn.title);
  });

  copyBtn.addEventListener('click', async () => {
    const value = input.value.trim();
    if (!value) {
      showStatus(`Enter ${fieldName} first`, 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      showStatus(`${fieldName} copied to clipboard`, 'success');
    } catch {
      showStatus(`Could not copy ${fieldName}`, 'error');
    }
  });
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


async function initializePopup() {
  setupSecretFieldControls('apiKey', 'toggleApiKey', 'copyApiKey', 'Groq API key');
  setupSecretFieldControls('openRouterKey', 'toggleOpenRouterKey', 'copyOpenRouterKey', 'OpenRouter API key');

  const stored = await chrome.storage.local.get([
    'apiKey',
    'openRouterKey'
  ]);

  if (stored.apiKey) document.getElementById('apiKey').value = stored.apiKey;
  if (stored.openRouterKey) document.getElementById('openRouterKey').value = stored.openRouterKey;


  await refreshUsageSummaryDisplay();
  if (usageRefreshInterval) {
    clearInterval(usageRefreshInterval);
  }
  usageRefreshInterval = setInterval(refreshUsageSummaryDisplay, 30000);
}


// Save button handler
document.getElementById('saveBtn').addEventListener('click', async () => {
  const apiKey = document.getElementById('apiKey').value.trim();
  const openRouterKey = document.getElementById('openRouterKey').value.trim();
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
      openRouterKey
    });

    await notifyTwitterTabs('apiKeyUpdated');
    showStatus('✓ Settings saved! API is active on Twitter/X.', 'success');
  } catch (error) {
    showStatus('Invalid API key. Please check and try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Activate';
  }
});

initializePopup().catch(() => {
  showStatus('Could not initialize popup settings.', 'error');
});

window.addEventListener('beforeunload', () => {
  if (usageRefreshInterval) {
    clearInterval(usageRefreshInterval);
  }
});
