// Tag generation via GitHub Models API.
// No data is ever written to the repository for tag generation.

const TAG_PROMPT = `You are a tag generator for a technical knowledge base.

Given the title and content excerpt of a web page, generate 3-8 concise, lowercase, kebab-case tags that capture the key topics, technologies, and concepts.

Rules:
- Tags must be lowercase kebab-case (e.g., "incident-graph", "microsoft-sentinel", "kql")
- Focus on technologies, products, concepts, and techniques
- Avoid generic tags like "blog", "article", "security" unless highly specific
- Prefer specific terms over broad ones
- Return ONLY a JSON array of strings, nothing else`;

const GITHUB_MODELS_URL = 'https://models.inference.ai.azure.com/chat/completions';
const GITHUB_MODELS_MODEL = 'gpt-4o-mini';

/**
 * Parse and sanitize a JSON tag array from an LLM response.
 * @param {string} raw - Raw LLM response text
 * @returns {string[]|null}
 */
function parseTags(raw) {
  const cleaned = raw.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  const tags = JSON.parse(cleaned);
  if (!Array.isArray(tags)) return null;
  return tags
    .filter((t) => typeof t === 'string')
    .map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
    .filter((t) => t.length >= 2 && t.length <= 40);
}

/**
 * Generate tags via GitHub Models API.
 * @param {string} title - Page title
 * @param {string} excerpt - Extracted page content
 * @param {string} token - GitHub access token
 * @returns {Promise<string[]|null>} Tags array, or null on failure
 */
export async function generateTags(title, excerpt, token) {
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
          { role: 'system', content: TAG_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 200,
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    return parseTags(content);
  } catch {
    return null;
  }
}
