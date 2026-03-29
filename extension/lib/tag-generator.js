// Client-side tag generation using the Chrome/Edge Prompt API (Gemini Nano).
// Falls back gracefully — if the API is unavailable, returns null
// and the GitHub Action will handle tag generation from the _excerpt.

const TAG_PROMPT = `You are a tag generator for a technical knowledge base.

Given the title and content excerpt of a web page, generate 3-8 concise, lowercase, kebab-case tags that capture the key topics, technologies, and concepts.

Rules:
- Tags must be lowercase kebab-case (e.g., "incident-graph", "microsoft-sentinel", "kql")
- Focus on technologies, products, concepts, and techniques
- Avoid generic tags like "blog", "article", "security" unless highly specific
- Prefer specific terms over broad ones
- Return ONLY a JSON array of strings, nothing else`;

/**
 * Check if the Prompt API is available in this browser.
 * @returns {Promise<boolean>}
 */
export async function isPromptApiAvailable() {
  try {
    if (typeof LanguageModel === 'undefined') return false;
    const availability = await LanguageModel.availability();
    return availability === 'available' || availability === 'downloadable';
  } catch {
    return false;
  }
}

/**
 * Generate tags from a page excerpt using the local Prompt API.
 * @param {string} title - Page title
 * @param {string} excerpt - Extracted page content
 * @returns {Promise<string[]|null>} Tags array, or null if unavailable/failed
 */
export async function generateTagsLocally(title, excerpt) {
  try {
    if (!(await isPromptApiAvailable())) return null;

    const session = await LanguageModel.create({
      initialPrompts: [{ role: 'system', content: TAG_PROMPT }],
    });

    const userMessage = `Title: ${title}\n\nContent:\n${excerpt.slice(0, 1500)}`;
    const response = await session.prompt(userMessage);
    session.destroy();

    // Parse JSON array from response
    const cleaned = response.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
    const tags = JSON.parse(cleaned);

    if (!Array.isArray(tags)) return null;

    return tags
      .filter((t) => typeof t === 'string')
      .map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
      .filter((t) => t.length >= 2 && t.length <= 40);
  } catch {
    return null; // fallback to GitHub Action
  }
}
