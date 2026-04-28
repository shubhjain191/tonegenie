let apiKey = null;
let userPersona = '';

// Rate limiting and request tracking
let requestQueue = [];
let isProcessingQueue = false;
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 3000; // 3 second between requests
const MAX_REQUESTS_PER_MINUTE = 30; // Conservative limit
let requestTimestamps = [];

// Fast, up-to-date Groq models only (2-3 models for speed and reliability)
const FREE_MODELS = [
  'llama-3.1-8b-instant',                          // fastest, great for short comments
  'llama-3.3-70b-versatile',                        // best quality general
  'meta-llama/llama-4-scout-17b-16e-instruct',      // 500K context, solid
  'groq/compound-mini',                             // groq native, fast
  'groq/compound',                                  // groq native, higher quality
  'qwen/qwen3-32b',                                 // 500K context
  'moonshotai/kimi-k2-instruct',                    // 300K context
  'moonshotai/kimi-k2-instruct-0905',               // 300K context alternate
  'openai/gpt-oss-20b',                             // 200K context
  'openai/gpt-oss-120b',                            // 200K context, highest cap
  'allam-2-7b',                                     // lightweight fallback
];


const STYLE_KEYS = [
  'funny',
  'friendly',
  'supportive',
  'sarcastic',
  'enthusiastic',
  'analytical',
  'professional',
  'dataDriven',
  'thoughtful',
  'relatable',
  'agree',
  'disagree',
  'conversational',
  'inspirational',
  'hinglish',
  'birthdayWish',
  'question'
];

const STYLE_FALLBACK_ORDER = [
  'friendly',
  'supportive',
  'analytical',
  'professional',
  'relatable',
  'funny'
];

function normalizeStyleToken(token) {
  if (!token) return '';
  return token
    .toString()
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

const STYLE_ALIAS_MAP = (() => {
  const baseAliases = {
    funny: ['humorous', 'humor', 'witty', 'playful'],
    friendly: ['kind', 'approachable', 'warm'],
    supportive: ['encouraging', 'uplifting', 'cheerleader'],
    sarcastic: ['snarky', 'ironic', 'sarcasm'],
    enthusiastic: ['excited', 'energetic', 'hype'],
    analytical: ['analysis', 'insightful', 'logical'],
    professional: ['formal', 'business', 'corporate'],
    dataDriven: ['data driven', 'data-driven', 'datadriven', 'evidence based', 'data backed'],
    thoughtful: ['reflective', 'considerate', 'deep'],
    relatable: ['down to earth', 'relatable', 'everyday'],
    agree: ['agreement', 'yeah', 'totally'],
    disagree: ['counterpoint', 'pushback', 'disagreeing'],
    conversational: ['conversation', 'chatty', 'dialogue'],
    inspirational: ['motivational', 'inspire', 'uplifting'],
    hinglish: ['hindi english', 'indianglish', 'hing-lish'],
    birthdayWish: ['birthday', 'bday', 'birthday wish', 'happy birthday'],
    question: ['ask', 'inquire', 'query', 'questioning', 'curious']
  };

  const normalizedMap = {};

  STYLE_KEYS.forEach((style) => {
    const aliases = new Set();
    aliases.add(style);
    aliases.add(style.replace(/[A-Z]/g, match => ` ${match.toLowerCase()}`));
    (baseAliases[style] || []).forEach(alias => aliases.add(alias));
    normalizedMap[style] = Array.from(aliases)
      .map(normalizeStyleToken)
      .filter(Boolean);
  });

  return normalizedMap;
})();

function matchStyleFromToken(token) {
  const normalized = normalizeStyleToken(token);
  if (!normalized) return null;

  for (const style of STYLE_KEYS) {
    const aliases = STYLE_ALIAS_MAP[style] || [];
    if (aliases.some(alias => alias && (normalized === alias || normalized.includes(alias) || alias.includes(normalized)))) {
      return style;
    }
  }

  return null;
}

function sanitizeStyleArray(values) {
  if (!Array.isArray(values)) return [];
  const result = [];
  const seen = new Set();

  values.forEach((value) => {
    const style = matchStyleFromToken(value);
    if (style && !seen.has(style)) {
      result.push(style);
      seen.add(style);
    }
  });

  return result;
}

function finalizeStyleList(initialStyles) {
  if (!Array.isArray(initialStyles) || initialStyles.length === 0) {
    return [];
  }

  const result = [];
  const seen = new Set();

  initialStyles.forEach((style) => {
    if (STYLE_KEYS.includes(style) && !seen.has(style)) {
      result.push(style);
      seen.add(style);
    }
  });

  if (result.length === 0) {
    return [];
  }

  for (const fallbackStyle of STYLE_FALLBACK_ORDER) {
    if (result.length >= 3) break;
    if (!seen.has(fallbackStyle)) {
      result.push(fallbackStyle);
      seen.add(fallbackStyle);
    }
  }

  return result.slice(0, 3);
}

function resolveStyleSuggestionsFromText(content) {
  if (!content) return [];

  const matches = [];
  const seen = new Set();
  const tryAdd = (style) => {
    if (style && !seen.has(style)) {
      matches.push(style);
      seen.add(style);
    }
  };

  const segments = content
    .split(/[\n\r,;•\-]+/)
    .map(segment => segment.trim())
    .filter(Boolean);

  segments.forEach((segment) => {
    const directMatch = matchStyleFromToken(segment);
    if (directMatch) {
      tryAdd(directMatch);
      return;
    }

    segment.split(/\s+/).forEach((word) => {
      if (word.length <= 1) return;
      const wordMatch = matchStyleFromToken(word);
      if (wordMatch) {
        tryAdd(wordMatch);
      }
    });
  });

  const normalizedContent = normalizeStyleToken(content);

  if (matches.length < 3 && normalizedContent) {
    STYLE_KEYS.forEach((style) => {
      if (matches.length >= 3) return;
      const aliases = STYLE_ALIAS_MAP[style] || [];
      if (aliases.some(alias => alias && normalizedContent.includes(alias))) {
        tryAdd(style);
      }
    });
  }

  return matches;
}

let currentModelIndex = 0;
let rateLimitedModels = new Set(); // Track which models are rate limited
const RATE_LIMIT_COOLDOWN = 60000; // 1 minute cooldown for rate limited models
let modelRateLimitTimes = {}; // Track when models were rate limited

// Clean old timestamps every minute
setInterval(() => {
  const oneMinuteAgo = Date.now() - 60000;
  requestTimestamps = requestTimestamps.filter(timestamp => timestamp > oneMinuteAgo);
  
  // Check if rate limited models can be retried
  const now = Date.now();
  for (const [model, limitedTime] of Object.entries(modelRateLimitTimes)) {
    if (now - limitedTime > RATE_LIMIT_COOLDOWN) {
      rateLimitedModels.delete(model);
      delete modelRateLimitTimes[model];
      console.log(`tonegenie: Model ${model} is available again`);
    }
  }
}, 30000);

// Load API key on page load
chrome.storage.local.get(['apiKey', 'userPersona'], (result) => {
  if (result.apiKey) {
    apiKey = result.apiKey;
    userPersona = result.userPersona || '';
    console.log('tonegenie: API key loaded');
    initExtension();
  } else {
    console.log('tonegenie: No API key found');
  }
});

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'apiKeyUpdated') {
    chrome.storage.local.get(['apiKey', 'userPersona'], (result) => {
      apiKey = result.apiKey;
      userPersona = result.userPersona || '';
      console.log('tonegenie: API key updated');
      initExtension();
      initComposeFeatures();
      sendResponse({ success: true });
    });
    return true;
    }
  
  if (request.action === 'getTrendingTopics') {
    const topics = getTrendingTopics();
    sendResponse({ success: true, topics: topics });
    return true;
  }
  
  if (request.action === 'insertContent') {
    insertContentIntoCompose(request.content).then(success => {
      sendResponse({ success: success });
    }).catch(() => {
      sendResponse({ success: false });
    });
    return true;
  }
});

function initExtension() {
  if (!apiKey) return;
  
  console.log('tonegenie: Initializing...');
  
  // Initialize sidebar (create it, but don't show yet)
  createSidebar();
  
  // Clean up old opportunities every 5 minutes
  setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    for (const [tweetId, data] of earlyReplyOpportunities.entries()) {
      if (now - data.timestamp > maxAge) {
        earlyReplyOpportunities.delete(tweetId);
      }
    }
    if (earlyReplyOpportunities.size > 0) {
      updateSidebar();
    }
  }, 5 * 60 * 1000);
  
  // Scan and inject buttons
  scanAndInject();
  
  // Initialize compose box features (hashtag suggestions)
  initComposeFeatures();
  
  // Watch for new containers (like Whisper AI does)
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node;
            const container = 'article[data-testid="tweet"], article[role="article"]';
            // Check if added node is a container or contains containers
            if (element.matches && element.matches(container)) {
              injectIntoContainer(element);
            } else if (element.querySelectorAll) {
              element.querySelectorAll(container).forEach(container => {
                injectIntoContainer(container);
              });
            }
          }
        });
      }
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  console.log('tonegenie: Observer started');
}

function scanAndInject() {
  if (!apiKey) return;
  
  const container = 'article[data-testid="tweet"], article[role="article"]';
  console.log(`tonegenie: Looking for containers with selector: ${container}`);
  
  const containers = document.querySelectorAll(container);
  console.log(`tonegenie: Found ${containers.length} containers`);
  
  containers.forEach(container => {
    injectIntoContainer(container);
  });
}

async function analyzeTweetAndSuggestStyles(tweetText) {
  if (!apiKey || !tweetText || tweetText.trim().length < 10) {
    return null;
  }
  
  try {
    const prompt = `Analyze this tweet and suggest the TOP 3 most appropriate comment styles from this list:

Available styles: funny, friendly, supportive, sarcastic, enthusiastic, analytical, professional, dataDriven, thoughtful, relatable, agree, disagree, conversational, inspirational, hinglish, birthdayWish

Tweet: "${tweetText}"

Instructions:
- Analyze the tweet's topic, tone, and context
- Consider: Is it professional/casual? Serious/funny? Emotional? Controversial?
- Select the 3 BEST fitting styles that would generate the most appropriate and engaging comments
- Return ONLY a JSON array of exactly 3 style names, like: ["professional", "analytical", "dataDriven"]
- Be smart: If tweet is about birthday → include "birthdayWish"
- If tweet is professional → include "professional", "analytical", or "dataDriven"
- If tweet is funny → include "funny" or "sarcastic"
- If tweet is emotional → include "supportive", "thoughtful", or "relatable"

Return ONLY the JSON array, nothing else.`;

    const initialModel = getNextAvailableModel();
    const response = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: initialModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3, // Lower temperature for more consistent suggestions
        max_tokens: 100,
        top_p: 1
      })
    }, 2, initialModel); // Only 2 retries for suggestions to keep it fast

    const data = await response.json();
    const content = data.choices[0].message.content.trim();
    
    // Try to parse JSON from response
    let parsedSuggestions = [];
    try {
      // Extract JSON array from response
      const jsonMatch = content.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        parsedSuggestions = sanitizeStyleArray(JSON.parse(jsonMatch[0]));
      } else {
        parsedSuggestions = sanitizeStyleArray(JSON.parse(content));
      }
    } catch (e) {
      console.log('tonegenie: Could not parse suggestions JSON:', e);
    }

    if (parsedSuggestions.length > 0) {
      const finalized = finalizeStyleList(parsedSuggestions);
      if (finalized.length === 3) {
        return finalized;
      }
    }

    const fallbackMatches = resolveStyleSuggestionsFromText(content);
    if (fallbackMatches.length > 0) {
      const finalizedFallback = finalizeStyleList(fallbackMatches);
      if (finalizedFallback.length === 3) {
        console.log('tonegenie: Suggestions recovered via text fallback:', finalizedFallback);
        return finalizedFallback;
      }
    }

    const defaultSuggestions = finalizeStyleList(STYLE_FALLBACK_ORDER.slice(0, 3));
    if (defaultSuggestions.length === 3) {
      console.log('tonegenie: Could not parse suggestions, using fallback defaults');
      return defaultSuggestions;
    }

    return null;
  } catch (error) {
    console.log('tonegenie: Error analyzing tweet for suggestions:', error);
    return null;
  }
}

