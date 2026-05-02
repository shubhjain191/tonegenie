let apiKey = null;
let openRouterKey = null;
let generationCount = 0;
const recentInsertions = new WeakMap();
const insertLocks = new WeakMap();
const containerGenerationLocks = new WeakMap();
const recentProgrammaticComposeWrites = new WeakMap();

// Robust global session-wide locking for insertions
let globalLastInsertSig = '';
let globalLastInsertTime = 0;
let composeMutationPausedUntil = 0;
const COMPOSE_MUTATION_COOLDOWN_MS = 350;
const PROGRAMMATIC_WRITE_TRACK_MS = 1500;

// Global states to prevent multiple initializations
let mainObserver = null;
let hashtagMonitorInterval = null;
let trendingUpdateInterval = null;
let isInitializing = false;

function pauseComposeMutationHandling(ms = COMPOSE_MUTATION_COOLDOWN_MS) {
  composeMutationPausedUntil = Math.max(composeMutationPausedUntil, Date.now() + ms);
}

function isComposeMutationHandlingPaused() {
  return Date.now() < composeMutationPausedUntil;
}

function markProgrammaticComposeWrite(replyBox, insertedText, cooldownMs = COMPOSE_MUTATION_COOLDOWN_MS) {
  if (!replyBox) return;
  recentProgrammaticComposeWrites.set(replyBox, {
    signature: normalizeWhitespace(insertedText),
    expiresAt: Date.now() + PROGRAMMATIC_WRITE_TRACK_MS
  });
  pauseComposeMutationHandling(cooldownMs);
}

function isRecentProgrammaticComposeWrite(replyBox, textToCheck = '') {
  if (!replyBox) return false;
  const record = recentProgrammaticComposeWrites.get(replyBox);
  if (!record) return false;
  if (Date.now() > record.expiresAt) {
    recentProgrammaticComposeWrites.delete(replyBox);
    return false;
  }
  if (!textToCheck) return true;
  return record.signature === normalizeWhitespace(textToCheck);
}

function getActiveComposeTextArea() {
  const composeSelectors = [
    '[data-testid="tweetTextarea_0"][contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"][data-testid*="tweetTextarea"]',
    '[contenteditable="true"][aria-label*="What\'s happening"]',
    '[contenteditable="true"][aria-label*="Post"]',
    '[contenteditable="true"][aria-label*="Tweet"]'
  ];

  for (const selector of composeSelectors) {
    const candidate = document.querySelector(selector);
    if (candidate && candidate.getAttribute('contenteditable') === 'true') {
      return candidate;
    }
  }

  return null;
}

function getSharedInsertGuardState() {
  if (typeof window === 'undefined') return null;
  if (!window.__tonegenieInsertGuard) {
    window.__tonegenieInsertGuard = { sig: '', ts: 0 };
  }
  return window.__tonegenieInsertGuard;
}

function passesSharedInsertGuard(normalizedText, now, ttlMs = 5000) {
  const guard = getSharedInsertGuardState();
  if (!guard) return true;
  if (guard.sig === normalizedText && (now - guard.ts) < ttlMs) {
    return false;
  }
  guard.sig = normalizedText;
  guard.ts = now;
  return true;
}

function isElementVisible(element) {
  if (!element || !element.getBoundingClientRect) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function resolveReplyBox(selector = null) {
  const candidates = [];
  const seen = new Set();

  const addCandidate = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    candidates.push(node);
  };

  addCandidate(composeTextArea);
  addCandidate(getActiveComposeTextArea());

  if (selector) {
    const selectorParts = selector.split(',').map(s => s.trim()).filter(Boolean);
    selectorParts.forEach((part) => {
      try {
        document.querySelectorAll(part).forEach(addCandidate);
      } catch {
        // Ignore invalid selector fragments.
      }
    });
  }

  const editable = candidates.filter(node => node && node.getAttribute && node.getAttribute('contenteditable') === 'true');
  if (editable.length === 0) return null;
  return editable.find(isElementVisible) || editable[0];
}

function dedupeInsertedTextIfRepeated(replyBox, expectedText) {
  if (!replyBox || !expectedText) return false;
  const normalizedExpected = normalizeWhitespace(expectedText);
  if (!normalizedExpected) return false;

  const currentTextRaw = replyBox.innerText || replyBox.textContent || '';
  const normalizedCurrent = normalizeWhitespace(currentTextRaw);
  if (!normalizedCurrent) return false;

  const doubled = `${normalizedExpected} ${normalizedExpected}`;
  if (normalizedCurrent !== doubled) return false;

  document.execCommand('selectAll', false, null);
  const rewritten = document.execCommand('insertText', false, expectedText);
  if (!rewritten) return false;

  replyBox.dispatchEvent(new InputEvent('input', { bubbles: true }));
  return true;
}

// Load generation count from storage
async function loadGenerationCount() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.storage?.local) {
      const data = await chrome.storage.local.get(['generationCount']);
      generationCount = data.generationCount || 0;
    }
  } catch (e) {
    if (e.message?.includes('Extension context invalidated')) return;
    console.error('tonegenie: Error loading generation count:', e);
  }
}

// Increment and save generation count
async function incrementGenerationCount() {
  generationCount++;
  
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.storage?.local) {
      await chrome.storage.local.set({ generationCount });
    }
  } catch (e) {
    if (e.message?.includes('Extension context invalidated')) return;
    console.error('tonegenie: Error saving generation count:', e);
  }
}

// Rate limiting and request tracking
// Rate limiting and request tracking
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 6000; // Increased to 6 seconds to avoid OpenRouter 429s
const MAX_REQUESTS_PER_MINUTE = 30; // Slow but reliable
let requestTimestamps = [];
let waitingRateLimitRequests = 0;

// Best, free April 2026 Groq models (gpt-oss series leads for speed/quality)
const FREE_MODELS = [
  'llama-3.3-70b-versatile',                        // stable production high quality
  'llama-3.1-8b-instant'                            // super fast, very reliable
];

// Analysis queue to prevent 429 errors from too many simultaneous requests
let analysisQueue = [];
let pendingAnalysisCount = 0;
const MAX_CONCURRENT_ANALYSIS = 1;

// Fallback: Free OpenRouter models (only high quality ones)
const OPENROUTER_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
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

