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
