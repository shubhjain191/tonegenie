// Background service worker for future features
// Currently minimal, but can be extended for:
// - Caching API responses
// - Managing API rate limits
// - Cross-tab communication

chrome.runtime.onInstalled.addListener(() => {
    console.log('tonegenie installed!');
  });
  
  // Listen for messages from content scripts or popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'checkApiKey') {
      chrome.storage.local.get(['apiKey'], (result) => {
        sendResponse({ hasKey: !!result.apiKey });
      });
      return true;
    }
  });