const NATURAL_FALLBACKS = [
  'interesting point!',
  'totally agree with this',
  'this is a solid take',
  'really makes you think',
  'couldn\'t have said it better',
  'love the energy here',
  'definitely something to consider',
  'great observation',
  'spot on!',
  'this is so true',
  'actually a really good point',
  'love this perspective',
  'underrated point right here',
  'vibes are immaculate',
  'honestly such a mood'
];
const MAX_COMMENT_CHARS = 120;
const STYLE_MIX_COMPATIBILITY = {
  funny: ['relatable', 'conversational'],
  friendly: ['relatable', 'supportive', 'conversational'],
  supportive: ['friendly', 'thoughtful'],
  sarcastic: ['funny', 'analytical'],
  enthusiastic: ['friendly', 'inspirational'],
  analytical: ['friendly', 'thoughtful', 'conversational'],
  professional: ['analytical', 'friendly'],
  dataDriven: ['analytical', 'professional'],
  thoughtful: ['analytical', 'relatable'],
  relatable: ['friendly', 'conversational'],
  agree: ['friendly', 'relatable'],
  disagree: ['analytical', 'thoughtful'],
  conversational: ['friendly', 'relatable'],
  inspirational: ['supportive', 'friendly'],
  hinglish: ['relatable', 'conversational'],
  birthdayWish: ['friendly', 'supportive'],
  question: ['relatable', 'friendly', 'analytical']
};

function clampCommentLength(text, maxChars = MAX_COMMENT_CHARS) {
  const source = (text || '').toString().trim();
  const chars = Array.from(source);
  if (chars.length <= maxChars) {
    return source;
  }

  let trimmed = chars.slice(0, maxChars).join('').trim();
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace > Math.floor(maxChars * 0.65)) {
    trimmed = trimmed.slice(0, lastSpace).trim();
  }
  return trimmed;
}

function normalizeWhitespace(text) {
  if (!text) return '';
  // Convert non-breaking spaces and other weird whitespaces to normal spaces
  const normalized = text.toString().replace(/[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g, ' ');
  return normalized.replace(/\s+/g, ' ').trim();
}

function hasLoopingRepetition(text) {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) return false;

  const words = normalized.split(' ').filter(Boolean);
  if (words.length < 20) return false;

  // Detect repeated 5-word chunks (common "AI loop" symptom)
  const seenChunks = new Map();
  for (let i = 0; i <= words.length - 5; i++) {
    const chunk = words.slice(i, i + 5).join(' ');
    seenChunks.set(chunk, (seenChunks.get(chunk) || 0) + 1);
    if ((seenChunks.get(chunk) || 0) >= 3) {
      return true;
    }
  }

  // Detect low lexical variety in long text
  const uniqueRatio = new Set(words).size / words.length;
  return words.length >= 40 && uniqueRatio < 0.38;
}

function straightenQuotesAndDashes(text) {
  if (!text) return '';
  return text
    .toString()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-');
}

function stripChatbotCorrespondence(text) {
  if (!text) return '';
  let out = text.toString().trim();
  out = out.replace(/^(great question|good question|sure|certainly|of course|absolutely)[!.:,]?\s+/i, '');
  out = out.replace(/\b(i hope this helps|let me know if you('d)? like|here('s| is) (a|an|the))\b.*$/i, '');
  return out.trim();
}

function mergeChoppyMicroSentences(text) {
  const raw = (text || '').toString().trim();
  if (!raw) return '';

  // Split on sentence-ending punctuation while keeping it simple for short social replies.
  const parts = raw.split(/(?<=[.!?])\s+/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 3) return raw;

  const wordCount = (s) => normalizeWhitespace(s).split(' ').filter(Boolean).length;
  const merged = [];
  let i = 0;
  while (i < parts.length) {
    const a = parts[i];
    const b = parts[i + 1];
    const c = parts[i + 2];
    if (b && c && wordCount(a) < 6 && wordCount(b) < 6 && wordCount(c) < 6) {
      merged.push(`${a.replace(/[.!?]+$/g, '')} ${b.replace(/[.!?]+$/g, '')} ${c}`.trim());
      i += 3;
      continue;
    }
    merged.push(a);
    i += 1;
  }
  return merged.join(' ').replace(/\s+/g, ' ').trim();
}

function commentHasAiTellSignals(text) {
  const t = normalizeWhitespace(text).toLowerCase();
  if (!t) return false;

  const bannedPhrases = [
    'as a large language model',
    'based on available information',
    'while specific details',
    'industry observers',
    'experts argue',
    'some critics argue',
    'observers have',
    'independent coverage',
    'national media outlets',
    'written by a leading expert',
    'featured in',
    'in today\'s rapidly evolving',
    'rapidly evolving',
    'exciting times lie ahead',
    'the future looks bright',
    'hope this helps',
    'let me know',
    'moreover',
    'furthermore',
    'additionally',
    'it\'s worth noting',
    'it is worth noting',
    'needless to say',
    'at the end of the day',
    'here is an',
    'here\'s an',
    'unpack',
    'dive into',
    'leverage',
    'synergy',
    'paradigm shift',
    'game-changer',
    'game changer',
    'watershed moment',
    'holistic',
    'actionable',
    'nestled',
    'breathtaking',
    'groundbreaking',
    'transformative',
    'underscores',
    'highlights the importance',
    'serves as a',
    'stands as a',
    'marks a pivotal',
    'testament to',
    'tapestry',
    'intricate interplay',
    'foster alignment',
    'it is important to note',
    'in order to',
    'at this point in time',
    'could potentially',
    'might perhaps'
  ];

  if (bannedPhrases.some(p => t.includes(p))) return true;

  const bannedWords = [
    'testament',
    'pivotal',
    'landscape',
    'tapestry',
    'underscore',
    'vibrant',
    'delve',
    'garner',
    'crucial',
    'foster',
    'showcase',
    'intricate',
    'enduring',
    'groundbreaking',
    'transformative',
    'seamless',
    'robust',
    'synergy',
    'leverage',
    'impactful',
    'holistic',
    'unpack',
    'navigate',
    'journey',
    'resonate',
    'ecosystem'
  ];

  const tokens = t.match(/[a-z]{3,}/g) || [];
  if (tokens.some(tok => bannedWords.includes(tok))) return true;

  // Machine-gun micro-sentences: 3+ consecutive segments under 6 words (split on whitespace chunks).
  const chunks = t.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  let run = 0;
  for (const chunk of chunks) {
    const wc = chunk.split(/\s+/).filter(Boolean).length;
    if (wc > 0 && wc < 6) run++;
    else run = 0;
    if (run >= 3) return true;
  }

  return false;
}

function humanizeCommentSurface(text) {
  let out = straightenQuotesAndDashes(text);
  out = stripChatbotCorrespondence(out);
  out = mergeChoppyMicroSentences(out);
  return normalizeWhitespace(out);
}

