// Tag, summary & key points generation via GitHub Models API.

const GENERATE_PROMPT = `You are an expert knowledge extractor for a technical research library.

Given the title and content of a web page, generate a structured analysis with:

1. **summary** — A clear paragraph (2-4 sentences) explaining what the page covers, who it's for, and why it matters.
2. **key_takeaways** — 3-5 actionable bullet points. Focus on insights, decisions, or facts the reader should remember. Be specific, not generic.
3. **configuration** — Any commands, code snippets, settings, URLs, API endpoints, environment variables, or step-by-step instructions mentioned. Return as an array of strings. If none exist, return an empty array.
4. **references** — Tools, libraries, services, or external resources mentioned (e.g. "Azure Sentinel", "KQL", "Microsoft Graph API"). Return as an array of strings. If none, return empty array.
5. **tags** — 3-8 concise, lowercase, kebab-case tags for key topics, technologies, and concepts.

Rules for tags:
- Tags must be lowercase kebab-case (e.g., "incident-graph", "microsoft-sentinel", "kql")
- Focus on technologies, products, concepts, and techniques
- Avoid generic tags like "blog", "article", "security" unless highly specific

Return ONLY a JSON object with this exact shape:
{"summary": "...", "key_takeaways": ["...", "..."], "configuration": ["...", "..."], "references": ["...", "..."], "tags": ["...", "..."]}`;

const GITHUB_MODELS_URL = 'https://models.inference.ai.azure.com/chat/completions';
const GITHUB_MODELS_MODEL = 'gpt-4o-mini';

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
 * @returns {{ summary: string, key_takeaways: string[], configuration: string[], references: string[], tags: string[] } | null}
 */
function parseResponse(raw) {
  const cleaned = raw.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  const obj = JSON.parse(cleaned);
  if (!obj || typeof obj !== 'object') return null;
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const key_takeaways = Array.isArray(obj.key_takeaways)
    ? obj.key_takeaways.filter((p) => typeof p === 'string').map((p) => p.trim()).slice(0, 5)
    : [];
  const configuration = Array.isArray(obj.configuration)
    ? obj.configuration.filter((c) => typeof c === 'string').map((c) => c.trim())
    : [];
  const references = Array.isArray(obj.references)
    ? obj.references.filter((r) => typeof r === 'string').map((r) => r.trim())
    : [];
  const tags = Array.isArray(obj.tags) ? sanitizeTags(obj.tags) : [];
  return { summary, key_takeaways, configuration, references, tags };
}

/**
 * Generate tags, summary and structured analysis via GitHub Models API.
 * @param {string} title - Page title
 * @param {string} excerpt - Extracted page content
 * @param {string} token - GitHub access token
 * @returns {Promise<{ summary: string, key_takeaways: string[], configuration: string[], references: string[], tags: string[] } | null>}
 */
export async function generateTagsAndSummary(title, excerpt, token) {
  try {
    const userMessage = `Title: ${title}\n\nContent:\n${excerpt.slice(0, 3000)}`;

    console.log('[Dask] AI request — model:', GITHUB_MODELS_MODEL);
    console.log('[Dask] AI request — system prompt:', GENERATE_PROMPT.slice(0, 200) + '…');
    console.log('[Dask] AI request — user message:', userMessage.slice(0, 500) + (userMessage.length > 500 ? '…' : ''));

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
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    console.log('[Dask] AI raw response:', JSON.stringify(data).slice(0, 500));
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`Empty response: ${JSON.stringify(data).slice(0, 300)}`);

    return parseResponse(content);
  } catch (err) {
    throw err;
  }
}
