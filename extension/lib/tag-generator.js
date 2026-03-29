// Tag & summary generation via GitHub Models API.
// No data is ever written to the repository for generation.

const GENERATE_PROMPT = `You are a metadata generator for a technical knowledge base.

Given the title and content excerpt of a web page, generate:
1. A one-sentence summary (max 120 chars) that captures what the page is about
2. 3-8 concise, lowercase, kebab-case tags for key topics, technologies, and concepts

Rules for tags:
- Tags must be lowercase kebab-case (e.g., "incident-graph", "microsoft-sentinel", "kql")
- Focus on technologies, products, concepts, and techniques
- Avoid generic tags like "blog", "article", "security" unless highly specific
- Prefer specific terms over broad ones

Return ONLY a JSON object with this exact shape:
{"summary": "...", "tags": ["...", "..."]}`;

const GITHUB_MODELS_URL = 'https://models.inference.ai.azure.com/chat/completions';
const GITHUB_MODELS_MODEL = 'gpt-5-mini';

/**
 * Parse and sanitize a JSON tag array from raw LLM text.
 * @param {string[]} rawTags
 * @returns {string[]}
 */
function sanitizeTags(rawTags) {
  return rawTags
    .filter((t) => typeof t === 'string')
    .map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
    .filter((t) => t.length >= 2 && t.length <= 40);
}

/**
 * Parse combined tags+summary response from the LLM.
 * @param {string} raw - Raw LLM response text
 * @returns {{ summary: string, tags: string[] } | null}
 */
function parseResponse(raw) {
  const cleaned = raw.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  const obj = JSON.parse(cleaned);
  if (!obj || typeof obj !== 'object') return null;
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const tags = Array.isArray(obj.tags) ? sanitizeTags(obj.tags) : [];
  return { summary, tags };
}

/**
 * Generate tags and summary via GitHub Models API in a single call.
 * @param {string} title - Page title
 * @param {string} excerpt - Extracted page content
 * @param {string} token - GitHub access token
 * @returns {Promise<{ summary: string, tags: string[] } | null>}
 */
export async function generateTagsAndSummary(title, excerpt, token) {
  try {
    const userMessage = `Title: ${title}\n\nContent:\n${excerpt.slice(0, 1500)}`;

    const res = await fetch(GITHUB_MODELS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: GITHUB_MODELS_MODEL,
        messages: [
          { role: 'system', content: GENERATE_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 300,
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    return parseResponse(content);
  } catch {
    return null;
  }
}