async function rewriteCommentToRemoveAiTells(draftComment, tweetText, uiHooks = {}) {
  const tweetSnippet = normalizeWhitespace((tweetText || '').toString()).slice(0, 220);
  const draftSnippet = normalizeWhitespace((draftComment || '').toString()).slice(0, 220);

  const revisionUserPrompt = `You are editing a short Twitter/X reply.

Tweet (context): "${tweetSnippet}"

Draft reply (may sound AI-ish): "${draftSnippet}"

Rewrite into ONE final reply only.
Hard requirements:
- ${MAX_COMMENT_CHARS} characters max
- sentence case (only first letter capitalized)
- minimal punctuation
- sound like a real person texting
- keep the same meaning/intent as the draft
- do not add new facts, stats, names, studies, or citations
- avoid Wikipedia/press-release tone
- avoid collaborative chatbot language ("hope this helps", "let me know", "great question")
- avoid significance puffery and vague attributions
- vary rhythm: not all micro-sentences; not all same-length sentences
- no emojis unless the tweet clearly expects one (rare)

Return ONLY the final reply text.`;

  const initialModelData = getNextAvailableModel();
  const response = await fetchWithRetry(null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        {
          role: 'system',
          content: `You rewrite short Twitter/X replies to remove obvious AI-generated tells while keeping the same meaning.

Hard bans:
- No collaborative chatbot language ("great question", "hope this helps", "let me know", "here is")
- No significance inflation / press-release tone (pivotal, testament, landscape, tapestry, underscores, transformative, groundbreaking, vibrant, holistic, synergy, ecosystem)
- No vague authority claims ("experts say", "industry reports", "observers note", "featured in", "independent coverage")
- No filler hedges ("moreover", "furthermore", "additionally", "in order to", "at the end of the day", "it is important to note")
- No fake depth -ing tails ("highlighting...", "reflecting...", "contributing to...")
- No negative parallelism ("not just x it's y")
- No machine-gun micro-sentence chains; vary rhythm
- No emojis unless clearly required by the tweet itself

Return ONLY the final reply text. No quotes. No explanations.`
        },
        { role: 'user', content: revisionUserPrompt }
      ],
      temperature: 0.55,
      max_tokens: 120,
      top_p: 1
    })
  }, 2, initialModelData, uiHooks.onRateLimitStatus);

  const data = await response.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

function getMixedStyle(primaryStyle, tweetText) {
  const compatible = STYLE_MIX_COMPATIBILITY[primaryStyle] || [];
  if (compatible.length === 0) {
    return { primaryStyle, secondaryStyle: null };
  }

  const hashSeed = Array.from(`${primaryStyle}:${tweetText || ''}`).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const secondaryStyle = compatible[hashSeed % compatible.length] || null;
  return { primaryStyle, secondaryStyle };
}

function decodeHtmlEntities(value) {
  if (!value) return '';
  return value
    .toString()
    .replace(/&amp;/g, '&')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getKeywordSet(text) {
  return new Set(
    (decodeHtmlEntities(text).toLowerCase().match(/[a-z0-9]{4,}/g) || [])
      .filter(token => token.length >= 4)
  );
}


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
if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.storage?.local) {
  try {
    chrome.storage.local.get(['apiKey', 'openRouterKey'], (result) => {
      if (chrome.runtime?.id) {
        if (result.apiKey) {
          apiKey = result.apiKey;
          openRouterKey = result.openRouterKey || null;
          console.log('tonegenie: API keys loaded');
          initExtension();
        } else {
          console.log('tonegenie: No Groq API key found');
        }
      }
    });
  } catch (e) {
    if (!e.message?.includes('Extension context invalidated')) {
      console.error('tonegenie: Error accessing chrome storage:', e);
    }
  }
}

// Listen for messages
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Check if context is still valid
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;

    if (request.action === 'apiKeyUpdated') {
      try {
        chrome.storage.local.get(['apiKey', 'openRouterKey'], (result) => {
          if (chrome.runtime?.id) {
            apiKey = result.apiKey;
            openRouterKey = result.openRouterKey || null;
            console.log('tonegenie: API keys updated');
            initExtension();
            initComposeFeatures();
            sendResponse({ success: true });
          }
        });
      } catch (e) {
        if (!e.message?.includes('Extension context invalidated')) throw e;
      }
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
}

