// Shared YouTube utility functions used by the content script and tests.

const TRANSCRIPT_MAX_LENGTH = 10000;

/**
 * Returns true when the given URL points to a YouTube video watch page.
 */
export function isYouTubeVideo(url) {
  try {
    const u = new URL(url);
    const validHosts = [
      'www.youtube.com',
      'youtube.com',
      'm.youtube.com',
    ];
    return validHosts.includes(u.hostname) && u.pathname === '/watch' && u.searchParams.has('v');
  } catch {
    return false;
  }
}

/**
 * Decode common HTML entities that YouTube double-encodes in caption XML.
 */
function decodeEntities(str) {
  return str
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Parse YouTube captions XML and return the transcript as a single string.
 * The XML format is: <transcript><text start="0" dur="5.2">Hello</text>...</transcript>
 * Returns empty string for empty or invalid input.
 */
export function parseTranscriptXml(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') return '';

  const parts = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = re.exec(xmlString)) !== null) {
    const decoded = decodeEntities(match[1]).trim();
    if (decoded) parts.push(decoded);
  }

  const transcript = parts.join(' ');
  if (!transcript) return '';

  return transcript.length > TRANSCRIPT_MAX_LENGTH
    ? transcript.slice(0, TRANSCRIPT_MAX_LENGTH)
    : transcript;
}

export { TRANSCRIPT_MAX_LENGTH };