function injectIntoContainer(container) {
  if (!container || container.querySelector('.ai-comment-buttons')) {
    return;
  }

  // Find reply button (same as Whisper AI)
  const replyButton = container.querySelector('[data-testid="reply"], [aria-label*="Reply"], [aria-label*="reply"]');
  
  if (!replyButton) {
    return;
  }

  console.log('tonegenie: Found reply button in container');

  // Find the row that contains the reply button (exactly like Whisper AI)
  const row = replyButton.closest('div[role="group"]') || replyButton.parentElement;
  
  if (!row || !row.parentNode) {
    console.log('tonegenie: Could not find row or parent');
    return;
  }

  // Calculate margin-left to align with reply button (like Whisper AI)
  const marginLeft = Math.max(8, replyButton.getBoundingClientRect().left - row.getBoundingClientRect().left);

  // Extract tweet text for analysis
  const contentSelector = '[data-testid="tweetText"], article div[lang]';
  const contentElement = container.querySelector(contentSelector);
  const tweetText = contentElement ? (contentElement.textContent || '').trim() : '';

  // Create sentiment buttons container (like Whisper AI)
  const buttonsContainer = document.createElement('div');
  buttonsContainer.className = 'ai-comment-buttons';
  buttonsContainer.style.cssText = `
    display: flex;
    align-items: center;
    margin-top: 8px;
    margin-left: ${marginLeft}px;
    padding-bottom: 4px;
    flex-wrap: wrap;
    gap: 6px;
    row-gap: 4px;
  `;

  // Create suggested styles label (will be shown when suggestions arrive)
  const suggestedLabel = document.createElement('div');
  suggestedLabel.style.cssText = `
    display: none;
    font-size: 10px;
    font-weight: 600;
    color: #16a34a;
    margin-bottom: 4px;
    margin-left: ${marginLeft}px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `;
  suggestedLabel.textContent = '✨ Suggested for this tweet';
  suggestedLabel.className = 'ai-suggested-label';

  // Store suggested styles (will be set async)
  let suggestedStylesSet = new Set();

  // Button styles - selected options
  const buttonStyles = {
    funny: { emoji: '😂', text: 'funny' },
    friendly: { emoji: '😊', text: 'friendly' },
    supportive: { emoji: '💪', text: 'supportive' },
    sarcastic: { emoji: '😏', text: 'sarcastic' },
    enthusiastic: { emoji: '🎉', text: 'enthusiastic' },
    analytical: { emoji: '🧠', text: 'analytical' },
    professional: { emoji: '💼', text: 'professional' },
    dataDriven: { emoji: '📊', text: 'data-driven' },
    thoughtful: { emoji: '💭', text: 'thoughtful' },
    relatable: { emoji: '✨', text: 'relatable' },
    agree: { emoji: '👍', text: 'agree' },
    disagree: { emoji: '👎', text: 'disagree' },
    conversational: { emoji: '💬', text: 'conversational' },
    inspirational: { emoji: '💫', text: 'inspirational' },
    hinglish: { emoji: '🇮🇳', text: 'hinglish' },
    birthdayWish: { emoji: '🎂', text: 'birthday wish' },
    question: { emoji: '❓', text: 'question' },
  };

  // Helper function to check if style is suggested
  const isSuggested = (style) => suggestedStylesSet.has(style);

  // Helper function to update button highlighting
  const updateButtonHighlight = (button, style) => {
    if (isSuggested(style)) {
      button.style.cssText = `
        background-color: rgba(34, 197, 94, 0.2);
        color: #16a34a;
        border: 2px solid #16a34a;
        border-radius: 16px;
        padding: 0 8px;
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
        margin-right: 6px;
        margin-bottom: 4px;
        transition: all 0.2s;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        line-height: 1;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        white-space: nowrap;
        box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.15);
      `;
    } else {
      button.style.cssText = `
        background-color: rgba(29, 155, 240, 0.1);
        color: #1d9bf0;
        border: 1px solid #1d9bf0;
        border-radius: 16px;
        padding: 0 8px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        margin-right: 6px;
        margin-bottom: 4px;
        transition: all 0.2s;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        line-height: 1;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        white-space: nowrap;
      `;
    }
  };

  // Create buttons (like Whisper AI sentiment buttons)
  const buttonElements = new Map(); // Store buttons for later updates
  
  Object.entries(buttonStyles).forEach(([style, { emoji, text }]) => {
    const button = document.createElement('button');
    button.className = 'ai-style-btn';
    button.dataset.style = style;
    
    // Set initial style (will be updated if suggested)
    updateButtonHighlight(button, style);
    
    buttonElements.set(style, button);

    const inner = document.createElement('p');
    inner.style.cssText = `
      display: flex;
      align-items: center;
      gap: 3px;
      margin: 0;
      padding: 0;
      font-size: 11px;
    `;

    const emojiSpan = document.createElement('span');
    emojiSpan.textContent = emoji;

    const textSpan = document.createElement('span');
    textSpan.textContent = text.toLowerCase();

    inner.appendChild(emojiSpan);
    inner.appendChild(textSpan);
    button.appendChild(inner);

    // Hover effects
    button.addEventListener('mouseover', () => {
      if (isSuggested(style)) {
        button.style.backgroundColor = 'rgba(34, 197, 94, 0.3)';
      } else {
        button.style.backgroundColor = 'rgba(29, 155, 240, 0.2)';
      }
    });

    button.addEventListener('mouseout', () => {
      updateButtonHighlight(button, style);
    });

    // Click handler
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handleButtonClick(e, container, style);
    });

    buttonsContainer.appendChild(button);
  });

  // Start async analysis for suggestions
  if (tweetText.length > 10 && apiKey) {
    // Analyze and suggest styles
    analyzeTweetAndSuggestStyles(tweetText).then(suggestions => {
      if (suggestions && Array.isArray(suggestions) && suggestions.length === 3) {
        suggestedStylesSet = new Set(suggestions);
        console.log('tonegenie: Suggested styles:', suggestions);
        
        // Update all buttons to highlight suggested ones
        buttonElements.forEach((button, style) => {
          updateButtonHighlight(button, style);
        });
        
        // Show suggested label
        if (suggestedLabel.parentNode) {
          suggestedLabel.style.display = 'block';
        }
      }
    }).catch(error => {
      console.log('tonegenie: Could not get suggestions:', error);
    });
  }

  // Check for early reply opportunity and register it (no inline alert)
  const earlyReplyOpportunity = isEarlyReplyOpportunity(container);
  
  if (earlyReplyOpportunity) {
    console.log('tonegenie: Early reply opportunity detected:', earlyReplyOpportunity);
    registerEarlyReplyOpportunity(container, earlyReplyOpportunity);
  }

  // Insert BELOW the row (exactly like Whisper AI)
  if (row.parentNode) {
    const nextSibling = row.nextSibling;
    
    row.parentNode.insertBefore(buttonsContainer, nextSibling);
    row.parentNode.insertBefore(suggestedLabel, buttonsContainer);
    
    console.log('tonegenie: ✅ Buttons injected successfully');
  }
}

async function handleButtonClick(e, container, style) {
  if (!apiKey) {
    console.error('tonegenie: No API key');
    return;
  }

  const button = e.currentTarget;
  const originalContent = button.innerHTML;
  
  // Loading state
  button.innerHTML = '<span style="opacity: 0.7">Generating...</span>';
  button.style.cursor = 'default';

  try {
    // Find tweet content
    const contentSelector = '[data-testid="tweetText"], article div[lang]';
    const contentElement = container.querySelector(contentSelector);
    
    if (!contentElement) {
      throw new Error('Could not find post content');
    }

    const tweetText = contentElement.textContent || '';
    if (!tweetText.trim()) {
      throw new Error('Post content is empty');
    }

    // Generate comment
    const comment = await generateComment(tweetText, style);

    // Find reply button and click it
    const replyButton = container.querySelector('[data-testid="reply"], [aria-label*="Reply"], [aria-label*="reply"]');
    if (!replyButton) {
      throw new Error('Reply button not found');
    }

    replyButton.click();

    // Wait for reply box to appear and insert comment
    setTimeout(async () => {
      try {
        await insertIntoTwitter('[data-testid="tweetTextarea_0"], div[contenteditable="true"][data-testid*="tweetTextarea"]', comment);
        
        button.innerHTML = '<span style="color: #1d9bf0">Done!</span>';
        setTimeout(() => {
          button.innerHTML = originalContent;
          button.style.cursor = 'pointer';
        }, 2000);
      } catch (error) {
        console.error('tonegenie: Error inserting comment:', error);
        button.innerHTML = '<span style="color: #e0245e">Try again</span>';
        setTimeout(() => {
          button.innerHTML = originalContent;
          button.style.cursor = 'pointer';
        }, 2000);
      }
    }, 500);

  } catch (error) {
    console.error('tonegenie: Error:', error);
    
    // Handle rate limit errors specifically
    let errorMessage = 'Try again';
    if (error.message.includes('rate limit') || error.message.includes('Rate limit')) {
      errorMessage = 'Rate limited - wait a moment';
    } else if (error.message.includes('429')) {
      errorMessage = 'Too many requests - wait';
    } else {
      errorMessage = error.message.length > 30 ? 'Error occurred' : error.message;
    }
    
    button.innerHTML = `<span style="color: #e0245e">${errorMessage}</span>`;
    setTimeout(() => {
      button.innerHTML = originalContent;
      button.style.cursor = 'pointer';
    }, 3000);
  }
}