function initExtension() {
  if (!apiKey || isInitializing) return;
  isInitializing = true;
  
  console.log('tonegenie: Initializing...');
  
  // Cleanup existing observer if any
  if (mainObserver) {
    mainObserver.disconnect();
    mainObserver = null;
  }
  
  // Load generation count
  loadGenerationCount();
  
  // Scan and inject buttons
  scanAndInject();
  
  // Initialize compose box features (hashtag suggestions)
  initComposeFeatures();
  
  // Watch for new containers (like Whisper AI does)
  mainObserver = new MutationObserver((mutations) => {
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

  mainObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  isInitializing = false;
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
- If tweet is about birthday → include "birthdayWish"
- If tweet is professional → include "professional", "analytical", or "dataDriven"
- If tweet is funny → include "funny" or "sarcastic"
- If tweet is emotional → include "supportive", "thoughtful", or "relatable"

Return ONLY the JSON array, nothing else.`;

    const initialModelData = getNextAvailableModel();
    const response = await fetchWithRetry(null, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3, // Lower temperature for more consistent suggestions
        max_tokens: 100,
        top_p: 1
      })
    }, 2, initialModelData); // Only 2 retries for suggestions to keep it fast

    const data = await response.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('Invalid API response structure');
    }

    const content = (data.choices[0].message.content || '').trim();
    
    // Try to parse JSON from response
    let parsedSuggestions = [];
    if (content) {
      try {
        // More robust JSON array extraction
        let possibleJson = content;
        const jsonMatch = content.match(/\[\s*["'][\s\S]*?["']\s*\]/); // match array with at least one quoted string
        if (jsonMatch) {
          possibleJson = jsonMatch[0];
        } else {
          // Try to find first [ and last ]
          const start = content.indexOf('[');
          const end = content.lastIndexOf(']') + 1;
          if (start !== -1 && end > start) {
            possibleJson = content.substring(start, end);
          }
        }
        
        // Clean up common AI markdown or artifacts
        possibleJson = possibleJson.replace(/```json/g, '').replace(/```/g, '').trim();
        
        const parsed = JSON.parse(possibleJson);
        if (Array.isArray(parsed)) {
          parsedSuggestions = sanitizeStyleArray(parsed);
        }
      } catch (e) {
        console.log('tonegenie: Could not parse suggestions JSON. Content:', content.substring(0, 100));
      }
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

  // Never inject action buttons inside X compose/reply dialogs.
  // Modal controls (close/back) must remain fully native.
  if (container.closest('[role="dialog"]')) {
    return;
  }

  // Find the tweet action row (reply button container)
  const replyButton = container.querySelector('[data-testid="reply"], [aria-label*="Reply"], [aria-label*="reply"]');
  
  if (!replyButton) {
    return;
  }

  // Find the row that contains the reply button
  const row = replyButton.closest('div[role="group"]') || replyButton.parentElement;
  
  if (!row || !row.parentNode) {
    console.log('tonegenie: Could not find row or parent');
    return;
  }

  // FINAL SAFETY: If the row already has buttons from a parent container's injection, abort.
  if (row.parentNode.querySelector('.ai-comment-buttons')) {
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
    question: { emoji: '❓', text: 'question' }
  };

  // Helper function to check if style is suggested
  const isSuggested = (style) => suggestedStylesSet.has(style);

  // Helper function to update button highlighting
  const updateButtonHighlight = (button, style) => {
    if (isSuggested(style)) {
      button.style.cssText = `
        background: linear-gradient(135deg, rgba(34, 197, 94, 0.15) 0%, rgba(34, 197, 94, 0.08) 100%);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        color: #16a34a;
        border: 1.5px solid rgba(34, 197, 94, 0.4);
        border-radius: 20px;
        padding: 0 10px;
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
        margin-right: 8px;
        margin-bottom: 6px;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        line-height: 1;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        white-space: nowrap;
        box-shadow: 0 2px 8px rgba(34, 197, 94, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.2);
      `;
    } else {
      button.style.cssText = `
        background: linear-gradient(135deg, rgba(29, 155, 240, 0.1) 0%, rgba(29, 155, 240, 0.05) 100%);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        color: #1d9bf0;
        border: 1px solid rgba(29, 155, 240, 0.25);
        border-radius: 20px;
        padding: 0 10px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        margin-right: 8px;
        margin-bottom: 6px;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        line-height: 1;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        white-space: nowrap;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
      `;
    }
  };

  // Create buttons (like Whisper AI sentiment buttons)
  const buttonElements = new Map(); // Store buttons for later updates
  
  Object.entries(buttonStyles).forEach(([style, { emoji, text }]) => {
    const button = document.createElement('button');
    button.className = 'ai-style-btn';
    button.type = 'button';
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
      button.style.transform = 'translateY(-1.5px)';
      if (isSuggested(style)) {
        button.style.background = 'linear-gradient(135deg, rgba(34, 197, 94, 0.25) 0%, rgba(34, 197, 94, 0.15) 100%)';
        button.style.boxShadow = '0 4px 12px rgba(34, 197, 94, 0.25)';
      } else {
        button.style.background = 'linear-gradient(135deg, rgba(29, 155, 240, 0.18) 0%, rgba(29, 155, 240, 0.1) 100%)';
        button.style.boxShadow = '0 4px 12px rgba(29, 155, 240, 0.15)';
      }
    });

    button.addEventListener('mouseout', () => {
      button.style.transform = '';
      updateButtonHighlight(button, style);
    });

    // Click handler
    button.addEventListener('click', async (e) => {
      await handleButtonClick(e, container, style);
    });

    buttonsContainer.appendChild(button);
  });

  // Only start analysis when the tweet is actually visible in the viewport
  if (tweetText.length > 10 && apiKey) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          console.log('tonegenie: Tweet visible, enqueuing analysis...');
          
          const queueAnalysis = () => {
            analyzeTweetAndSuggestStyles(tweetText).then(suggestions => {
              if (suggestions && Array.isArray(suggestions) && suggestions.length === 3) {
                suggestedStylesSet = new Set(suggestions);
                buttonElements.forEach((button, style) => {
                  updateButtonHighlight(button, style);
                });
                if (suggestedLabel.parentNode) {
                  suggestedLabel.style.display = 'block';
                }
              }
            }).catch(error => {
              console.log('tonegenie: Could not get suggestions:', error);
            }).finally(() => {
              pendingAnalysisCount--;
              processAnalysisQueue();
            });
          };

          analysisQueue.push(queueAnalysis);
          processAnalysisQueue();
          
          // Once we've queued the analysis, we don't need to observe this tweet anymore
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 }); // Trigger when 10% of the tweet is visible

    observer.observe(container);
  }

  // Insert BELOW the row (exactly like Whisper AI)
  if (row.parentNode) {
    const nextSibling = row.nextSibling;
    
    row.parentNode.insertBefore(buttonsContainer, nextSibling);
    row.parentNode.insertBefore(suggestedLabel, buttonsContainer);
    
    console.log('tonegenie: ✅ Buttons injected successfully');
  }
}

// Process the next analysis request in the queue
function processAnalysisQueue() {
  if (pendingAnalysisCount < MAX_CONCURRENT_ANALYSIS && analysisQueue.length > 0) {
    pendingAnalysisCount++;
    const analyzeRequest = analysisQueue.shift();
    analyzeRequest();
  }
}

async function handleButtonClick(e, container, style) {
  if (!apiKey) {
    console.error('tonegenie: No API key');
    return;
  }

  if (containerGenerationLocks.get(container)) return;
  containerGenerationLocks.set(container, true);

  const button = e.currentTarget;
  if (button.dataset.generating === '1') return;
  button.dataset.generating = '1';
  button.disabled = true;
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
    const comment = await generateComment(tweetText, style, {
      onRateLimitStatus: ({ phase, queuePosition, remainingMs }) => {
        if (phase === 'waiting') {
          const remainingSeconds = Math.max(1, Math.ceil((remainingMs || 0) / 1000));
          button.innerHTML = `<span style="opacity: 0.8">Queue #${queuePosition} · ${remainingSeconds}s</span>`;
        } else if (phase === 'ready') {
          button.innerHTML = '<span style="opacity: 0.7">Generating...</span>';
        }
      }
    });

    // Find reply button and click it
    const replyButton = container.querySelector('[data-testid="reply"], [aria-label*="Reply"], [aria-label*="reply"]');
    if (!replyButton) {
      throw new Error('Reply button not found');
    }

    replyButton.click();

    // Wait for reply box to appear and insert comment
    setTimeout(async () => {
      try {
        await insertIntoTwitter(null, comment);
        
        // Increment and update generation count
        incrementGenerationCount();
        
        button.innerHTML = '<span style="color: #1d9bf0">Done!</span>';
        setTimeout(() => {
          button.innerHTML = originalContent;
          button.style.cursor = 'pointer';
          button.disabled = false;
          button.dataset.generating = '0';
          containerGenerationLocks.set(container, false);
        }, 2000);
      } catch (error) {
        console.error('tonegenie: Error inserting comment:', error);
        button.innerHTML = '<span style="color: #e0245e">Try again</span>';
        setTimeout(() => {
          button.innerHTML = originalContent;
          button.style.cursor = 'pointer';
          button.disabled = false;
          button.dataset.generating = '0';
          containerGenerationLocks.set(container, false);
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
      button.disabled = false;
      button.dataset.generating = '0';
      containerGenerationLocks.set(container, false);
    }, 3000);
  }
}

// Rate limiting helper
async function waitForRateLimit(onStatusUpdate = null) {
  const now = Date.now();
  let totalWaitMs = 0;
  
  // Check if we've hit the per-minute limit
  if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    const oldestRequest = requestTimestamps[0];
    const waitTime = 60000 - (now - oldestRequest);
    if (waitTime > 0) {
      totalWaitMs += waitTime;
    }
  }
  
  // Ensure minimum interval between requests
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    totalWaitMs += waitTime;
  }

  if (totalWaitMs > 0) {
    waitingRateLimitRequests++;
    const queuePosition = waitingRateLimitRequests;
    console.log(`tonegenie: Rate limit queue #${queuePosition}, waiting ${Math.ceil(totalWaitMs / 1000)}s`);

    try {
      let remainingMs = totalWaitMs;
      while (remainingMs > 0) {
        if (typeof onStatusUpdate === 'function') {
          onStatusUpdate({ phase: 'waiting', queuePosition, remainingMs });
        }
        const step = Math.min(1000, remainingMs);
        await new Promise(resolve => setTimeout(resolve, step));
        remainingMs -= step;
      }
    } finally {
      waitingRateLimitRequests = Math.max(0, waitingRateLimitRequests - 1);
      if (typeof onStatusUpdate === 'function') {
        onStatusUpdate({ phase: 'ready', queuePosition: 0, remainingMs: 0 });
      }
    }
  }
  
  lastRequestTime = Date.now();
  requestTimestamps.push(lastRequestTime);
}

