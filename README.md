# ToneGenie

**ToneGenie** is a Chrome extension that helps you write **short, contextual replies** on **X (Twitter)**. After a one-time setup, it adds **AI-powered style buttons** under tweets in your feed. Pick a tone (funny, professional, supportive, and more), and the extension generates a reply, opens the reply composer, and **inserts the text for you**—you can edit and post as usual.

It is built for people who want quick, on-brand comment ideas without leaving the timeline.

---

## What it does

| Feature | Description |
|--------|-------------|
| **Style buttons on tweets** | Under each tweet (in the feed), the extension injects pill buttons such as *funny*, *friendly*, *analytical*, *hinglish*, *birthday wish*, *question*, and others. |
| **Smart style hints** | For tweets with enough text, the extension can analyze the post and **highlight three suggested styles** that fit the content (when the analysis API call succeeds). |
| **One-click generation** | Click a style → the extension generates a comment → clicks **Reply** (if needed) → **inserts** the generated text into the reply box (respecting X’s character budget for short replies; generated text is clamped to **120 characters** by default). |
| **Personas** | Optional **persona profiles** (JSON in the `personas/` folder) shape how the AI writes. You can also add a free-text **custom persona / bio** in the popup. |
| **Hashtag helpers** | When you compose a post or reply, a small **hashtag suggestion** strip can appear under the composer (trending + AI-suggested tags when your draft is long enough). |
| **Usage tracking** | **Local-only** summaries of how long you have had an X tab in focus (shown in the popup and a small on-page widget). This is **not** sent to any server; it is stored in `chrome.storage.local`. |

ToneGenie does **not** post on your behalf. It only fills the composer; you choose whether to send the reply.

---

## Supported sites

The content script runs only on:

- `https://x.com/*`
- `https://twitter.com/*`

Other sites are untouched.

---

## Requirements

- **Google Chrome** (or another Chromium browser that supports **Manifest V3** extensions).
- A **Groq API key** (required). The popup validates the key against Groq’s API before saving.
- An **OpenRouter API key** (optional). If Groq rate-limits all configured models, the extension can fall back to OpenRouter when a key is present.

---

## How to install (developer / unpacked)

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked**.
5. Select the folder that contains `manifest.json` (the ToneGenie project root).

The extension icon should appear in the toolbar. Pin it if you want quick access to **Settings**.

---

## First-time setup

1. Click the **ToneGenie** extension icon to open the popup.
2. Enter your **Groq API key** (must start with `gsk_`).  
   - Create a free key at [console.groq.com](https://console.groq.com).
3. *(Optional)* Enter an **OpenRouter API key** for fallback: [openrouter.ai/keys](https://openrouter.ai/keys).
4. *(Optional)* Fill **Custom persona / bio** so every generated comment follows that voice.
5. *(Optional)* Choose a **Persona profile** from the dropdown (loaded from bundled `personas/*.json`; see `personas/README.md` to add your own).
6. Click **Save & Activate**. The popup verifies the Groq key, then saves everything to **`chrome.storage.local`** and notifies open X/Twitter tabs so the content script reloads its settings.

After saving, refresh any open **x.com** / **twitter.com** tabs if buttons do not appear immediately.

---

## How to use on X / Twitter

1. Go to your timeline or any tweet.
2. Scroll to a tweet. You should see a row of **style buttons** below the tweet actions (reply/like area).
3. Click the tone you want (e.g. **supportive**, **funny**, **professional**).
4. Wait for **Generating…** to finish. The reply flow opens and the **draft text is inserted** into the composer.
5. Edit if you like, then post your reply as you normally would.

If many people use the same IP or free tier aggressively, you may see **queue / rate limit** messaging on the button; the extension spaces requests and can switch models or providers when configured.

---

## Project structure

| Path | Role |
|------|------|
| `manifest.json` | MV3 manifest: permissions, content scripts for X/Twitter, popup, background service worker. |
| `content.js` | Injects UI on tweets, calls Groq/OpenRouter, inserts text into composers, hashtag strip, usage timer, etc. |
| `popup.html` / `popup.js` | Settings UI: API keys, persona, usage summary, save + notify tabs. |
| `background.js` | Lightweight service worker (e.g. install log, `checkApiKey` message handler). |
| `styles.css` | Styles for injected buttons and notifications. |
| `personas/` | JSON persona files + `index.json` + `personas/README.md` for authoring profiles. |

---

## Permissions

- **`storage`** — Stores API keys, persona selection, usage totals, and generation count locally in the browser.
- **`activeTab`** — Declared in the manifest for typical extension patterns; core behavior on X uses the **content script** `matches` for `x.com` / `twitter.com`.

Network calls go **directly from the content script / popup** to **Groq** and optionally **OpenRouter** using **your** keys. There is no ToneGenie backend server in this repo.

---

## Privacy and security

- API keys and preferences live in **`chrome.storage.local`** on your machine.
- Tweet text is sent to **Groq** (and optionally **OpenRouter**) only when you trigger generation or analysis (e.g. style suggestions, hashtags), using your keys.
- **Usage time** on X is aggregated locally for the usage widget and popup summary.

Do not share your API keys. If a key leaks, revoke it in the Groq / OpenRouter dashboards.

---

## Persona profiles

Bundled examples live under `personas/`. To add your own:

1. Add a new `*.json` file.
2. List the filename in `personas/index.json`.
3. Reload the extension in `chrome://extensions`.
4. Open the popup and select the profile.

See **`personas/README.md`** for the exact JSON fields (`handle`, `tone`, and optional fields like `niche`, `examples`, etc.).

---

## Updating the extension

After pulling new code or editing files:

1. Open `chrome://extensions`.
2. Click **Reload** on the ToneGenie card.

Reload **x.com** tabs after changing `content.js` or `manifest.json`.

---

## Troubleshooting

| Issue | What to try |
|--------|-------------|
| No buttons under tweets | Confirm Groq key is saved; reload X tab; check console on the page for errors. |
| “Invalid API key” on save | Key must start with `gsk_` and be accepted by Groq’s `/models` endpoint. |
| Rate limits / long waits | Expected on free tiers; add OpenRouter fallback or wait; extension queues requests (e.g. minimum spacing between calls). |
| Composer behaves oddly | Disable other extensions that modify X’s text fields to rule out conflicts. |

---

## Development notes

- **Manifest version:** 3  
- **Models** (see `content.js`): primary list uses Groq models; OpenRouter lists a fallback model when Groq is exhausted or rate-limited.  
- **Comment length:** Replies are clamped to **120 characters** (including when merging with existing draft text where applicable).

---

## License

If you add a license file (e.g. MIT) to the repository, describe it here. Until then, treat usage as governed by your own policies and the terms of Groq, OpenRouter, and X.

---

## Disclaimer

ToneGenie is an assistant. **You** are responsible for what you post. Generated text may be inaccurate or inappropriate; always review before replying. Use of X, Groq, and OpenRouter is subject to their respective terms of service.