// Rate limiting helper
async function waitForRateLimit() {
  const now = Date.now();
  
  // Check if we've hit the per-minute limit
  if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    const oldestRequest = requestTimestamps[0];
    const waitTime = 60000 - (now - oldestRequest);
    if (waitTime > 0) {
      console.log(`tonegenie: Rate limit reached, waiting ${Math.ceil(waitTime/1000)}s`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  
  // Ensure minimum interval between requests
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastRequestTime = Date.now();
  requestTimestamps.push(lastRequestTime);
}

// Get next available model
function getNextAvailableModel() {
  // Filter out rate limited models
  const availableModels = FREE_MODELS.filter(model => !rateLimitedModels.has(model));
  
  if (availableModels.length === 0) {
    // All models are rate limited, reset and use first one
    console.log('tonegenie: All models rate limited, resetting...');
    rateLimitedModels.clear();
    modelRateLimitTimes = {};
    return FREE_MODELS[0];
  }
  
  // Find current model in available list
  const currentModel = FREE_MODELS[currentModelIndex];
  if (availableModels.includes(currentModel)) {
    return currentModel;
  }
  
  // Current model is rate limited, switch to next available
  const currentAvailableIndex = availableModels.indexOf(currentModel);
  if (currentAvailableIndex === -1) {
    // Current model not in available list, use first available
    currentModelIndex = FREE_MODELS.indexOf(availableModels[0]);
    return availableModels[0];
  }
  
  // Use next available model
  const nextIndex = (currentAvailableIndex + 1) % availableModels.length;
  const nextModel = availableModels[nextIndex];
  currentModelIndex = FREE_MODELS.indexOf(nextModel);
  return nextModel;
}

// Retry with exponential backoff and model fallback
async function fetchWithRetry(url, options, maxRetries = 3, model = null) {
  if (!model) {
    model = getNextAvailableModel();
  }
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await waitForRateLimit();
      
      // Update model in request body
      const requestBody = JSON.parse(options.body);
      requestBody.model = model;
      options.body = JSON.stringify(requestBody);
      
      console.log(`tonegenie: Using model: ${model}`);
      
      const response = await fetch(url, options);
      
      if (response.status === 429) {
        // Rate limit error - mark this model as rate limited and try next model
        console.log(`tonegenie: Model ${model} rate limited, switching to next model`);
        rateLimitedModels.add(model);
        modelRateLimitTimes[model] = Date.now();
        
        // Try next available model
        const nextModel = getNextAvailableModel();
        if (nextModel !== model && !rateLimitedModels.has(nextModel)) {
          console.log(`tonegenie: Switching to model: ${nextModel}`);
          return await fetchWithRetry(url, options, maxRetries, nextModel);
        }
        
        // All models rate limited or no retries left
        const retryAfter = response.headers.get('Retry-After') || Math.pow(2, attempt) * 1000;
        if (attempt < maxRetries - 1) {
          console.log(`tonegenie: All models rate limited, waiting ${retryAfter}ms`);
          await new Promise(resolve => setTimeout(resolve, retryAfter));
          continue;
        } else {
          throw new Error('All models rate limited. Please wait a moment before trying again.');
        }
      }
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: 'API request failed' } }));
        throw new Error(error.error?.message || `API request failed: ${response.status}`);
      }
      
      // Success - reset model index if needed
      if (model !== FREE_MODELS[currentModelIndex]) {
        currentModelIndex = FREE_MODELS.indexOf(model);
      }
      
      return response;
    } catch (error) {
      if (error.message.includes('rate limit') || error.message.includes('Rate limit')) {
        // Mark model as rate limited
        rateLimitedModels.add(model);
        modelRateLimitTimes[model] = Date.now();
        
        // Try next model if available
        const nextModel = getNextAvailableModel();
        if (nextModel !== model && !rateLimitedModels.has(nextModel)) {
          console.log(`tonegenie: Error with ${model}, switching to: ${nextModel}`);
          return await fetchWithRetry(url, options, maxRetries, nextModel);
        }
      }
      
      if (attempt === maxRetries - 1) {
        throw error;
      }
      
      // Exponential backoff
      const backoffDelay = Math.pow(2, attempt) * 1000;
      console.log(`tonegenie: Request failed, retrying in ${backoffDelay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
}

async function generateComment(tweetText, style) {
  const styleDescriptions = {
    funny: 'funny and chill, lowkey witty',
    friendly: 'warm chill vibes, like texting a friend',
    supportive: 'uplifting bro energy, genuine but chill',
    sarcastic: 'witty lowkey sarcasm, dry humor',
    enthusiastic: 'hyped but not cringe, good energy',
    analytical: 'smart casual observation, pointing out details',
    professional: 'polite but relaxed, no corporate speak',
    dataDriven: 'using facts but keeping it casual text style',
    thoughtful: 'deep but casual thoughts, lowkey reflective',
    relatable: 'same feels, super relatable, mood',
    agree: 'totally agree, casual vibe, straight facts',
    disagree: 'nah, polite disagreement, chill counterpoint',
    conversational: 'casual chat, just talking, natural flow',
    inspirational: 'good vibes only, motivating but grounded',
    hinglish: 'mix of Hindi and English, natural Hinglish conversation style',
    birthdayWish: 'happy bday, warm and chill vibes',
    question: 'asking a relevant question, curious but casual'
  };

  // Special handling for Hinglish and Birthday
  const isHinglish = style === 'hinglish';
  const isBirthdayWish = style === 'birthdayWish';
  
  // Check if post mentions birthday
  const birthdayKeywords = ['birthday', 'turning', 'born on', 'turned', 'bday', 'happy birthday', 'wish', 'celebrating', 'age', 'years old', '🎂', '🎉'];
  const hasBirthdayContext = birthdayKeywords.some(keyword => 
    tweetText.toLowerCase().includes(keyword.toLowerCase())
  );
  
  // Get current date for 2025 context
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.toLocaleString('default', { month: 'long' });
  
  let prompt = `Read this tweet and write a real comment in a ${styleDescriptions[style]} style.

Tweet: "${tweetText}"

Write a comment that:
- Actually responds to what the tweet says
- Sounds like a real person typed it, not an AI
- Matches the energy of the tweet
- Does not make up facts, stats, or numbers
- Is between 150 and 200 characters
- Use sentence case (only capitalize the first word of the sentence, keep the rest lowercase)
- Keep punctuation to an absolute minimum (avoid exclamation marks, commas, or periods unless strictly needed)
- Uses your own words`;

  if (isBirthdayWish) {
    if (hasBirthdayContext) {
      prompt += `

its a birthday tweet so write a casual bday wish. warm but not over the top. one emoji max.`;
    } else {
      prompt += `

write a warm kind comment. chill energy. nothing dramatic.`;
    }
  } else {
    // Style-specific instructions
    if (style === 'funny') {
      prompt += ` be lowkey funny or witty. dont force it if the tweet isnt funny.`;
    } else if (style === 'dataDriven') {
      prompt += ` reference a fact or observation from the tweet if there is one. casual text style. no stiff language.`;
    } else if (style === 'analytical') {
      prompt += ` notice something specific about the tweet. talk like a person not a report.`;
    } else if (style === 'professional') {
      prompt += ` polite and real. no corporate tone. just respectful and grounded.`;
    } else if (style === 'supportive') {
      prompt += ` be genuinely encouraging. match the energy. no generic hype.`;
    } else if (style === 'sarcastic') {
      prompt += ` dry humor. lowkey sarcastic. dont be rude.`;
    } else if (style === 'enthusiastic') {
      prompt += ` hyped but grounded. good energy without shouting.`;
    } else if (style === 'thoughtful') {
      prompt += ` actually think about the tweet. say something real. keep it casual.`;
    } else if (style === 'friendly') {
      prompt += ` talk like youre texting a friend. warm and natural.`;
    } else if (style === 'relatable') {
      prompt += ` relate to it. be specific about why you get it.`;
    } else if (style === 'agree') {
      prompt += ` agree but say something specific not just yeah or facts.`;
    } else if (style === 'disagree') {
      prompt += ` push back calmly. say why but keep it chill.`;
    } else if (style === 'conversational') {
      prompt += ` just talk. casual minimal effort vibes. like a quick reply.`;
    } else if (style === 'inspirational') {
      prompt += ` motivating but grounded. no cheesy quotes. make it feel real.`;
    } else if (style === 'question') {
      prompt += ` ask one specific question about what they said. curious but chill.`;
    }
  }

  if (isHinglish) {
    prompt += ` write in Hinglish - mix hindi and english naturally like "yaar this is so true" or "bhai sahi baat hai". keep it casual and real.`;
  }

  prompt += `

Rules:
- use sentence case (only capitalize the first letter, rest lowercase)
- use minimal to no punctuation
- write like a real person texting
- 150 to 200 characters max
- vary your sentence rhythm naturally
- be specific not vague
- if it fits naturally use "i" not "one" or passive constructions

Before writing do a quick silent check: would a real person actually say this or does it sound assembled? fix it if needed.

Then write only the final comment. no quotes no explanations.`;

  // Start with best model, will automatically fallback if rate limited
  const initialModel = getNextAvailableModel();
  
  const response = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: initialModel,
      messages: [
        {
            role: 'system',
            content: `You are a real Twitter/X user writing short casual comments.${userPersona ? ' Your persona: ' + userPersona + '.' : ''}

Write in sentence case (only capitalize the first letter of the first word). Keep punctuation to an absolute minimum. Sound like a real person texting, not an AI.

Never use these AI writing patterns:
- Banned words: testament, pivotal, landscape, tapestry, underscore, vibrant, delve, garner, crucial, foster, showcase, highlight, intricate, enduring, groundbreaking, nestled, breathtaking, transformative, seamless, robust, synergy, leverage, impactful, key (as adjective)
- No em dashes — use commas or short sentences instead
- No bold text
- No rule-of-three lists (x y and z)
- No negative parallelism (not just x it is y)
- No -ing analysis phrases (highlighting, underscoring, showcasing, symbolizing, reflecting, contributing to)
- No promotional adjectives (breathtaking, vibrant, groundbreaking)
- No vague attributions (experts say, industry reports, observers note)
- No copula avoidance — write is not serves as or stands as
- No generic happy endings (the future looks bright, exciting times ahead)
- No filler (in order to, at this point in time, it is important to note)
- No over-hedging (could potentially possibly, might perhaps)
- No sycophantic openers (great question, absolutely, of course)
- No chatbot closers (hope this helps, let me know)

Do add real personality:
- Vary sentence length — mix short punchy and longer flowing
- Have a real take not just neutral reporting
- Use i when it fits naturally
- Be specific not vague
- Let some imperfection in — real people are not perfectly structured`
          },
        { role: 'user', content: prompt }
      ],
      temperature: 1.0,
      max_tokens: 150,
      top_p: 1
    })
  }, 3, initialModel);

  const data = await response.json();
  let comment = data.choices[0].message.content.trim();
  
  // Clean up the response - remove quotes, prefixes, and any system prompt text
  comment = comment.replace(/^["'](.*)["']$/s, '$1');
  comment = comment.replace(/^(comment|response|reply):\s*/i, '');
  comment = comment.replace(/^system prompt:/i, '');
  comment = comment.trim();
  
  // If somehow we got the prompt or system instructions, return a simple fallback
  const lowerComment = comment.toLowerCase();
  if (comment.length > 300 || (lowerComment.includes('write') && lowerComment.includes('comment'))) {
    comment = 'Interesting point!';
  }
  
  return comment;
}

async function insertIntoTwitter(selector, text) {
  let replyBox = null;
  
  if (selector) {
    replyBox = await waitForElement(selector, 5000);
  } else {
    // If no selector provided, use the current compose textarea
    replyBox = composeTextArea || document.querySelector('[data-testid="tweetTextarea_0"]') || 
               document.querySelector('div[contenteditable="true"][data-testid*="tweetTextarea"]');
  }
  
  if (!replyBox) {
    throw new Error('Reply box not found');
  }

  replyBox.focus();

  try {
    document.execCommand('insertText', false, text);
  } catch {
    // Fallback methods
    const cleanText = text.replace(/\s+$/, '');
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', cleanText);
      dataTransfer.setData('text/html', cleanText.replace(/\n/g, '<br>'));
      
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer
      });
      
      replyBox.dispatchEvent(pasteEvent);
      replyBox.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertFromPaste'
      }));
    } catch {
      replyBox.innerHTML = text;
      replyBox.dispatchEvent(new Event('input', {
        bubbles: true
      }));
    }
  }
}

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    let settled = false;
    let timerId;
    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (element) {
        settle(element);
      }
    });

    function settle(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timerId);
      observer.disconnect();
      resolve(result);
    }

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    timerId = setTimeout(() => settle(null), timeout);
  });
}

// ==================== TRENDING TOPICS & HASHTAGS ====================

function getTrendingTopics() {
  const topics = [];
  
  // Try to find trending topics in sidebar
  const trendingSelectors = [
    '[data-testid="sidebarColumn"] [data-testid="trend"]',
    '[data-testid="trend"]',
    'aside [role="complementary"] [data-testid="trend"]',
    'section[aria-label*="Trend"]',
    '[aria-label*="trending"]'
  ];
  
  for (const selector of trendingSelectors) {
    const elements = document.querySelectorAll(selector);
    elements.forEach(el => {
      const text = el.textContent?.trim();
      if (text && text.length > 0 && text.length < 100 && !topics.includes(text)) {
        // Clean up the text
        const cleanText = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleanText && !cleanText.includes('·') && !cleanText.toLowerCase().includes('trending')) {
          topics.push(cleanText);
        }
      }
    });
    
    if (topics.length >= 10) break;
  }
  
  // Also try to get from "What's happening" section
  const whatsHappening = document.querySelector('[aria-label*="What\'s happening"], [aria-label*="Trending"]');
  if (whatsHappening) {
    const trendItems = whatsHappening.querySelectorAll('[data-testid="trend"], [role="link"]');
    trendItems.forEach(item => {
      const text = item.textContent?.trim();
      if (text && text.length > 0 && text.length < 100) {
        const cleanText = text.split('\n')[0].trim();
        if (cleanText && !topics.includes(cleanText) && cleanText.length > 3) {
          topics.push(cleanText);
        }
      }
    });
  }
  
  // If no topics found, try alternative method
  if (topics.length === 0) {
    const allLinks = document.querySelectorAll('a[href*="/hashtag/"], a[href*="/search"]');
    allLinks.forEach(link => {
      const text = link.textContent?.trim();
      if (text && text.startsWith('#') && text.length < 50) {
        if (!topics.includes(text)) {
          topics.push(text);
        }
      }
    });
  }
  
  return topics.slice(0, 15); // Limit to 15 topics
}

let trendingHashtags = [];
let hashtagCacheTime = 0;
const HASHTAG_CACHE_DURATION = 60000; // 1 minute

async function getTrendingHashtags() {
  const now = Date.now();
  
  // Return cached hashtags if still fresh
  if (trendingHashtags.length > 0 && (now - hashtagCacheTime) < HASHTAG_CACHE_DURATION) {
    return trendingHashtags;
  }
  
  const hashtags = [];
  
  // Find hashtags from trending section
  const hashtagSelectors = [
    'a[href*="/hashtag/"]',
    'a[href*="/search?q=%23"]',
    '[data-testid="trend"] a'
  ];
  
  for (const selector of hashtagSelectors) {
    const elements = document.querySelectorAll(selector);
    elements.forEach(el => {
      const href = el.getAttribute('href');
      const text = el.textContent?.trim();
      
      if (href && (href.includes('/hashtag/') || href.includes('/search?q=%23'))) {
        // Extract hashtag from URL or text
        let hashtag = text;
        if (href.includes('/hashtag/')) {
          const match = href.match(/\/hashtag\/([^/?]+)/);
      if (match) {
            hashtag = '#' + decodeURIComponent(match[1]);
          }
        }
        
        if (hashtag && hashtag.startsWith('#') && hashtag.length < 50 && !hashtags.includes(hashtag)) {
          hashtags.push(hashtag);
        }
      }
    });
    
    if (hashtags.length >= 20) break;
  }
  
  // Cache the results
  trendingHashtags = hashtags.slice(0, 20);
  hashtagCacheTime = now;
  
  return trendingHashtags;
}

// ============ Sector/global trends helpers (no-key external sources) ============
const TONEGENIE_SECTOR_KEYWORDS = {
  'AI': ['ai', 'artificial intelligence', 'machine learning', 'ml', 'llm', 'gpt', 'llama', 'deep learning', 'nlp', 'genai', 'generative'],
  'Startups': ['startup', 'founder', 'founders', 'seed', 'pre-seed', 'series a', 'funding', 'bootstrap', 'pitch', 'yc', 'accelerator'],
  'Productivity': ['productivity', 'focus', 'time management', 'habits', 'notion', 'todo', 'calendar', 'workflow'],
  'SaaS': ['saas', 'subscriptions', 'b2b', 'mrr', 'arr', 'churn', 'retention', 'stripe', 'billing'],
  'Developer': ['developer', 'dev', 'programming', 'coding', 'javascript', 'python', 'typescript', 'webdev', 'api', 'framework', 'react', 'node', 'devops'],
  'CS Programming': ['computer science', 'cs', 'algorithms', 'data structures', 'operating systems', 'compiler', 'distributed', 'systems', 'programming'],
  'Generative AI Learning': ['prompt', 'fine-tune', 'rag', 'embedding', 'diffusion', 'sdxl', 'training', 'token', 'inference', 'quantization']
};

function filterTopicsBySector(topics, sector) {
  const keywords = (TONEGENIE_SECTOR_KEYWORDS[sector] || []).map(k => k.toLowerCase());
  if (keywords.length === 0) return topics;
  return topics.filter(t => {
    const s = (t || '').toLowerCase();
    return keywords.some(k => s.includes(k) || s.replace(/[#]/g, '').includes(k));
  });
}

async function fetchHNFrontPageTitles() {
  try {
    const res = await fetch('https://hn.algolia.com/api/v1/search?tags=front_page', { method: 'GET' });
    const data = await res.json();
    const titles = (data.hits || []).map(h => h.title).filter(Boolean);
    return titles.slice(0, 15);
  } catch (_) {
    return [];
  }
}

function sectorToSubreddits(sector) {
  switch (sector) {
    case 'AI':
    case 'Generative AI Learning':
      return ['MachineLearning', 'artificial', 'LocalLLaMA', 'StableDiffusion', 'deeplearning'];
    case 'Startups':
      return ['startups', 'Entrepreneur', 'SaaS'];
    case 'Productivity':
      return ['productivity', 'Notion'];
    case 'SaaS':
      return ['SaaS', 'Entrepreneur'];
    case 'Developer':
      return ['programming', 'webdev', 'devops', 'javascript', 'learnprogramming'];
    case 'CS Programming':
      return ['compsci', 'learnprogramming', 'algorithms'];
    default:
      return ['technology'];
  }
}

async function fetchRedditTitlesForSector(sector) {
  const subs = sectorToSubreddits(sector);
  const titles = [];
  await Promise.all(subs.map(async (sub) => {
    try {
      const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.json?limit=10&t=day`;
      const res = await fetch(url, { method: 'GET' });
      const data = await res.json();
      const t = (data.data?.children || []).map(c => c.data?.title).filter(Boolean);
      titles.push(...t);
    } catch (_) {
      // ignore
    }
  }));
  return titles.slice(0, 30);
}

async function getExternalTrends(source, sector) {
  if (source === 'sector') {
    const [hn, reddit] = await Promise.all([
      fetchHNFrontPageTitles(),
      fetchRedditTitlesForSector(sector)
    ]);
    let combined = [...hn, ...reddit];
    combined = filterTopicsBySector(combined, sector);
    return dedupeStrings(combined).slice(0, 20);
  } else {
    const hn = await fetchHNFrontPageTitles();
    return dedupeStrings(hn).slice(0, 20);
  }
}

function dedupeStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const key = (s || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push((s || '').trim());
  }
  return out;
}

async function getCombinedTrendingTopics(source, sector) {
  const xTopics = getTrendingTopics();
  const ext = await getExternalTrends(source, sector);
  let combined = dedupeStrings([...xTopics, ...ext]);
  if (source === 'sector') {
    combined = filterTopicsBySector(combined, sector);
  }
  combined = combined.filter(t => t && t.length <= 120);
  return combined.slice(0, 20);
}

// ==================== COMPOSE BOX FEATURES ====================

let composeObserver = null;
let hashtagWidget = null;
let composeTextArea = null;
let textMonitorInterval = null;