// Get next available model
function getNextAvailableModel() {
  // 1. Try Groq (FREE_MODELS)
  const availableGroq = FREE_MODELS.filter(m => !rateLimitedModels.has(m));
  if (availableGroq.length > 0) {
    // Try to take the next one in sequence to distribute load
    const currentModel = FREE_MODELS[currentModelIndex];
    if (availableGroq.includes(currentModel)) {
      return { id: currentModel, provider: 'groq' };
    }
    const model = availableGroq[0];
    currentModelIndex = FREE_MODELS.indexOf(model);
    return { id: model, provider: 'groq' };
  }

  // 2. Try OpenRouter if Groq is fully rate-limited and we have a key
  if (openRouterKey) {
    const availableOR = OPENROUTER_MODELS.filter(m => !rateLimitedModels.has(m));
    if (availableOR.length > 0) {
      console.log('tonegenie: All Groq models rate limited, switching to OpenRouter fallback');
      return { id: availableOR[0], provider: 'openrouter' };
    }
  }

  // 3. Fallback: reset everything if all models (Groq + OR) are rate limited
  console.log('tonegenie: All models rate limited, resetting labels and trying first model...');
  rateLimitedModels.clear();
  modelRateLimitTimes = {};
  currentModelIndex = 0;
  return { id: FREE_MODELS[0], provider: 'groq' };
}

