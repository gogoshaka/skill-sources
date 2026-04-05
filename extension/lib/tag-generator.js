// Tag, summary & key points generation via GitHub Models API.

const GENERATE_PROMPT = `You are a metadata generator for a technical knowledge base.

Given the title and content excerpt of a web page, generate:
1. A one-sentence summary (max 120 chars) that captures what the page is about
2. 3-5 key points — short bullet-point takeaways (max 80 chars each)
3. 3-8 concise, lowercase, kebab-case tags for key topics, technologies, and concepts

Rules for tags:
- Tags must be lowercase kebab-case (e.g., "incident-graph", "microsoft-sentinel", "kql")
- Focus on technologies, products, concepts, and techniques
- Avoid generic tags like "blog", "article", "security" unless highly specific
- Prefer specific terms over broad ones

Return ONLY a JSON object with this exact shape:
{"summary": "...", "key_points": ["...", "..."], "tags": ["...", "..."]}`;

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
 * Parse combined response from the LLM.
 * @param {string} raw - Raw LLM response text
 * @returns {{ summary: string, key_points: string[], tags: string[] } | null}
 */
function parseResponse(raw) {
  const cleaned = raw.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  const obj = JSON.parse(cleaned);
  if (!obj || typeof obj !== 'object') return null;
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const key_points = Array.isArray(obj.key_points)
    ? obj.key_points.filter((p) => typeof p === 'string').map((p) => p.trim()).slice(0, 5)
    : [];
  const tags = Array.isArray(obj.tags) ? sanitizeTags(obj.tags) : [];
  return { summary, key_points, tags };
}

/**
 * Generate tags, summary and key points via GitHub Models API in a single call.
 * @param {string} title - Page title
 * @param {string} excerpt - Extracted page content
 * @param {string} token - GitHub access token
 * @returns {Promise<{ summary: string, key_points: string[], tags: string[] } | null>}
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
        temperature: 1,
        max_completion_tokens: 400,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`Empty response: ${JSON.stringify(data).slice(0, 300)}`);

    return parseResponse(content);
  } catch (err) {
    throw err;
  }
}