function initComposeFeatures() {
  if (!apiKey) return;
  
  // Find compose box
  findAndInjectHashtagWidget();
  
  // Watch for compose box appearance
  if (!composeObserver) {
    composeObserver = new MutationObserver(() => {
      findAndInjectHashtagWidget();
    });
    
    composeObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
}

function findAndInjectHashtagWidget() {
  // Find compose textarea
  const composeSelectors = [
    '[data-testid="tweetTextarea_0"]',
    'div[contenteditable="true"][data-testid*="tweetTextarea"]',
    '[data-testid="tweetTextarea_0"] ~ div',
    '[aria-label*="What\'s happening"]',
    '[contenteditable="true"][aria-label*="Tweet"]'
  ];
  
  let foundTextarea = null;
  for (const selector of composeSelectors) {
    foundTextarea = document.querySelector(selector);
    if (foundTextarea) break;
  }
  
  if (!foundTextarea) {
    // Clean up if compose box is closed
    if (hashtagWidget && hashtagWidget.parentNode) {
      hashtagWidget.remove();
      hashtagWidget = null;
    }
    if (textMonitorInterval) {
      clearInterval(textMonitorInterval);
      textMonitorInterval = null;
    }
    composeTextArea = null;
    return;
  }
  
  // If already injected, skip
  if (hashtagWidget && document.contains(hashtagWidget)) {
    composeTextArea = foundTextarea;
    return;
  }
  
  composeTextArea = foundTextarea;
  
  // Find the compose box container
  let container = foundTextarea.closest('[data-testid="tweetTextarea_0"]')?.parentElement;
  if (!container) {
    container = foundTextarea.closest('div[role="textbox"]')?.parentElement;
  }
  if (!container) {
    container = foundTextarea.parentElement;
  }
  
  if (!container) return;
  
  // Create hashtag widget
  hashtagWidget = document.createElement('div');
  hashtagWidget.className = 'tonegenie-hashtag-widget';
  hashtagWidget.style.cssText = `
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
    padding: 8px 0;
    border-top: 1px solid rgba(0, 0, 0, 0.1);
  `;
  
  // Inject widget
  const toolbar = container.querySelector('[role="toolbar"]');
  if (toolbar) {
    toolbar.parentNode.insertBefore(hashtagWidget, toolbar.nextSibling);
  } else {
    container.appendChild(hashtagWidget);
  }
  
  // Initial load of hashtags
  updateHashtagSuggestions('');
  
  // Monitor text changes
  if (!textMonitorInterval) {
    let lastText = '';
    textMonitorInterval = setInterval(() => {
      if (composeTextArea) {
        const currentText = composeTextArea.textContent || composeTextArea.innerText || '';
        if (currentText !== lastText) {
          lastText = currentText;
          updateHashtagSuggestions(currentText);
        }
      }
    }, 500); // Check every 500ms
    
    // Also listen to input events
    composeTextArea.addEventListener('input', () => {
      const text = composeTextArea.textContent || composeTextArea.innerText || '';
      updateHashtagSuggestions(text);
    });
  }
}

async function updateHashtagSuggestions(tweetText) {
  if (!hashtagWidget || !apiKey) return;
  
  // Get trending hashtags
  const trending = await getTrendingHashtags();
  
  // Generate relevant hashtags based on text
  let relevantHashtags = [];
  if (tweetText.trim().length > 10 && apiKey) {
    try {
      relevantHashtags = await generateRelevantHashtags(tweetText, apiKey);
    } catch (error) {
      console.error('Error generating hashtags:', error);
    }
  }
  
  // Combine and deduplicate
  const allHashtags = [...new Set([...relevantHashtags, ...trending])].slice(0, 8);
  
  // Update widget
  hashtagWidget.innerHTML = '';
  
  if (allHashtags.length === 0) {
    hashtagWidget.innerHTML = '<div style="font-size: 12px; color: #666; padding: 4px;">Loading hashtags...</div>';
    return;
  }
  
  allHashtags.forEach(hashtag => {
    const tagBtn = document.createElement('button');
    tagBtn.className = 'tonegenie-hashtag-btn';
    tagBtn.textContent = hashtag;
    tagBtn.style.cssText = `
      background: rgba(29, 155, 240, 0.1);
      color: #1d9bf0;
      border: 1px solid rgba(29, 155, 240, 0.3);
      border-radius: 16px;
      padding: 4px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    `;
    
    tagBtn.addEventListener('mouseover', () => {
      tagBtn.style.background = 'rgba(29, 155, 240, 0.2)';
    });
    
    tagBtn.addEventListener('mouseout', () => {
      tagBtn.style.background = 'rgba(29, 155, 240, 0.1)';
    });
    
    tagBtn.addEventListener('click', () => {
      insertHashtag(hashtag);
    });
    
    hashtagWidget.appendChild(tagBtn);
  });
}

async function generateRelevantHashtags(tweetText, apiKey) {
  const prompt = `Based on this tweet text, suggest 5-8 relevant hashtags that are trending or commonly used. Include a mix of popular and niche hashtags.

Tweet text: "${tweetText.substring(0, 200)}"

Return ONLY the hashtags, one per line, starting with #. Make them relevant to the content.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: getNextAvailableModel(),
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 100,
        top_p: 1
      })
    });

    if (!response.ok) {
      throw new Error('API request failed');
    }

    const data = await response.json();
    const content = data.choices[0].message.content.trim();
    
    // Extract hashtags
    const hashtags = content.split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('#'))
      .map(line => line.split(/\s+/)[0]) // Take first word only
      .filter(h => h.length > 1 && h.length < 30);
    
    return hashtags.slice(0, 8);
  } catch (error) {
    console.error('Error generating hashtags:', error);
    return [];
  }
}

function insertHashtag(hashtag) {
  if (!composeTextArea) return;
  
  composeTextArea.focus();
  
  const currentText = composeTextArea.textContent || composeTextArea.innerText || '';
  const newText = currentText + (currentText.endsWith(' ') ? '' : ' ') + hashtag + ' ';
  
  try {
    document.execCommand('insertText', false, ' ' + hashtag + ' ');
  } catch {
    // Fallback
    composeTextArea.textContent = newText;
    composeTextArea.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
}

async function insertContentIntoCompose(content) {
  // Open compose box if not open
  const composeButton = document.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"], a[href="/compose/tweet"]');
  if (composeButton) {
    composeButton.click();
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Find compose textarea
  const composeSelectors = [
    '[data-testid="tweetTextarea_0"]',
    'div[contenteditable="true"][data-testid*="tweetTextarea"]'
  ];
  
  let textarea = null;
  for (const selector of composeSelectors) {
    textarea = await waitForElement(selector, 3000);
    if (textarea) break;
  }
  
  if (!textarea) {
    return false;
  }
  
  // Insert content
  const isThread = Array.isArray(content) && content.length > 1;
  
  if (isThread) {
    // Insert first tweet
    const firstTweet = content[0].replace(/^\d+\//, '').trim();
    await insertIntoTwitter(null, firstTweet);
    
    // For threads, we'll insert the first tweet and let user continue manually
    // (Twitter's UI makes it tricky to programmatically add thread tweets)
    return true;
  } else {
    const text = Array.isArray(content) ? content[0] : content;
    await insertIntoTwitter(null, text);
    return true;
  }
}
// ==================== FIRST REPLY DETECTOR ====================

// Track processed tweets to avoid duplicate alerts
const processedTweets = new Set();

// Store early reply opportunities
const earlyReplyOpportunities = new Map(); // tweetId -> { container, opportunity, tweetText, username }

// Sidebar component
let sidebar = null;
let sidebarToggle = null;
let sidebarVisible = false;
let currentFilter = 'all'; // 'all', 'high', 'medium'
let sidebarMode = 'opportunities'; // 'opportunities', 'accounts', 'content', 'highlights', 'viral'

// High value accounts
const highValueAccounts = new Map(); // username -> { username, followerCount, engagementRate, lastTweetTime, lastTweetUrl, lastTweetText, container }

// Extract tweet timestamp from container
function getTweetTimestamp(container) {
  // Try multiple selectors for timestamp
  const timeSelectors = [
    'time[datetime]',
    'a[href*="/status/"] time',
    '[data-testid="User-Name"] time',
    'time',
    'a[href*="/status/"] span'
  ];
  
  for (const selector of timeSelectors) {
    const timeElement = container.querySelector(selector);
    if (timeElement) {
      // Try datetime attribute first
      const datetime = timeElement.getAttribute('datetime');
      if (datetime) {
        const date = new Date(datetime);
        if (!isNaN(date.getTime())) {
          return date.getTime();
        }
      }
      
      // Try parsing title attribute
      const title = timeElement.getAttribute('title');
      if (title) {
        const date = new Date(title);
        if (!isNaN(date.getTime())) {
          return date.getTime();
        }
      }
      
      // Try parsing text content (e.g., "2h", "5m", "Just now")
      const text = timeElement.textContent?.trim() || '';
      const timeAgo = parseTimeAgo(text);
      if (timeAgo !== null) {
        return Date.now() - timeAgo;
      }
    }
  }
  
  return null;
}

// Parse relative time strings like "2h", "5m", "Just now"
function parseTimeAgo(text) {
  if (!text) return null;
  
  text = text.toLowerCase().trim();
  
  // "Just now" or "now"
  if (text.includes('now') || text === '') {
    return 0;
  }
  
  // Parse patterns like "2h", "5m", "30s", "1d"
  const patterns = [
    { regex: /(\d+)\s*s(?:ec(?:ond)?s?)?/i, multiplier: 1000 },
    { regex: /(\d+)\s*m(?:in(?:ute)?s?)?/i, multiplier: 60 * 1000 },
    { regex: /(\d+)\s*h(?:our)?s?/i, multiplier: 60 * 60 * 1000 },
    { regex: /(\d+)\s*d(?:ay)?s?/i, multiplier: 24 * 60 * 60 * 1000 },
    { regex: /(\d+)\s*w(?:eek)?s?/i, multiplier: 7 * 24 * 60 * 60 * 1000 }
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      return parseInt(match[1]) * pattern.multiplier;
    }
  }
  
  return null;
}

// Extract reply count from tweet container
function getReplyCount(container) {
  const replySelectors = [
    '[data-testid="reply"]',
    '[aria-label*="Reply"]',
    'button[aria-label*="reply" i]'
  ];
  
  for (const selector of replySelectors) {
    const replyButton = container.querySelector(selector);
    if (replyButton) {
      // Method 1: Get from aria-label (most reliable)
      const ariaLabel = replyButton.getAttribute('aria-label') || '';
      const match = ariaLabel.match(/(\d+)\s*(?:reply|replies)/i);
      if (match) {
        return parseInt(match[1]);
      }
      
      // Method 2: Find count in nested spans (Twitter's structure)
      const allSpans = replyButton.querySelectorAll('span');
      for (const span of allSpans) {
        const text = span.textContent?.trim();
        // Check if it's a number (but not too large to be a timestamp)
        if (text && /^\d+$/.test(text)) {
          const num = parseInt(text);
          // Reasonable range for reply count (0 to 10M)
          if (num >= 0 && num < 10000000) {
            // Make sure it's not part of a date/time
            const parentText = span.parentElement?.textContent || '';
            if (!parentText.match(/\d+\s*(h|m|s|d|w)/i)) {
              return num;
            }
          }
        }
      }
      
      // Method 3: Check parent container for count
      const parent = replyButton.closest('div[role="group"]') || replyButton.parentElement;
      if (parent) {
        const text = parent.textContent || '';
        // Look for numbers near "reply" text
        const replyMatch = text.match(/(\d+)\s*(?:reply|replies?)/i);
        if (replyMatch) {
          return parseInt(replyMatch[1]);
        }
      }
    }
  }
  
  // Default: assume 0 replies if we can't find it
  return 0;
}

// Extract follower count from account
function getFollowerCount(container) {
  // Try to find user info link
  const userLink = container.querySelector('a[href*="/"][role="link"]');
  if (!userLink) return null;
  
  // Try to find follower count in profile link or hover card
  // This is tricky - Twitter doesn't always show follower count in tweet
  // We'll use a heuristic: check if user has verified badge (often indicates higher followers)
  const verifiedBadge = container.querySelector('[data-testid="icon-verified"]');
  
  // If we can't find exact count, we'll estimate based on other signals
  // For now, return null and we'll use other heuristics
  return null;
}

// Check if tweet is an early reply opportunity
function isEarlyReplyOpportunity(container) {
  // Generate stable tweet ID from URL or data attributes
  let tweetId = null;
  
  // Try to get tweet URL
  const tweetLink = container.querySelector('a[href*="/status/"]');
  if (tweetLink) {
    const href = tweetLink.getAttribute('href');
    const match = href.match(/\/status\/(\d+)/);
    if (match) {
      tweetId = match[1];
    }
  }
  
  // Fallback to data-testid or container ID
  if (!tweetId) {
    tweetId = container.getAttribute('data-testid') || 
              container.querySelector('article')?.getAttribute('data-testid') ||
              container.id ||
              `tweet-${container.querySelector('[data-testid="tweetText"]')?.textContent?.substring(0, 50)?.replace(/\s+/g, '-') || 'unknown'}`;
  }
  
  // Skip if already processed
  if (processedTweets.has(tweetId)) {
    return null;
  }
  
  const timestamp = getTweetTimestamp(container);
  const replyCount = getReplyCount(container);
  
  if (timestamp === null) {
    return null;
  }
  
  const ageMs = Date.now() - timestamp;
  const ageMinutes = ageMs / (60 * 1000);
  const ageHours = ageMs / (60 * 60 * 1000);
  
  // Early reply criteria:
  // 1. Tweet is less than 30 minutes old AND has less than 100 replies = FAST REPLY opportunity
  // 2. Tweet is less than 2 hours old AND has 10-500 replies = GOOD TIMING opportunity
  // 3. Tweet is less than 24 hours old AND has 100-1000 replies = VIRAL opportunity
  
  let opportunity = null;
  
  if (ageMinutes < 30 && replyCount < 100) {
    opportunity = {
      type: 'fast_reply',
      urgency: 'high',
      message: `⚡ FAST REPLY — ${Math.round(ageMinutes)}m old, ${replyCount} replies`,
      ageMinutes: Math.round(ageMinutes),
      replyCount: replyCount
    };
  } else if (ageHours < 2 && replyCount >= 10 && replyCount < 500) {
    opportunity = {
      type: 'good_timing',
      urgency: 'medium',
      message: `🔥 Early opportunity — ${ageHours < 1 ? Math.round(ageMinutes) + 'm' : Math.round(ageHours) + 'h'} old, ${replyCount} replies`,
      ageMinutes: Math.round(ageMinutes),
      replyCount: replyCount
    };
  } else if (ageHours < 24 && replyCount >= 100 && replyCount < 1000) {
    opportunity = {
      type: 'viral',
      urgency: 'medium',
      message: `📈 Viral thread — ${Math.round(ageHours)}h old, ${replyCount} replies`,
      ageMinutes: Math.round(ageMinutes),
      replyCount: replyCount
    };
  }
  
  if (opportunity) {
    processedTweets.add(tweetId);
    // Clean up old processed tweets (keep last 1000)
    if (processedTweets.size > 1000) {
      const array = Array.from(processedTweets);
      processedTweets.clear();
      array.slice(-500).forEach(id => processedTweets.add(id));
    }
  }
  
  return opportunity;
}

// Register early reply opportunity
function registerEarlyReplyOpportunity(container, opportunity) {
  // Generate stable tweet ID
  let tweetId = null;
  const tweetLink = container.querySelector('a[href*="/status/"]');
  if (tweetLink) {
    const href = tweetLink.getAttribute('href');
    const match = href.match(/\/status\/(\d+)/);
    if (match) {
      tweetId = match[1];
    }
  }
  
  if (!tweetId) {
    tweetId = container.getAttribute('data-testid') || 
              container.querySelector('article')?.getAttribute('data-testid') ||
              `tweet-${Date.now()}-${Math.random()}`;
  }
  
  // Get tweet text and username
  const contentSelector = '[data-testid="tweetText"], article div[lang]';
  const contentElement = container.querySelector(contentSelector);
  const tweetText = contentElement ? (contentElement.textContent || '').trim() : '';
  
  // Try to get username
  const userLink = container.querySelector('a[href^="/"][role="link"]');
  let username = 'Unknown';
  if (userLink) {
    const href = userLink.getAttribute('href');
    if (href && href.startsWith('/') && !href.includes('/status/')) {
      username = href.replace('/', '@');
    } else {
      const userText = userLink.textContent?.trim();
      if (userText) {
        username = userText.startsWith('@') ? userText : `@${userText}`;
      }
    }
  }
  
  // Store opportunity
  earlyReplyOpportunities.set(tweetId, {
    container,
    opportunity,
    tweetText: tweetText, // Full text for quick reply
    tweetTextPreview: tweetText.substring(0, 100) + (tweetText.length > 100 ? '...' : ''), // Preview for display
    username,
    tweetId,
    timestamp: Date.now()
  });
  
  // Update sidebar
  updateSidebar();
  
  // Browser notifications disabled to avoid OS popups.
}

// Create sidebar component
// Create sidebar component
function createSidebar() {
  if (sidebar) return sidebar;
  
  // Add sidebar styles
  if (!document.getElementById('tonegenie-sidebar-styles')) {
    const style = document.createElement('style');
    style.id = 'tonegenie-sidebar-styles';
    style.textContent = `
      .tonegenie-sidebar {
        position: fixed;
        right: 0;
        top: 0;
        width: 380px;
        max-width: calc(100vw - 80px);
        height: 100vh;
        background: #ffffff;
        box-shadow: -4px 0 24px rgba(0, 0, 0, 0.12);
        z-index: 999998;
        transform: translateX(100%);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
        border-left: 1px solid #e8e8e8;
        overflow: hidden;
      }
      .tonegenie-sidebar.visible {
        transform: translateX(0);
      }
      .tonegenie-sidebar-header {
        padding: 16px 20px;
        border-bottom: 1px solid #f0f0f0;
        background: #ffffff;
        position: sticky;
        top: 0;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .tonegenie-sidebar-title {
        font-size: 16px;
        font-weight: 700;
        color: #1a1a1a;
      }
      .tonegenie-sidebar-close {
        background: none;
        border: none;
        color: #666;
        font-size: 20px;
        cursor: pointer;
        padding: 4px;
        border-radius: 6px;
        transition: all 0.2s ease;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
      }
      .tonegenie-sidebar-close:hover {
        background: #f0f0f0;
        color: #1a1a1a;
      }
      .tonegenie-sidebar-content {
        flex: 1;
        padding: 20px;
        background: #ffffff;
        overflow-y: auto;
      }
      .tonegenie-sidebar-empty {
        padding: 40px 20px;
        text-align: center;
        color: #999;
        font-size: 14px;
        line-height: 1.6;
      }
      .tonegenie-sidebar-toggle {
        position: fixed;
        right: 24px;
        bottom: 24px;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        background: #1a1a1a;
        border: none;
        color: white;
        font-size: 22px;
        cursor: pointer;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
        z-index: 999997;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.25s ease;
      }
      .tonegenie-sidebar-toggle:hover {
        transform: scale(1.05);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16);
        background: #2a2a2a;
      }
      .tonegenie-sidebar-toggle:active {
        transform: scale(0.98);
      }
    `;
    document.head.appendChild(style);
  }
  
  // Create sidebar
  sidebar = document.createElement('div');
  sidebar.className = 'tonegenie-sidebar';
  
  // Header
  const header = document.createElement('div');
  header.className = 'tonegenie-sidebar-header';
  
  const title = document.createElement('div');
  title.className = 'tonegenie-sidebar-title';
  title.textContent = 'ToneGenie';
  header.appendChild(title);
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tonegenie-sidebar-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => toggleSidebar());
  header.appendChild(closeBtn);
  
  sidebar.appendChild(header);
  
  // Content
  const content = document.createElement('div');
  content.className = 'tonegenie-sidebar-content';
  
  const empty = document.createElement('div');
  empty.className = 'tonegenie-sidebar-empty';
  empty.textContent = 'New features coming soon...';
  content.appendChild(empty);
  
  sidebar.appendChild(content);
  
  // Append to body
  document.body.appendChild(sidebar);
  
  // Create toggle button
  sidebarToggle = document.createElement('button');
  sidebarToggle.className = 'tonegenie-sidebar-toggle';
  sidebarToggle.textContent = '⚡';
  sidebarToggle.addEventListener('click', () => toggleSidebar());
  document.body.appendChild(sidebarToggle);
  
  return sidebar;
}

// Toggle sidebar visibility
function toggleSidebar() {
  sidebarVisible = !sidebarVisible;
  if (sidebar) {
    sidebar.classList.toggle('visible', sidebarVisible);
  }
}



// Update sidebar content (Empty for now)
function updateSidebar() {
  if (!sidebar) {
    createSidebar();
    return;
  }
  
  // No updates needed as content is static
}

// Handle quick reply from sidebar
async function handleQuickReply(container, tweetText, button) {
  if (!apiKey || !tweetText) {
    return;
  }
  
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '⏳ Generating...';
  
  try {
    // Analyze tweet and get best style
    const suggestions = await analyzeTweetAndSuggestStyles(tweetText);
    const bestStyle = suggestions && suggestions.length > 0 ? suggestions[0] : 'friendly';
    
    // Generate comment
    const comment = await generateComment(tweetText, bestStyle);
    
    // Scroll to tweet first
    scrollToTweet(container, null);
    
    // Wait a bit for scroll
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Click reply button
    const replyButton = container.querySelector('[data-testid="reply"], [aria-label*="Reply"], [aria-label*="reply"]');
    if (replyButton) {
      replyButton.click();
      
      // Wait and insert comment
      setTimeout(async () => {
        try {
          await insertIntoTwitter('[data-testid="tweetTextarea_0"], div[contenteditable="true"][data-testid*="tweetTextarea"]', comment);
          button.textContent = '✓ Done!';
          button.style.background = '#16a34a';
          setTimeout(() => {
            button.disabled = false;
            button.textContent = originalText;
            button.style.background = '';
          }, 2000);
        } catch (error) {
          console.error('tonegenie: Error inserting quick reply:', error);
          button.textContent = 'Retry';
          button.disabled = false;
        }
      }, 500);
    } else {
      button.textContent = 'Tweet not found';
      button.disabled = false;
    }
  } catch (error) {
    console.error('tonegenie: Error generating quick reply:', error);
    button.textContent = 'Error';
    button.disabled = false;
  }
}

// Scroll to tweet
function scrollToTweet(container, tweetId) {
  if (!container || !document.contains(container)) {
    // Try to find container by tweet ID
    const tweetLink = document.querySelector(`a[href*="/status/${tweetId}"]`);
    if (tweetLink) {
      const newContainer = tweetLink.closest('article[data-testid="tweet"], article[role="article"]');
      if (newContainer) {
        newContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Highlight briefly
        newContainer.style.transition = 'box-shadow 0.3s';
        newContainer.style.boxShadow = '0 0 0 4px rgba(102, 126, 234, 0.5)';
        setTimeout(() => {
          newContainer.style.boxShadow = '';
        }, 2000);
        return;
      }
    }
    console.log('tonegenie: Could not find tweet container');
    return;
  }
  
  container.scrollIntoView({ behavior: 'smooth', block: 'center' });
  
  // Highlight briefly
  container.style.transition = 'box-shadow 0.3s';
  container.style.boxShadow = '0 0 0 4px rgba(102, 126, 234, 0.5)';
  setTimeout(() => {
    container.style.boxShadow = '';
  }, 2000);
}

// ==================== HIGH VALUE ACCOUNT FINDER ====================

// Extract account data from tweet container
function extractAccountData(container) {
  // Get username - try multiple methods
  let username = null;
  let userUrl = null;
  
  // Method 1: Find user link in header
  const userLinks = container.querySelectorAll('a[href^="/"][role="link"]');
  for (const userLink of userLinks) {
    const href = userLink.getAttribute('href');
    if (href && !href.includes('/status/') && !href.includes('/i/') && 
        !href.includes('/search') && !href.includes('/hashtag') &&
        href.split('/').length === 2) { // Just username, no extra paths
      const possibleUsername = href.replace('/', '').replace('@', '');
      if (possibleUsername && possibleUsername.length > 0 && possibleUsername.length < 20) {
        username = possibleUsername;
        userUrl = href;
        break;
      }
    }
  }
  
  // Method 2: Try to find username in text content
  if (!username) {
    const usernameSelectors = [
      '[data-testid="User-Name"] a',
      '[data-testid="User-Names"] a',
      'div[role="group"] a[href^="/"]'
    ];
    
    for (const selector of usernameSelectors) {
      const element = container.querySelector(selector);
      if (element) {
        const href = element.getAttribute('href');
        if (href && href.startsWith('/') && !href.includes('/status/') && 
            href.split('/').length === 2) {
          username = href.replace('/', '').replace('@', '');
          userUrl = href;
          break;
        }
      }
    }
  }
  
  // Method 3: Try to extract from text
  if (!username) {
    const allLinks = container.querySelectorAll('a[href*="/"]');
    for (const link of allLinks) {
      const href = link.getAttribute('href');
      const text = link.textContent?.trim();
      if (text && text.startsWith('@') && text.length < 20) {
        username = text.replace('@', '').trim();
        userUrl = `/${username}`;
        break;
      }
    }
  }
  
  if (!username) {
    // Last resort: try to find any text that looks like @username
    const text = container.textContent || '';
    const match = text.match(/@(\w+)/);
    if (match && match[1].length < 20) {
      username = match[1];
      userUrl = `/${username}`;
    }
  }
  
  if (!username) return null;
  
  // Get tweet engagement metrics
  const replyCount = getReplyCount(container);
  const likeCount = getLikeCount(container);
  const retweetCount = getRetweetCount(container);
  const totalEngagements = replyCount + likeCount + retweetCount;
  
  // Get tweet timestamp
  const tweetTime = getTweetTimestamp(container);
  
  // Get tweet URL and text
  const tweetLink = container.querySelector('a[href*="/status/"]');
  let lastTweetUrl = null;
  if (tweetLink) {
    const href = tweetLink.getAttribute('href');
    lastTweetUrl = href.startsWith('http') ? href : `https://twitter.com${href}`;
  }
  
  const contentSelector = '[data-testid="tweetText"], article div[lang]';
  const contentElement = container.querySelector(contentSelector);
  const lastTweetText = contentElement ? (contentElement.textContent || '').trim() : '';
  
  // Try to extract follower count (this is tricky - Twitter doesn't always show it)
  // We'll estimate based on verified badge or try to find it in the profile link hover
  let followerCount = null;
  const verifiedBadge = container.querySelector('[data-testid="icon-verified"]');
  
  // Try to find follower count in various places
  // Note: Twitter/X doesn't always display follower counts in tweet view
  // We'll use heuristics and check if we can find it
  
  // For now, we'll use a placeholder and estimate based on engagement
  // In a real implementation, you might need to hover over profile links or use API
  
  return {
    username,
    userUrl,
    followerCount, // Will be null if not found
    replyCount,
    likeCount,
    retweetCount,
    totalEngagements,
    engagementRate: null, // Will calculate after we have follower count
    lastTweetTime: tweetTime,
    lastTweetUrl,
    lastTweetText: lastTweetText.substring(0, 100),
    container,
    timestamp: Date.now()
  };
}