// Retry with exponential backoff and model fallback
async function fetchWithRetry(ignoreUrl, options, maxRetries = 3, modelData = null, onRateLimitStatus = null) {
  if (!modelData) {
    modelData = getNextAvailableModel();
  }
  
  const { id: model, provider } = modelData;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await waitForRateLimit(onRateLimitStatus);
      
      // Select API endpoint and key based on provider
      const apiUrl = provider === 'groq' 
        ? 'https://api.groq.com/openai/v1/chat/completions' 
        : 'https://openrouter.ai/api/v1/chat/completions';
      
      const authKey = provider === 'groq' ? apiKey : openRouterKey;
      
      if (!authKey) {
        throw new Error(`No API key found for provider: ${provider}`);
      }

      // Update model in request body
      const requestBody = JSON.parse(options.body);
      requestBody.model = model;
      
      // Build final options
      const finalHeaders = {
        ...options.headers,
        'Authorization': `Bearer ${authKey}`
      };

      if (provider === 'openrouter') {
        finalHeaders['HTTP-Referer'] = 'https://twitter.com';
        finalHeaders['X-Title'] = 'ToneGenie';
      }

      const finalOptions = {
        ...options,
        headers: finalHeaders,
        body: JSON.stringify(requestBody)
      };
      
      console.log(`tonegenie: Using model: ${model} (${provider})`);
      
      const response = await fetch(apiUrl, finalOptions);
      
      if (response.status === 429) {
        // Rate limit error - mark this model as rate limited and try next model
        console.log(`tonegenie: Model ${model} (${provider}) rate limited, switching to next model`);
        rateLimitedModels.add(model);
        modelRateLimitTimes[model] = Date.now();
        
        // Wait a bit if it's OpenRouter to allow the per-user limit to breathe
        if (provider === 'openrouter') {
          console.log('tonegenie: OpenRouter 429 - waiting 1.5s cooldown');
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
        
        // Try next available model
        const nextModelData = getNextAvailableModel();
        if (nextModelData.id !== model && !rateLimitedModels.has(nextModelData.id)) {
          console.log(`tonegenie: Switching to model: ${nextModelData.id} (${nextModelData.provider})`);
          return await fetchWithRetry(ignoreUrl, options, maxRetries, nextModelData, onRateLimitStatus);
        }
        
        // Handle no retries left
        throw new Error('All models rate limited. Please wait a moment before trying again.');
      }
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: { message: 'API request failed' } }));
        const errorMessage = errorData.error?.message || `API request failed: ${response.status}`;
        console.log(`tonegenie: ⚠️ Model ${model} (${provider}) failed: ${errorMessage}`);

        // For non-OK responses (404, 400, 500, etc.), treat as "broken" and try NEXT model
        if (attempt < maxRetries - 1) {
          console.log(`tonegenie: Automatically skipping failed model ${model} and attempting next...`);
          rateLimitedModels.add(model); // Temporarily mark as "limited" to skip it
          modelRateLimitTimes[model] = Date.now();
          
          const nextModelData = getNextAvailableModel();
          if (nextModelData.id !== model && !rateLimitedModels.has(nextModelData.id)) {
            return await fetchWithRetry(ignoreUrl, options, maxRetries, nextModelData, onRateLimitStatus);
          }
        }
        
        throw new Error(errorMessage);
      }
      
      // Success - reset model index if needed (only for Groq models)
      if (provider === 'groq' && model !== FREE_MODELS[currentModelIndex]) {
        const idx = FREE_MODELS.indexOf(model);
        if (idx !== -1) currentModelIndex = idx;
      }
      
      return response;
    } catch (error) {
      if (error.message.includes('rate limit') || error.message.includes('Rate limit')) {
        // Mark model as rate limited
        rateLimitedModels.add(model);
        modelRateLimitTimes[model] = Date.now();
        
        // Try next model if available
        const nextModelData = getNextAvailableModel();
        if (nextModelData.id !== model && !rateLimitedModels.has(nextModelData.id)) {
          console.log(`tonegenie: Error with ${model} (${provider}), switching to: ${nextModelData.id} (${nextModelData.provider})`);
          return await fetchWithRetry(ignoreUrl, options, maxRetries, nextModelData, onRateLimitStatus);
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

async function generateComment(tweetText, style, uiHooks = {}) {
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

  const { primaryStyle, secondaryStyle } = getMixedStyle(style, tweetText);

  // Special handling for Hinglish and Birthday
  const isHinglish = primaryStyle === 'hinglish';
  const isBirthdayWish = primaryStyle === 'birthdayWish';
  
  // Check if post mentions birthday
  const birthdayKeywords = ['birthday', 'turning', 'born on', 'turned', 'bday', 'happy birthday', 'wish', 'celebrating', 'age', 'years old', '🎂', '🎉'];
  const hasBirthdayContext = birthdayKeywords.some(keyword => 
    tweetText.toLowerCase().includes(keyword.toLowerCase())
  );
  
  // Get current date for 2025 context
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.toLocaleString('default', { month: 'long' });
  
  const primaryDescription = styleDescriptions[primaryStyle] || styleDescriptions.friendly;
  const secondaryDescription = secondaryStyle ? styleDescriptions[secondaryStyle] : null;
  const mixedStyleInstruction = secondaryDescription
    ? `Primary style: ${primaryStyle} (${primaryDescription}). Secondary accent: ${secondaryStyle} (${secondaryDescription}). Keep it roughly 70/30, with the primary style clearly dominant.`
    : `Primary style: ${primaryStyle} (${primaryDescription}).`;

  let prompt = `Read this tweet and write a real comment.

Tweet: "${tweetText}"

${mixedStyleInstruction}

Write a comment that:
- Actually responds to what the tweet says
- Sounds like a real person typed it, not an AI
- Matches the energy of the tweet
- Does not make up facts, stats, or numbers
 - Is at most ${MAX_COMMENT_CHARS} characters
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
    if (primaryStyle === 'funny') {
      prompt += ` be lowkey funny or witty. dont force it if the tweet isnt funny.`;
    } else if (primaryStyle === 'dataDriven') {
      prompt += ` reference a fact or observation from the tweet if there is one. casual text style. no stiff language.`;
    } else if (primaryStyle === 'analytical') {
      prompt += ` notice something specific about the tweet. talk like a person not a report.`;
    } else if (primaryStyle === 'professional') {
      prompt += ` polite and real. no corporate tone. just respectful and grounded.`;
    } else if (primaryStyle === 'supportive') {
      prompt += ` be genuinely encouraging. match the energy. no generic hype.`;
    } else if (primaryStyle === 'sarcastic') {
      prompt += ` dry humor. lowkey sarcastic. dont be rude.`;
    } else if (primaryStyle === 'enthusiastic') {
      prompt += ` hyped but grounded. good energy without shouting.`;
    } else if (primaryStyle === 'thoughtful') {
      prompt += ` actually think about the tweet. say something real. keep it casual.`;
    } else if (primaryStyle === 'friendly') {
      prompt += ` talk like youre texting a friend. warm and natural.`;
    } else if (primaryStyle === 'relatable') {
      prompt += ` relate to it. be specific about why you get it.`;
    } else if (primaryStyle === 'agree') {
      prompt += ` agree but say something specific not just yeah or facts.`;
    } else if (primaryStyle === 'disagree') {
      prompt += ` push back calmly. say why but keep it chill.`;
    } else if (primaryStyle === 'conversational') {
      prompt += ` just talk. casual minimal effort vibes. like a quick reply.`;
    } else if (primaryStyle === 'inspirational') {
      prompt += ` motivating but grounded. no cheesy quotes. make it feel real.`;
    } else if (primaryStyle === 'question') {
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
- ${MAX_COMMENT_CHARS} characters max
- vary your sentence rhythm naturally
- be specific not vague
- if it fits naturally use "i" not "one" or passive constructions

Before writing do a quick silent check: would a real person actually say this or does it sound assembled? fix it if needed.

Then write only the final comment. no quotes no explanations.`;

  // Start with best model, will automatically fallback if rate limited
  const initialModelData = getNextAvailableModel();
  
  const response = await fetchWithRetry(null, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages: [
        {
            role: 'system',
            content: `You are a real Twitter/X user writing short casual comments.

CRITICAL: Return ONLY the final comment text. No conversational filler, no "Sure!", no "Here is a comment:", no intro/outro text.

Write in sentence case (only capitalize the first letter of the first word). Keep punctuation to an absolute minimum. Sound like a real person texting, not an AI.

Never use these AI writing patterns:
- Banned words: testament, pivotal, landscape, tapestry, underscore, vibrant, delve, garner, crucial, foster, showcase, highlight, intricate, enduring, groundbreaking, nestled, breathtaking, transformative, seamless, robust, synergy, leverage, impactful, holistic, navigate, journey, resonate, ecosystem, paradigm, unpack, actionable, moreover, furthermore, additionally, key (as adjective)
- No em dashes — use commas or short sentences instead
- No bold text
- No rule-of-three lists (x y and z)
- No negative parallelism (not just x it is y)
- No -ing analysis phrases (highlighting, underscoring, showcasing, symbolizing, reflecting, contributing to)
- No promotional adjectives (breathtaking, vibrant, groundbreaking)
- No vague attributions (experts say, industry reports, observers note)
- No notability flex (featured in major outlets, independent coverage, written by a leading expert)
- No significance puffery (pivotal moment, enduring legacy, broader trends, sets the stage)
- No copula avoidance — write is not serves as or stands as
- No generic happy endings (the future looks bright, exciting times ahead)
- No filler (in order to, at this point in time, it is important to note)
- No over-hedging (could potentially possibly, might perhaps)
- No sycophantic openers (great question, absolutely, of course)
- No chatbot closers (hope this helps, let me know)
- No outline-y labels like "User experience:" with a colon then a sentence
- No title case headings

Do add real personality:
- Vary sentence length — mix short punchy and longer flowing
- Have a real take not just neutral reporting
- Use i when it fits naturally
- Be specific not vague
- Let some imperfection in — real people are not perfectly structured

Avoid repetitive AI-style openings:
- Never start with: "i love how", "love how", "this tweet just", "this is giving", "honestly this", "gotta love"
- Don’t say "this tweet" unless absolutely required for context
- Jump straight into your reaction or point instead of describing the tweet setup
- Never use template phrasing like "i love that they..." or "they left out the part..."
- Never use empathy-template openers like "i get where you're coming from" or "i see where you're coming from"`
          },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7, // Lower temperature for more consistent, less chatty comments
      max_tokens: 150,
      top_p: 1
    })
  }, 3, initialModelData, uiHooks.onRateLimitStatus);

  const data = await response.json();
  let comment = data.choices[0].message.content.trim();

  const promptPatterns = [
    /^we need to (analyze|output|write|generate|craft).*$/im,
    /^tweet:.*$/im,
    /^role:.*$/im,
    /^instructions:.*$/im,
    /^read this tweet.*$/im,
    /^write a comment.*$/im,
    /^\d+\s*to\s*\d+\s*characters.*$/im,
    /^use sentence case.*$/im,
    /^rules:.*$/im,
    /^###.*$/im,
    /^must be polite.*$/im,
    /^avoid exclamation.*$/im
  ];
  
  // Extract text inside quotes if the model says "likely saying something like '...'"
  const quoteMatch = comment.match(/(?:likely saying something like|respond with|saying)\s*["']([^"']{10,})["']/i);
  if (quoteMatch && quoteMatch[1]) {
    console.log('tonegenie: Extracted comment from conversational filler');
    comment = quoteMatch[1];
  }

  // Clean up the response - remove quotes, prefixes, and any common AI filler
  comment = comment.replace(/^["'](.*)["']$/s, '$1');
  comment = comment.replace(/^(comment|response|reply|certainly|sure|here is|here's|i would|ok|okay|crafting):\s*/i, '');
  comment = comment.replace(/^system prompt:/i, '');
  
  let lines = comment.split('\n');
  lines = lines.filter(line => {
    const trimmed = line.trim().toLowerCase();
    if (!trimmed) return true; // keep empty lines for now, will trim later
    return !promptPatterns.some(pattern => pattern.test(trimmed));
  });
  
  comment = lines.join('\n').trim();
  
  // If the AI was very chatty, sometimes the comment is in the last paragraph
  if (comment.length > 400 && comment.includes('\n\n')) {
    const paragraphs = comment.split('\n\n');
    const lastPara = paragraphs[paragraphs.length - 1].trim();
    if (lastPara.length > 20 && lastPara.length < 250) {
      comment = lastPara;
    }
  }

  // Humanizer pass: cheap local cleanup + optional model rewrite if obvious AI tells remain.
  const originalComment = comment;
  comment = humanizeCommentSurface(comment);
  if (commentHasAiTellSignals(comment)) {
    try {
      const revised = await rewriteCommentToRemoveAiTells(comment, tweetText, uiHooks);
      if (revised && revised.length >= 5) {
        comment = revised;
        // Re-apply the same lightweight cleanup pipeline on the revision.
        comment = comment.replace(/^["'](.*)["']$/s, '$1');
        comment = comment.replace(/^(comment|response|reply|certainly|sure|here is|here's|i would|ok|okay|crafting):\s*/i, '');
        comment = comment.replace(/^system prompt:/i, '');

        let revisedLines = comment.split('\n');
        revisedLines = revisedLines.filter(line => {
          const trimmed = line.trim().toLowerCase();
          if (!trimmed) return true;
          return !promptPatterns.some(pattern => pattern.test(trimmed));
        });
        comment = revisedLines.join('\n').trim();

        if (comment.length > 400 && comment.includes('\n\n')) {
          const paragraphs = comment.split('\n\n');
          const lastPara = paragraphs[paragraphs.length - 1].trim();
          if (lastPara.length > 20 && lastPara.length < 250) {
            comment = lastPara;
          }
        }

        comment = humanizeCommentSurface(comment);
      }
    } catch (e) {
      console.log('tonegenie: Humanizer rewrite skipped:', e?.message || e);
      comment = originalComment;
    }
  }

  // Final validation
  const lowerComment = comment.toLowerCase();
  const isPromptRepetition = lowerComment.includes('tweet:') || 
                             lowerComment.includes('role:') ||
                             lowerComment.includes('messages:');
  const hasGenericAiOpening = /^(i love how|love how|this tweet just|this is giving|honestly this|gotta love|i love that they)\b/i.test(comment.trim());
  const hasTemplatePhrase = /\b(i love that they|left out the part|i get where you('|’)re coming from|i see where you('|’)re coming from)\b/i.test(comment);
  const hasAiLoop = hasLoopingRepetition(comment);

  if (comment.length > 500 || comment.length < 5 || isPromptRepetition || hasGenericAiOpening || hasTemplatePhrase || hasAiLoop) {
    console.log('tonegenie: Quality check failed or prompt repeated, using fallback. Original:', comment.substring(0, 100) + '...');
    comment = NATURAL_FALLBACKS[Math.floor(Math.random() * NATURAL_FALLBACKS.length)];
  }

  // Hard cap for all generated comments.
  comment = clampCommentLength(comment, MAX_COMMENT_CHARS);
  
  return comment;
}

async function insertIntoTwitter(selector, text) {
  let replyBox = resolveReplyBox(selector);
  if (!replyBox && selector) {
    await waitForElement(selector, 5000);
    replyBox = resolveReplyBox(selector);
  }
  
  if (!replyBox) {
    console.error('tonegenie: Reply box not found');
    return;
  }

  const normalizedTextToInsert = normalizeWhitespace(text);
  if (!normalizedTextToInsert) return;

  // 1. GLOBAL LOCK: Prevent identical text from being inserted anywhere on the page in rapid succession.
  // This is the strongest defense against event-duplicate race conditions.
  const now = Date.now();
  if (globalLastInsertSig === normalizedTextToInsert && (now - globalLastInsertTime) < 5000) {
    console.log('tonegenie: Global duplicate signature detected, skipping');
    return;
  }
  if (!passesSharedInsertGuard(normalizedTextToInsert, now, 5000)) {
    console.log('tonegenie: Shared duplicate guard detected, skipping');
    return;
  }

  // 2. ELEMENT LOCK: Prevent overlapping async calls to the same element.
  if (insertLocks.has(replyBox) && insertLocks.get(replyBox) === normalizedTextToInsert) {
    console.log('tonegenie: Atomic insertion lock active for this text on this element');
    return;
  }

  // Extra signature guard for delayed duplicate invocations on same compose box.
  if (replyBox._tgLastInsertSig === normalizedTextToInsert && (now - (replyBox._tgLastInsertTime || 0)) < 15000) {
    console.log('tonegenie: Recent same-signature insertion detected on element, skipping');
    return;
  }
  
  // Robust per-element time locking
  const lastTime = replyBox._tgLastInsertTime || 0;
  if (now - lastTime < 1500) {
    console.log('tonegenie: Rapid insertion prevented on element');
    return;
  }

  // Check current box content
  const existingText = (replyBox.innerText || replyBox.textContent || '');
  const normalizedExisting = normalizeWhitespace(existingText);

  // 3. CONTENT CHECK: Already in box — absolutely bail
  // We check for exact match or if it ends with the text to handle mentions better.
  if (normalizedExisting.includes(normalizedTextToInsert)) {
    console.log('tonegenie: Content already exists in box (includes), skipping');
    return;
  }

  // Set locks immediately safely before any sync calls
  replyBox._tgLastInsertTime = now;
  globalLastInsertSig = normalizedTextToInsert;
  globalLastInsertTime = now;
  insertLocks.set(replyBox, normalizedTextToInsert);
  markProgrammaticComposeWrite(replyBox, normalizedTextToInsert);

  replyBox.focus();

  // Use a single deterministic write to avoid X editor desync/ghost overlays.
  const spacer = (normalizedExisting && !normalizedExisting.endsWith(' ') && !normalizedExisting.endsWith('\n')) ? ' ' : '';
  const desiredFullText = `${existingText}${spacer}${text}`;
  const normalizedDesired = normalizeWhitespace(desiredFullText);
  if (!normalizedDesired) return;

  document.execCommand('selectAll', false, null);
  const success = document.execCommand('insertText', false, desiredFullText);
  await new Promise(resolve => setTimeout(resolve, 60));
  let postExecText = normalizeWhitespace(replyBox.innerText || replyBox.textContent || '');
  let insertedAfterExec = postExecText === normalizedDesired;

  if (!success && !insertedAfterExec) {
    // X can occasionally return false even when insertText is available; do one controlled retry only.
    document.execCommand('selectAll', false, null);
    const retrySuccess = document.execCommand('insertText', false, desiredFullText);
    await new Promise(resolve => setTimeout(resolve, 60));
    postExecText = normalizeWhitespace(replyBox.innerText || replyBox.textContent || '');
    insertedAfterExec = retrySuccess || postExecText === normalizedDesired;
  }

  if (success || insertedAfterExec) {
    dedupeInsertedTextIfRepeated(replyBox, desiredFullText);
    replyBox._tgLastInsertSig = normalizedTextToInsert;
    console.log('tonegenie: Content inserted successfully');
  } else {
    console.warn('tonegenie: insertText did not apply content, skipping unsafe fallback');
  }

  // Release atomic element lock after a short delay to allow DOM to settle
  setTimeout(() => {
    if (insertLocks.get(replyBox) === normalizedTextToInsert) {
      insertLocks.delete(replyBox);
    }
  }, 1000);
}

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve) => {
    if (document.querySelector(selector)) {
      return resolve(document.querySelector(selector));
    }

    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        observer.disconnect();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  });
}
// ==================== TRENDING TOPICS (Sidebar Only) ====================

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
      if (isComposeMutationHandlingPaused()) return;
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
  const foundTextarea = getActiveComposeTextArea();
  
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

// Get trending hashtags specifically
function getTrendingHashtags() {
  const topics = getTrendingTopics();
  // Filter for hashtags only
  const hashtags = topics.filter(topic => topic.startsWith('#'));
  
  // If no hashtags found in trends, scan page links for any hashtags
  if (hashtags.length === 0) {
    const links = document.querySelectorAll('a[href*="/hashtag/"]');
    const pageHashtags = new Set();
    links.forEach(link => {
      const text = link.textContent?.trim();
      if (text && text.startsWith('#')) {
        pageHashtags.add(text);
      }
    });
    return Array.from(pageHashtags);
  }
  
  return hashtags;
}

async function updateHashtagSuggestions(tweetText) {
  if (!hashtagWidget || !apiKey) return;
  const targetWidget = hashtagWidget;
  if (!targetWidget || !document.contains(targetWidget)) return;
  
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

  // Widget may have been removed while awaiting async work.
  if (!hashtagWidget || hashtagWidget !== targetWidget || !document.contains(targetWidget)) {
    return;
  }
  
  // Combine and deduplicate
  const allHashtags = [...new Set([...relevantHashtags, ...trending])].slice(0, 8);
  
  // Update widget
  targetWidget.innerHTML = '';
  
  if (allHashtags.length === 0) {
    targetWidget.innerHTML = '<div style="font-size: 12px; color: #666; padding: 4px;">Loading hashtags...</div>';
    return;
  }
  
  allHashtags.forEach(hashtag => {
    const tagBtn = document.createElement('button');
    tagBtn.className = 'tonegenie-hashtag-btn';
    tagBtn.type = 'button';
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
    
    targetWidget.appendChild(tagBtn);
  });
}

async function generateRelevantHashtags(tweetText, apiKey) {
  const prompt = `Based on this tweet text, suggest 5-8 relevant hashtags that are trending or commonly used. Include a mix of popular and niche hashtags.

Tweet text: "${tweetText.substring(0, 200)}"

Return ONLY the hashtags, one per line, starting with #. Make them relevant to the content.`;

  try {
    const response = await fetchWithRetry(null, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 100,
        top_p: 1
      })
    });

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
  let textarea = getActiveComposeTextArea();
  if (!textarea) {
    textarea = await waitForElement('[data-testid="tweetTextarea_0"][contenteditable="true"], div[contenteditable="true"][role="textbox"][data-testid*="tweetTextarea"]', 3000);
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