// Get like count
function getLikeCount(container) {
  const likeSelectors = [
    '[data-testid="like"]',
    '[aria-label*="Like"]',
    'button[aria-label*="like" i]'
  ];
  
  for (const selector of likeSelectors) {
    const likeButton = container.querySelector(selector);
    if (likeButton) {
      const ariaLabel = likeButton.getAttribute('aria-label') || '';
      const match = ariaLabel.match(/(\d+)\s*(?:like|likes)/i);
      if (match) {
        return parseInt(match[1]);
      }
      
      // Try to find count in nested spans
      const allSpans = likeButton.querySelectorAll('span');
      for (const span of allSpans) {
        const text = span.textContent?.trim();
        if (text && /^\d+$/.test(text)) {
          const num = parseInt(text);
          if (num >= 0 && num < 10000000) {
            return num;
          }
        }
      }
    }
  }
  
  return 0;
}

// Get retweet count
function getRetweetCount(container) {
  const retweetSelectors = [
    '[data-testid="retweet"]',
    '[aria-label*="Repost"]',
    '[aria-label*="Retweet"]',
    'button[aria-label*="repost" i]'
  ];
  
  for (const selector of retweetSelectors) {
    const retweetButton = container.querySelector(selector);
    if (retweetButton) {
      const ariaLabel = retweetButton.getAttribute('aria-label') || '';
      const match = ariaLabel.match(/(\d+)\s*(?:repost|retweet|reposts|retweets)/i);
      if (match) {
        return parseInt(match[1]);
      }
      
      // Try to find count in nested spans
      const allSpans = retweetButton.querySelectorAll('span');
      for (const span of allSpans) {
        const text = span.textContent?.trim();
        if (text && /^\d+$/.test(text)) {
          const num = parseInt(text);
          if (num >= 0 && num < 10000000) {
            return num;
          }
        }
      }
    }
  }
  
  return 0;
}

// Get view count from tweet
function getViewCount(container) {
  // Twitter shows view counts near the engagement buttons
  // Look for patterns like "1.2M views", "1,234,567 views", etc.
  
  // Method 1: Look in all text content for view patterns
  const allText = container.textContent || '';
  
  // More specific pattern: number followed by "views" (not "reviews" or "previews")
  const viewPatterns = [
    /(\d+(?:\.\d+)?)\s*(K|M|B)?\s+views?\b/i,
    /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(K|M|B)?\s+views?\b/i,
    /views?[:\s]+(\d+(?:\.\d+)?)\s*(K|M|B)?/i
  ];
  
  for (const pattern of viewPatterns) {
    const matches = allText.matchAll(new RegExp(pattern.source, 'gi'));
    for (const match of matches) {
      // Make sure it's not part of another word
      const before = allText.substring(Math.max(0, match.index - 10), match.index);
      const after = allText.substring(match.index + match[0].length, match.index + match[0].length + 10);
      
      // Skip if it's part of "reviews", "previews", "interview", etc.
      if (!/re|pre|inter/i.test(before) && !/s\s/i.test(after)) {
        let count = parseFloat(match[1].replace(/,/g, ''));
        const multiplier = match[2]?.toUpperCase();
        
        if (multiplier === 'K') count *= 1000;
        else if (multiplier === 'M') count *= 1000000;
        else if (multiplier === 'B') count *= 1000000000;
        
        if (count >= 1000) {
          return Math.round(count);
        }
      }
    }
  }
  
  // Method 2: Look in specific elements that typically contain view counts
  const viewElements = container.querySelectorAll('span, div, a');
  for (const element of viewElements) {
    const text = element.textContent?.trim() || '';
    const viewMatch = text.match(/(\d+(?:\.\d+)?)\s*(K|M|B)?\s+views?\b/i);
    if (viewMatch) {
      let count = parseFloat(viewMatch[1].replace(/,/g, ''));
      const multiplier = viewMatch[2]?.toUpperCase();
      
      if (multiplier === 'K') count *= 1000;
      else if (multiplier === 'M') count *= 1000000;
      else if (multiplier === 'B') count *= 1000000000;
      
      if (count >= 1000) {
        return Math.round(count);
      }
    }
  }
  
  // Method 3: Try aria-labels
  const links = container.querySelectorAll('a[href*="/status/"]');
  for (const link of links) {
    const ariaLabel = link.getAttribute('aria-label') || '';
    const viewMatch = ariaLabel.match(/(\d+(?:\.\d+)?)\s*(K|M|B)?\s+views?/i);
    if (viewMatch) {
      let count = parseFloat(viewMatch[1].replace(/,/g, ''));
      const multiplier = viewMatch[2]?.toUpperCase();
      
      if (multiplier === 'K') count *= 1000;
      else if (multiplier === 'M') count *= 1000000;
      else if (multiplier === 'B') count *= 1000000000;
      
      if (count >= 1000) {
        return Math.round(count);
      }
    }
  }
  
  return null;
}

// Extract follower count from profile link or container
async function extractFollowerCount(username, container) {
  if (!username) return null;
  
  // Check if we can find follower count in the tweet container
  // Twitter sometimes shows it in hover cards or profile links
  const profileLink = container.querySelector(`a[href*="/${username}"]`);
  
  // Method 1: Try to extract from verified badge context (verified accounts often have high followers)
  const verifiedBadge = container.querySelector('[data-testid="icon-verified"]');
  if (verifiedBadge) {
    // Verified accounts are more likely to have 1M+ followers
    // We'll need to visit the profile to get exact count
  }
  
  // Method 2: Try to find count in nested spans (Twitter's structure)
  const allSpans = container.querySelectorAll('span');
  for (const span of allSpans) {
    const text = span.textContent?.trim();
    // Look for follower count patterns like "1.2M Followers" or "1,234,567 Followers"
    const followerMatch = text.match(/(\d+(?:\.\d+)?)\s*(K|M|B)?\s*Followers?/i);
    if (followerMatch) {
      let count = parseFloat(followerMatch[1].replace(/,/g, ''));
      const multiplier = followerMatch[2]?.toUpperCase();
      
      if (multiplier === 'K') count *= 1000;
      else if (multiplier === 'M') count *= 1000000;
      else if (multiplier === 'B') count *= 1000000000;
      
      return Math.round(count);
    }
  }
  
  // Method 3: Try to visit profile page (this is more accurate but slower)
  // For now, we'll estimate based on engagement and view counts
  // In a full implementation, you could open profile in a new tab and extract
  
  return null;
}

// Estimate follower count based on engagement metrics (more conservative)
function estimateFollowerCount(likeCount, retweetCount, replyCount, viewCount) {
  // IMPORTANT: Be very conservative - only estimate if we have strong signals
  // Don't inflate follower counts - if we can't determine, return null
  
  // If we have view count, use it as a proxy for followers
  // Generally, views are 10-50x the follower count for popular accounts
  if (viewCount && viewCount >= 5000000) {
    // Only for very high view counts (5M+), estimate followers
    // Very conservative: 5-8% of views
    const estimated = Math.round(viewCount * 0.06);
    // Only return if it's clearly 1M+
    if (estimated >= 1000000) {
      return estimated;
    }
  }
  
  // Estimate based on engagement - be VERY conservative
  const totalEngagement = likeCount + retweetCount * 2 + replyCount * 1.5;
  
  // Only estimate if engagement is VERY high (indicates large following)
  if (totalEngagement > 50000) {
    // For accounts with 50K+ engagement, use conservative engagement rates
    // Elite accounts (1M+ followers) typically have 0.1-1% engagement rate
    let engagementRate = 0.003; // 0.3% - very conservative for large accounts
    
    if (totalEngagement > 200000) {
      engagementRate = 0.002; // 0.2% for mega accounts
    } else if (totalEngagement > 100000) {
      engagementRate = 0.0025; // 0.25%
    }
    
    const estimatedFollowers = totalEngagement / engagementRate;
    // Only return if clearly 1M+ and we have very high engagement
    if (estimatedFollowers >= 1500000 && totalEngagement >= 50000) {
      return estimatedFollowers;
    }
  }
  
  // If we can't confidently estimate 1M+, return null
  return null;
}

// Estimate impressions from engagement or use view count
function estimateImpressions(likeCount, retweetCount, replyCount, viewCount) {
  // If view count is available and significant, use it directly (most accurate)
  if (viewCount && viewCount >= 500000) {
    return viewCount;
  }
  
  // Otherwise estimate based on engagement
  // For elite accounts with 1M+ followers, impressions are typically higher
  const totalEngagement = likeCount + retweetCount * 2 + replyCount * 1.5;
  
  if (totalEngagement > 0) {
    // Use multiplier based on engagement level
    // Higher engagement = higher multiplier (indicates more viral/reach)
    let multiplier = 150; // Base multiplier for elite accounts
    
    if (totalEngagement > 5000) multiplier = 200;
    if (totalEngagement > 20000) multiplier = 300;
    if (totalEngagement > 50000) multiplier = 400;
    if (totalEngagement > 100000) multiplier = 500;
    if (totalEngagement > 500000) multiplier = 600;
    
    const estimatedImpressions = totalEngagement * multiplier;
    
    // For elite accounts, minimum should be 1M, but be more generous with estimation
    // If engagement is very high, impressions could be much higher
    if (estimatedImpressions >= 1000000) {
      return estimatedImpressions;
    }
    
    // If view count is available but low, still use it if it's better than estimation
    if (viewCount && viewCount > estimatedImpressions) {
      return viewCount;
    }
  }
  
  // If we have a view count but it's low, still return it for consideration
  if (viewCount && viewCount >= 100000) {
    return viewCount;
  }
  
  return null;
}

// Scan for high value accounts
function scanHighValueAccounts() {
  const refreshBtn = Array.from(sidebar.querySelectorAll('.tonegenie-sidebar-btn'))
    .find(btn => btn.textContent.includes('🔄') || btn.textContent.includes('🔍'));
  
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '⏳ Scanning...';
  }
  
  highValueAccounts.clear();
  
  // Scan all visible tweets
  const containers = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
  let scanned = 0;
  let found = 0;
  let debugInfo = [];
  
  containers.forEach(container => {
    const accountData = extractAccountData(container);
    if (!accountData) return;
    
    scanned++;
    
    // More lenient criteria - lower threshold
    // Look for accounts with at least 10 total engagements (much lower threshold)
    const hasEngagement = accountData.totalEngagements >= 10;
    
    // Check if tweet is recent (< 7 days - much more lenient)
    const isRecent = !accountData.lastTweetTime || 
                     (Date.now() - accountData.lastTweetTime) < (7 * 24 * 60 * 60 * 1000);
    
    // Debug info
    debugInfo.push({
      username: accountData.username,
      engagements: accountData.totalEngagements,
      likes: accountData.likeCount,
      replies: accountData.replyCount,
      retweets: accountData.retweetCount,
      isRecent: isRecent,
      hasEngagement: hasEngagement
    });
    
    // Filter criteria - even more lenient
    // Minimum: 5 engagements (very low threshold)
    if (accountData.totalEngagements >= 5) {
      // Estimate followers based on engagement
      // Formula: engagement * multiplier (80-200 range)
      // Cap at 100K followers max
      const multiplier = Math.max(50, Math.min(200, accountData.totalEngagements * 2));
      const estimatedFollowers = Math.min(
        100000, 
        Math.max(1000, accountData.totalEngagements * multiplier)
      );
      accountData.followerCount = estimatedFollowers;
      accountData.engagementRate = (accountData.totalEngagements / estimatedFollowers) * 100;
      
      // Very lenient: engagement rate > 0.1% OR > 10 total engagements
      // This ensures we show accounts even with low engagement rates if they have absolute engagement
      if (accountData.engagementRate > 0.1 || accountData.totalEngagements >= 10) {
        // Check if we already have this account (update if newer tweet or more engagement)
        const existing = highValueAccounts.get(accountData.username);
        if (!existing || 
            (accountData.totalEngagements > existing.totalEngagements) ||
            (accountData.lastTweetTime && existing.lastTweetTime && 
             accountData.lastTweetTime > existing.lastTweetTime)) {
          highValueAccounts.set(accountData.username, accountData);
          found++;
          console.log(`tonegenie: Found account @${accountData.username} - ${accountData.totalEngagements} engagements (${accountData.likeCount}L/${accountData.replyCount}R/${accountData.retweetCount}RT), ${accountData.engagementRate.toFixed(2)}% rate, ${estimatedFollowers.toLocaleString()} est. followers`);
        }
      }
    }
  });
  
  if (refreshBtn) {
    setTimeout(() => {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = '🔄 Refresh';
    }, 1000);
  }
  
  console.log(`tonegenie: Scanned ${scanned} accounts, found ${found} high-value accounts`);
  if (scanned > 0 && found === 0) {
    console.log('tonegenie: Debug - sample accounts:', debugInfo.slice(0, 5));
  }
  updateAccountsSidebar();
}

// Update accounts sidebar
function updateAccountsSidebar() {
  if (!sidebar) {
    createSidebar();
  }
  
  // Only update if in accounts mode
  if (sidebarMode !== 'accounts') return;
  
  const content = sidebar.querySelector('.tonegenie-sidebar-content');
  const countBadge = sidebar.querySelector('.tonegenie-sidebar-count');
  
  const count = highValueAccounts.size;
  if (countBadge) countBadge.textContent = count;
  
  // Clear content
  content.innerHTML = '';
  
  if (count === 0) {
    const empty = document.createElement('div');
    empty.className = 'tonegenie-sidebar-empty';
    empty.innerHTML = 'No high-value accounts found yet.<br>Click "🔍 Scan Accounts" to scan your feed.';
    content.appendChild(empty);
    return;
  }
  
  // Sort by engagement rate (highest first)
  const sorted = Array.from(highValueAccounts.values())
    .sort((a, b) => {
      if (b.engagementRate !== null && a.engagementRate !== null) {
        return b.engagementRate - a.engagementRate;
      }
      return b.totalEngagements - a.totalEngagements;
    });
  
  sorted.forEach(account => {
    const item = document.createElement('div');
    item.className = 'tonegenie-opportunity-item';
    item.style.cursor = 'pointer';
    
    // Header
    const header = document.createElement('div');
    header.className = 'tonegenie-opportunity-header';
    
    const username = document.createElement('div');
    username.className = 'tonegenie-opportunity-username';
    username.textContent = `@${account.username}`;
    username.style.fontSize = '13px';
    username.style.fontWeight = '700';
    header.appendChild(username);
    
    const time = document.createElement('div');
    time.className = 'tonegenie-opportunity-time';
    if (account.lastTweetTime) {
      const ageHours = Math.round((Date.now() - account.lastTweetTime) / (60 * 60 * 1000));
      time.textContent = ageHours < 1 ? 'Just now' : `${ageHours}h ago`;
    }
    header.appendChild(time);
    
    item.appendChild(header);
    
    // Stats
    const stats = document.createElement('div');
    stats.className = 'tonegenie-opportunity-stats';
    stats.style.marginTop = '6px';
    stats.style.marginBottom = '6px';
    
    const followerText = account.followerCount 
      ? `${formatNumber(account.followerCount)} followers`
      : 'Followers unknown';
    const engagementText = account.engagementRate 
      ? `${account.engagementRate.toFixed(1)}% engagement`
      : 'High engagement';
    
    stats.innerHTML = `
      <span>👥 ${followerText}</span>
      <span>📊 ${engagementText}</span>
    `;
    item.appendChild(stats);
    
    // Tweet preview
    if (account.lastTweetText) {
      const text = document.createElement('div');
      text.className = 'tonegenie-opportunity-text';
      text.textContent = account.lastTweetText;
      item.appendChild(text);
    }
    
    // Actions
    const actions = document.createElement('div');
    actions.className = 'tonegenie-opportunity-actions';
    
    const viewBtn = document.createElement('button');
    viewBtn.className = 'tonegenie-opportunity-btn quick-reply';
    viewBtn.textContent = '👁️ View Tweet';
    viewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (account.lastTweetUrl) {
        window.open(account.lastTweetUrl, '_blank');
      } else if (account.container) {
        scrollToTweet(account.container, null);
      }
    });
    actions.appendChild(viewBtn);
    
    const quickReplyBtn = document.createElement('button');
    quickReplyBtn.className = 'tonegenie-opportunity-btn quick-reply';
    quickReplyBtn.textContent = '💬 Reply';
    quickReplyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (account.container && account.lastTweetText) {
        await handleQuickReply(account.container, account.lastTweetText, quickReplyBtn);
      }
    });
    actions.appendChild(quickReplyBtn);
    
    item.appendChild(actions);
    
    // Click handler - scroll to tweet
    item.addEventListener('click', (e) => {
      if (!e.target.closest('.tonegenie-opportunity-btn')) {
        if (account.container) {
          scrollToTweet(account.container, null);
        } else if (account.lastTweetUrl) {
          window.open(account.lastTweetUrl, '_blank');
        }
      }
    });
    
    content.appendChild(item);
  });
}

// Update content ideas sidebar
function updateContentIdeasSidebar() {
  if (!sidebar) {
    createSidebar();
  }
  
  if (sidebarMode !== 'content') return;
  
  const content = sidebar.querySelector('.tonegenie-sidebar-content');
  content.innerHTML = '';
  
  // Create form
  const form = document.createElement('div');
  form.className = 'tonegenie-content-ideas-form';
  
  // Source selector (Global or Sector)
  const sourceRow = document.createElement('div');
  sourceRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;';
  
  const sourceLabel = document.createElement('div');
  sourceLabel.style.cssText = 'font-size: 12px; font-weight: 600; color: #1a1a1a;';
  sourceLabel.textContent = 'Source';
  sourceRow.appendChild(sourceLabel);
  
  const sourceSelect = document.createElement('select');
  sourceSelect.id = 'tonegenie-source-select';
  sourceSelect.style.cssText = 'flex: 1;';
  [
    { value: 'global', label: 'Global trends' },
    { value: 'sector', label: 'Sector-specific trends' }
  ].forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    sourceSelect.appendChild(o);
  });
  sourceRow.appendChild(sourceSelect);
  form.appendChild(sourceRow);
  
  // Sector selector
  const sectorRow = document.createElement('div');
  sectorRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;';
  
  const sectorLabel = document.createElement('div');
  sectorLabel.style.cssText = 'font-size: 12px; font-weight: 600; color: #1a1a1a;';
  sectorLabel.textContent = 'Sector';
  sectorRow.appendChild(sectorLabel);
  
  const sectorSelect = document.createElement('select');
  sectorSelect.id = 'tonegenie-sector-select';
  sectorSelect.style.cssText = 'flex: 1;';
  [
    'AI',
    'Startups',
    'Productivity',
    'SaaS',
    'Developer',
    'CS Programming',
    'Generative AI Learning'
  ].forEach(label => {
    const o = document.createElement('option');
    o.value = label;
    o.textContent = label;
    sectorSelect.appendChild(o);
  });
  sectorRow.appendChild(sectorSelect);
  form.appendChild(sectorRow);
  
  // Reload trends on source/sector change
  sourceSelect.addEventListener('change', () => loadTrendingTopicsForSidebar());
  sectorSelect.addEventListener('change', () => loadTrendingTopicsForSidebar());
  
  // Trending topics section
  const trendingHeader = document.createElement('div');
  trendingHeader.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;';
  
  const trendingLabel = document.createElement('div');
  trendingLabel.style.cssText = 'font-size: 12px; font-weight: 600; color: #1a1a1a; letter-spacing: -0.01em;';
  trendingLabel.textContent = '🔥 Trending Topics';
  trendingHeader.appendChild(trendingLabel);
  
  const refreshTrendingBtn = document.createElement('button');
  refreshTrendingBtn.className = 'tonegenie-sidebar-btn';
  refreshTrendingBtn.style.cssText = 'width: auto; padding: 6px 12px; font-size: 11px;';
  refreshTrendingBtn.textContent = '🔄 Refresh';
  refreshTrendingBtn.addEventListener('click', () => loadTrendingTopicsForSidebar());
  trendingHeader.appendChild(refreshTrendingBtn);
  
  form.appendChild(trendingHeader);
  
  const trendingContainer = document.createElement('div');
  trendingContainer.className = 'tonegenie-trending-topics';
  trendingContainer.id = 'tonegenie-trending-topics';
  form.appendChild(trendingContainer);
  
  // Custom niche input
  const nicheLabel = document.createElement('div');
  nicheLabel.style.cssText = 'font-size: 12px; font-weight: 600; color: #1a1a1a; margin-top: 16px; margin-bottom: 8px; letter-spacing: -0.01em;';
  nicheLabel.textContent = 'Or enter your niche/topic';
  form.appendChild(nicheLabel);
  
  const nicheInput = document.createElement('input');
  nicheInput.type = 'text';
  nicheInput.className = 'tonegenie-content-ideas-input';
  nicheInput.id = 'tonegenie-niche-input';
  nicheInput.placeholder = 'e.g., tech, AI, startups, marketing';
  form.appendChild(nicheInput);
  
  // Content type select
  const contentTypeLabel = document.createElement('div');
  contentTypeLabel.style.cssText = 'font-size: 12px; font-weight: 600; color: #1a1a1a; margin-top: 16px; margin-bottom: 8px; letter-spacing: -0.01em;';
  contentTypeLabel.textContent = 'Content Type';
  form.appendChild(contentTypeLabel);
  
  const contentTypeSelect = document.createElement('select');
  contentTypeSelect.className = 'tonegenie-content-ideas-select';
  contentTypeSelect.id = 'tonegenie-content-type';
  const option1 = document.createElement('option');
  option1.value = 'tweet';
  option1.textContent = 'Single Tweet';
  const option2 = document.createElement('option');
  option2.value = 'thread';
  option2.textContent = 'Thread (3-5 tweets)';
  contentTypeSelect.appendChild(option1);
  contentTypeSelect.appendChild(option2);
  form.appendChild(contentTypeSelect);
  
  // Quick Generate button (uses first trending topic automatically)
  const quickGenerateBtn = document.createElement('button');
  quickGenerateBtn.className = 'tonegenie-content-ideas-btn';
  quickGenerateBtn.style.cssText = 'background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); margin-top: 12px;';
  quickGenerateBtn.id = 'tonegenie-quick-generate-btn';
  quickGenerateBtn.textContent = '🚀 Quick Generate (from Trending)';
  quickGenerateBtn.addEventListener('click', () => handleQuickGenerate());
  form.appendChild(quickGenerateBtn);
  
  // Generate button (uses selected topic or custom niche)
  const generateBtn = document.createElement('button');
  generateBtn.className = 'tonegenie-content-ideas-btn';
  generateBtn.id = 'tonegenie-generate-ideas-btn';
  generateBtn.textContent = '💡 Generate Ideas';
  generateBtn.addEventListener('click', () => handleGenerateIdeas());
  form.appendChild(generateBtn);
  
  // Status div
  const statusDiv = document.createElement('div');
  statusDiv.id = 'tonegenie-content-status';
  statusDiv.className = 'tonegenie-content-status';
  statusDiv.style.display = 'none';
  form.appendChild(statusDiv);
  
  // Ideas container
  const ideasContainer = document.createElement('div');
  ideasContainer.id = 'tonegenie-ideas-container';
  ideasContainer.style.cssText = 'max-height: 400px; overflow-y: auto; margin-top: 8px;';
  form.appendChild(ideasContainer);
  
  content.appendChild(form);
  
  // Load trending topics
  loadTrendingTopicsForSidebar();
}

let selectedTrendingTopic = null;

function loadTrendingTopicsForSidebar() {
  const container = document.getElementById('tonegenie-trending-topics');
  if (!container) return;
  
  // Simplified: Guide the user to use sector for ideas
  container.innerHTML = '<div style="padding: 8px; text-align: center; color: #6b7280; font-size: 11px;">Select a sector above and click "Generate Ideas".</div>';
}

// Quick generate - automatically uses first trending topic (like old AI mode)
async function handleQuickGenerate() {
  const btn = document.getElementById('tonegenie-quick-generate-btn');
  const statusDiv = document.getElementById('tonegenie-content-status');
  const container = document.getElementById('tonegenie-ideas-container');
  const contentTypeSelect = document.getElementById('tonegenie-content-type');
  
  if (!apiKey) {
    showContentStatus('Please set your API key in Settings first', 'error');
    return;
  }
  
  // Use sector directly as the topic if available
  const sectorSelect = document.getElementById('tonegenie-sector-select');
  const sector = sectorSelect ? sectorSelect.value : 'AI';
  const topic = sector || 'technology and innovation';
  const contentType = contentTypeSelect.value;
  
  btn.disabled = true;
  btn.textContent = '⏳ Generating...';
  container.innerHTML = '<div style="padding: 20px; text-align: center; color: #6b7280; font-size: 12px;">Generating ideas from selected sector...</div>';
  
  try {
    const ideas = await generateContentIdeas(apiKey, topic, contentType);
    displayIdeasInSidebar(ideas, contentType);
    showContentStatus(`✓ Generated ideas from "${topic}"!`, 'success');
  } catch (error) {
    console.error('Error generating ideas:', error);
    showContentStatus(`Error generating ideas: ${error?.message || 'Unknown error'}`, 'error');
    container.innerHTML = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Quick Generate (from Trending)';
  }
}

async function handleGenerateIdeas() {
  const btn = document.getElementById('tonegenie-generate-ideas-btn');
  const statusDiv = document.getElementById('tonegenie-content-status');
  const container = document.getElementById('tonegenie-ideas-container');
  const nicheInput = document.getElementById('tonegenie-niche-input');
  const contentTypeSelect = document.getElementById('tonegenie-content-type');
  const sectorSelect = document.getElementById('tonegenie-sector-select');
  
  if (!apiKey) {
    showContentStatus('Please set your API key in Settings first', 'error');
    return;
  }
  
  const customNiche = nicheInput.value.trim();
  const contentType = contentTypeSelect.value;
  
  // Fallback to sector if no topic or custom niche chosen
  const sector = sectorSelect ? sectorSelect.value : 'AI';
  const topic = selectedTrendingTopic || customNiche || sector;
  
  btn.disabled = true;
  btn.textContent = 'Generating...';
  container.innerHTML = '<div style="padding: 20px; text-align: center; color: #6b7280; font-size: 12px;">Generating ideas...</div>';
  
  try {
    const ideas = await generateContentIdeas(apiKey, topic, contentType);
    displayIdeasInSidebar(ideas, contentType);
    showContentStatus('✓ Ideas generated!', 'success');
  } catch (error) {
    console.error('Error generating ideas:', error);
    showContentStatus(`Error generating ideas: ${error?.message || 'Unknown error'}`, 'error');
    container.innerHTML = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '💡 Generate Ideas';
  }
}

function showContentStatus(message, type) {
  const statusDiv = document.getElementById('tonegenie-content-status');
  if (!statusDiv) return;
  
  statusDiv.textContent = message;
  statusDiv.className = `tonegenie-content-status ${type}`;
  statusDiv.style.display = 'block';
  
  if (type === 'success') {
    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 3000);
  }
}

async function generateContentIdeas(apiKey, topic, contentType) {
  const isThread = contentType === 'thread';
  const prompt = isThread 
    ? `Generate 3-5 engaging tweet thread ideas about "${topic}". Each thread should be a series of connected tweets that tell a story or explore a topic in depth.

Topic: ${topic}

Requirements:
- Generate 3-5 thread ideas
- Each thread should be engaging and relevant to the topic
- Each thread should have 3-5 connected tweets numbered like "1/", "2/", etc. Each tweet should be under 280 characters and build on the previous one.
- Make them diverse in style and angle
- Include actionable insights, interesting perspectives, or thought-provoking questions
- Format: For threads, number each tweet in the thread (1/, 2/, 3/, etc.)

Return ONLY the ideas, one per line. Separate threads with "---THREAD---". Within each thread, separate tweets with "---TWEET---".`

    : `Generate 5 engaging tweet ideas about "${topic}". Each tweet should be unique, engaging, and relevant to the topic.

Topic: ${topic}

Requirements:
- Generate 5 tweet ideas
- Each tweet should be under 280 characters
- Make them diverse in style and angle
- Include actionable insights, interesting perspectives, or thought-provoking questions
- Number each idea (1., 2., 3., etc.)

Return ONLY the ideas, one per line. Number each idea.`;
  
  // Use existing retry + model pool for robustness
  const initialModel = getNextAvailableModel ? getNextAvailableModel() : FREE_MODELS[0];
  let data;
  try {
    const response = await (typeof fetchWithRetry === 'function'
      ? fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: initialModel,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.9,
            max_tokens: 1200,
            top_p: 1
          })
        }, 3, initialModel)
      : fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: initialModel,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.9,
            max_tokens: 1200,
            top_p: 1
          })
        }));
    
    if (!response.ok) {
      // Try to read error response body if available
      let details = '';
      try {
        const errJson = await response.json();
        details = errJson?.error?.message || JSON.stringify(errJson);
      } catch (_) {
        try {
          details = await response.text();
        } catch (_) {}
      }
      throw new Error(details || `API request failed (${response.status})`);
    }
    data = await response.json();
  } catch (err) {
    throw new Error(`Groq request failed: ${err.message || err}`);
  }
  
  let content = data.choices[0].message.content.trim();
  
  // Parse ideas
  if (isThread) {
    const threads = content.split('---THREAD---').filter(t => t.trim());
    return threads.map(thread => {
      const tweets = thread.split('---TWEET---').filter(t => t.trim()).map(t => t.trim());
      return tweets;
    });
  } else {
    // Split by numbered items
    const ideas = content.split(/\d+\./).filter(item => item.trim()).map(item => item.trim());
    return ideas.slice(0, 5); // Limit to 5
  }
}

function displayIdeasInSidebar(ideas, contentType) {
  const container = document.getElementById('tonegenie-ideas-container');
  if (!container) return;
  
  container.innerHTML = '';
  
  if (contentType === 'thread') {
    ideas.forEach((thread, idx) => {
      const threadDiv = document.createElement('div');
      threadDiv.className = 'tonegenie-idea-item';
      
      const threadLabel = document.createElement('div');
      threadLabel.style.cssText = 'font-weight: 600; margin-bottom: 6px; color: #667eea; font-size: 11px;';
      threadLabel.textContent = `Thread ${idx + 1}`;
      threadDiv.appendChild(threadLabel);
      
      thread.forEach((tweet, tweetIdx) => {
        const tweetDiv = document.createElement('div');
        tweetDiv.className = 'tonegenie-idea-text';
        tweetDiv.style.cssText = 'margin-bottom: 4px; padding-left: 8px; border-left: 2px solid #e5e7eb; font-size: 11px;';
        tweetDiv.textContent = `${tweetIdx + 1}/${thread.length} ${tweet}`;
        threadDiv.appendChild(tweetDiv);
      });
      
      const actions = document.createElement('div');
      actions.className = 'tonegenie-idea-actions';
      
      const copyBtn = document.createElement('button');
      copyBtn.className = 'tonegenie-idea-btn';
      copyBtn.textContent = '📋 Copy';
      copyBtn.addEventListener('click', () => {
        const threadText = thread.map((t, i) => `${i + 1}/${thread.length} ${t}`).join('\n\n');
        navigator.clipboard.writeText(threadText);
        copyBtn.textContent = '✓ Copied!';
        setTimeout(() => copyBtn.textContent = '📋 Copy', 2000);
      });
      
      const insertBtn = document.createElement('button');
      insertBtn.className = 'tonegenie-idea-btn';
      insertBtn.textContent = '📝 Insert';
      insertBtn.addEventListener('click', () => insertIntoTwitterForSidebar(thread));
      
      actions.appendChild(copyBtn);
      actions.appendChild(insertBtn);
      threadDiv.appendChild(actions);
      container.appendChild(threadDiv);
    });
  } else {
    ideas.forEach((idea, idx) => {
      const ideaDiv = document.createElement('div');
      ideaDiv.className = 'tonegenie-idea-item';
      
      const ideaText = document.createElement('div');
      ideaText.className = 'tonegenie-idea-text';
      ideaText.textContent = idea;
      ideaDiv.appendChild(ideaText);
      
      const actions = document.createElement('div');
      actions.className = 'tonegenie-idea-actions';
      
      const copyBtn = document.createElement('button');
      copyBtn.className = 'tonegenie-idea-btn';
      copyBtn.textContent = '📋 Copy';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(idea);
        copyBtn.textContent = '✓ Copied!';
        setTimeout(() => copyBtn.textContent = '📋 Copy', 2000);
      });
      
      const insertBtn = document.createElement('button');
      insertBtn.className = 'tonegenie-idea-btn';
      insertBtn.textContent = '📝 Insert';
      insertBtn.addEventListener('click', () => insertIntoTwitterForSidebar([idea]));
      
      actions.appendChild(copyBtn);
      actions.appendChild(insertBtn);
      ideaDiv.appendChild(actions);
      container.appendChild(ideaDiv);
    });
  }
}

async function insertIntoTwitterForSidebar(content) {
  try {
    // Find the compose box
    const composeSelectors = [
      '[data-testid="tweetTextarea_0"]',
      '[data-testid="tweetTextarea_1"]',
      '[contenteditable="true"][data-testid*="textInput"]',
      'div[contenteditable="true"][role="textbox"]'
    ];
    
    let composeBox = null;
    for (const selector of composeSelectors) {
      composeBox = document.querySelector(selector);
      if (composeBox) break;
    }
    
    if (!composeBox) {
      // Try to open compose box
      const composeBtn = document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
      if (composeBtn) {
        composeBtn.click();
        await new Promise(resolve => setTimeout(resolve, 500));
        
        for (const selector of composeSelectors) {
          composeBox = document.querySelector(selector);
          if (composeBox) break;
        }
      }
    }
    
    if (composeBox) {
      if (content.length === 1) {
        // Single tweet
        const text = content[0];
        composeBox.focus();
        composeBox.textContent = text;
        
        // Trigger input event
        const event = new Event('input', { bubbles: true });
        composeBox.dispatchEvent(event);
      } else {
        // Thread - insert first tweet
        const firstTweet = content[0];
        composeBox.focus();
        composeBox.textContent = firstTweet;
        
        const event = new Event('input', { bubbles: true });
        composeBox.dispatchEvent(event);
        
        // Show message about additional tweets
        showContentStatus(`First tweet inserted! Add remaining ${content.length - 1} tweets manually.`, 'success');
      }
    } else {
      showContentStatus('Could not find compose box. Please open Twitter compose box first.', 'error');
    }
  } catch (error) {
    console.error('Error inserting into Twitter:', error);
    showContentStatus('Error inserting. Please try manually.', 'error');
  }
}

// Format number (e.g., 5000 -> "5K", 1500000 -> "1.5M")
function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

// ==================== HIGHLIGHTS FEATURE ====================

// Store highlights data
const highlightsCache = new Map(); // username -> { tweets: [], lastUpdated: timestamp }

// Load highlights from followed accounts
async function loadHighlights() {
  if (!sidebar || sidebarMode !== 'highlights') return;
  
  const content = sidebar.querySelector('.tonegenie-sidebar-content');
  content.innerHTML = '<div style="padding: 20px; text-align: center; color: #6b7280; font-size: 12px;">Loading highlights...</div>';
  
  try {
    // Get visible tweets from timeline
    const tweetContainers = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
    const highlights = [];
    
    tweetContainers.forEach(container => {
      try {
        const likeCount = getLikeCount(container);
        const retweetCount = getRetweetCount(container);
        const replyCount = getReplyCount(container);
        const username = extractAccountData(container)?.username;
        const tweetText = container.querySelector('[data-testid="tweetText"]')?.textContent || '';
        const tweetLink = container.querySelector('a[href*="/status/"]')?.href;
        
        // Calculate engagement score
        const engagementScore = (likeCount || 0) + (retweetCount || 0) * 2 + (replyCount || 0) * 1.5;
        
        // Only include tweets with significant engagement (threshold: 50)
        if (engagementScore > 50 && username && tweetText) {
          highlights.push({
            username,
            tweetText,
            tweetLink,
            likeCount: likeCount || 0,
            retweetCount: retweetCount || 0,
            replyCount: replyCount || 0,
            engagementScore,
            container
          });
        }
      } catch (e) {
        // Skip invalid containers
      }
    });
    
    // Sort by engagement score (highest first)
    highlights.sort((a, b) => b.engagementScore - a.engagementScore);
    
    // Take top 20 highlights overall (removed per-user limit to show more results)
    // Ensure we show at least 10-20 results if available
    const topHighlights = highlights.slice(0, 20);
    
    updateHighlightsSidebar(topHighlights);
  } catch (error) {
    console.error('tonegenie: Error loading highlights:', error);
    content.innerHTML = '<div style="padding: 20px; text-align: center; color: #e0245e; font-size: 12px;">Error loading highlights. Please try again.</div>';
  }
}

// Update highlights sidebar
function updateHighlightsSidebar(highlights = []) {
  if (!sidebar || sidebarMode !== 'highlights') return;
  
  const content = sidebar.querySelector('.tonegenie-sidebar-content');
  content.innerHTML = '';
  
  if (highlights.length === 0) {
    content.innerHTML = '<div style="padding: 20px; text-align: center; color: #6b7280; font-size: 12px;">No highlights found. Scroll through your timeline to discover highlights!</div>';
    return;
  }
  
  highlights.forEach((tweet, index) => {
    const item = document.createElement('div');
    item.className = 'tonegenie-opportunity-item';
    item.style.cssText = 'margin-bottom: 12px;';
    
    // Username
    const username = document.createElement('div');
    username.className = 'tonegenie-opportunity-username';
    username.textContent = `@${tweet.username}`;
    item.appendChild(username);
    
    // Tweet text
    const text = document.createElement('div');
    text.className = 'tonegenie-opportunity-text';
    text.textContent = tweet.tweetText.substring(0, 200) + (tweet.tweetText.length > 200 ? '...' : '');
    item.appendChild(text);
    
    // Stats
    const stats = document.createElement('div');
    stats.className = 'tonegenie-opportunity-stats';
    stats.innerHTML = `
      <span>❤️ ${formatNumber(tweet.likeCount)}</span>
      <span>🔄 ${formatNumber(tweet.retweetCount)}</span>
      <span>💬 ${formatNumber(tweet.replyCount)}</span>
      <span>⭐ ${formatNumber(Math.round(tweet.engagementScore))}</span>
    `;
    item.appendChild(stats);
    
    // Actions
    const actions = document.createElement('div');
    actions.className = 'tonegenie-opportunity-actions';
    
    const viewBtn = document.createElement('button');
    viewBtn.className = 'tonegenie-opportunity-btn';
    viewBtn.textContent = '👁️ View';
    viewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tweet.tweetLink) {
        window.open(tweet.tweetLink, '_blank');
      } else if (tweet.container) {
        scrollToTweet(tweet.container, null);
      }
    });
    actions.appendChild(viewBtn);
    
    item.appendChild(actions);
    
    // Click handler
    item.addEventListener('click', (e) => {
      if (!e.target.closest('.tonegenie-opportunity-btn')) {
        if (tweet.tweetLink) {
          window.open(tweet.tweetLink, '_blank');
        } else if (tweet.container) {
          scrollToTweet(tweet.container, null);
        }
      }
    });
    
    content.appendChild(item);
  });
}

// ==================== VIRAL TWEETS FEATURE ====================

// Load viral tweets
async function loadViralTweets() {
  if (!sidebar || sidebarMode !== 'viral') return;
  
  const content = sidebar.querySelector('.tonegenie-sidebar-content');
  content.innerHTML = '<div style="padding: 20px; text-align: center; color: #6b7280; font-size: 12px;">Scanning for viral tweets...</div>';
  
  try {
    // Get visible tweets from timeline
    const tweetContainers = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
    const viralTweets = [];
    
    tweetContainers.forEach(container => {
      try {
        const likeCount = getLikeCount(container) || 0;
        const retweetCount = getRetweetCount(container) || 0;
        const replyCount = getReplyCount(container) || 0;
        const username = extractAccountData(container)?.username;
        const tweetText = container.querySelector('[data-testid="tweetText"]')?.textContent || '';
        const tweetLink = container.querySelector('a[href*="/status/"]')?.href;
        const timestamp = getTweetTimestamp(container);
        
        // Calculate viral score (higher weight for recent + high engagement)
        const totalEngagement = likeCount + retweetCount * 2 + replyCount * 1.5;
        const age = timestamp ? (Date.now() - timestamp) / (1000 * 60 * 60) : 24; // hours
        const viralScore = totalEngagement / Math.max(age, 1); // engagement per hour
        
        // Threshold: 100 engagement per hour or 1000+ total engagement
        if ((viralScore > 100 || totalEngagement > 1000) && username && tweetText) {
          viralTweets.push({
            username,
            tweetText,
            tweetLink,
            likeCount,
            retweetCount,
            replyCount,
            totalEngagement,
            viralScore,
            age,
            container
          });
        }
      } catch (e) {
        // Skip invalid containers
      }
    });
    
    // Sort by viral score
    viralTweets.sort((a, b) => b.viralScore - a.viralScore);
    
    updateViralTweetsSidebar(viralTweets.slice(0, 20));
  } catch (error) {
    console.error('tonegenie: Error loading viral tweets:', error);
    content.innerHTML = '<div style="padding: 20px; text-align: center; color: #e0245e; font-size: 12px;">Error loading viral tweets. Please try again.</div>';
  }
}

// Update viral tweets sidebar
function updateViralTweetsSidebar(viralTweets = []) {
  if (!sidebar || sidebarMode !== 'viral') return;
  
  const content = sidebar.querySelector('.tonegenie-sidebar-content');
  content.innerHTML = '';
  
  if (viralTweets.length === 0) {
    content.innerHTML = '<div style="padding: 20px; text-align: center; color: #6b7280; font-size: 12px;">No viral tweets found. Keep scrolling to discover viral content!</div>';
    return;
  }
  
  viralTweets.forEach((tweet) => {
    const item = document.createElement('div');
    item.className = 'tonegenie-opportunity-item';
    item.style.cssText = 'margin-bottom: 12px; border-left: 3px solid #dc2626;';
    
    // Viral badge
    const badge = document.createElement('div');
    badge.style.cssText = 'font-size: 10px; font-weight: 600; color: #dc2626; text-transform: uppercase; margin-bottom: 8px;';
    badge.textContent = `🔥 VIRAL - ${Math.round(tweet.viralScore)}/hr`;
    item.appendChild(badge);
    
    // Username
    const username = document.createElement('div');
    username.className = 'tonegenie-opportunity-username';
    username.textContent = `@${tweet.username}`;
    item.appendChild(username);
    
    // Tweet text
    const text = document.createElement('div');
    text.className = 'tonegenie-opportunity-text';
    text.textContent = tweet.tweetText.substring(0, 200) + (tweet.tweetText.length > 200 ? '...' : '');
    item.appendChild(text);
    
    // Stats
    const stats = document.createElement('div');
    stats.className = 'tonegenie-opportunity-stats';
    stats.innerHTML = `
      <span>❤️ ${formatNumber(tweet.likeCount)}</span>
      <span>🔄 ${formatNumber(tweet.retweetCount)}</span>
      <span>💬 ${formatNumber(tweet.replyCount)}</span>
      <span>📊 ${formatNumber(Math.round(tweet.totalEngagement))}</span>
    `;
    item.appendChild(stats);
    
    // Actions
    const actions = document.createElement('div');
    actions.className = 'tonegenie-opportunity-actions';
    
    const viewBtn = document.createElement('button');
    viewBtn.className = 'tonegenie-opportunity-btn';
    viewBtn.textContent = '👁️ View';
    viewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tweet.tweetLink) {
        window.open(tweet.tweetLink, '_blank');
      } else if (tweet.container) {
        scrollToTweet(tweet.container, null);
      }
    });
    actions.appendChild(viewBtn);
    
    item.appendChild(actions);
    
    // Click handler
    item.addEventListener('click', (e) => {
      if (!e.target.closest('.tonegenie-opportunity-btn')) {
        if (tweet.tweetLink) {
          window.open(tweet.tweetLink, '_blank');
        } else if (tweet.container) {
          scrollToTweet(tweet.container, null);
        }
      }
    });
    
    content.appendChild(item);
  });
}

// ==================== HELPER FUNCTIONS ====================

// Manual test function
window.testTonegenie = function() {
  console.log('tonegenie: Manual test triggered');
  console.log('tonegenie: API key exists:', !!apiKey);
  if (apiKey) {
    scanAndInject();
    initComposeFeatures();
  } else {
    console.error('tonegenie: No API key found! Please set it in the extension popup.');
  }
};