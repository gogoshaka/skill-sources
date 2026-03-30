// Injected into a YouTube tab via chrome.scripting.executeScript().
// Extracts captions/transcript from the video's embedded player response.
// Returns the transcript as a plain text string, or null if unavailable.

(async function extractYouTubeTranscript() {
  // Parse ytInitialPlayerResponse from page script tags.
  // Content scripts run in an isolated world and cannot access page JS variables,
  // so we extract the JSON directly from the raw script tag text.
  function findPlayerResponse() {
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent;
      if (!text || !text.includes('ytInitialPlayerResponse')) continue;

      const marker = 'ytInitialPlayerResponse';
      const idx = text.indexOf(marker);
      if (idx === -1) continue;

      const braceStart = text.indexOf('{', idx + marker.length);
      if (braceStart === -1) continue;

      // Walk braces to find the matching close, respecting JSON string literals
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;

      for (let i = braceStart; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { end = i + 1; break; }
        }
      }

      if (end === -1) continue;

      try {
        return JSON.parse(text.slice(braceStart, end));
      } catch {
        continue;
      }
    }
    return null;
  }

  const playerResponse = findPlayerResponse();
  if (!playerResponse) return null;

  const captionTracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captionTracks?.length) return null;

  // Pick best track: manual English > auto English > any manual > first available
  const track =
    captionTracks.find((t) => t.languageCode === 'en' && t.kind !== 'asr') ||
    captionTracks.find((t) => t.languageCode === 'en') ||
    captionTracks.find((t) => t.kind !== 'asr') ||
    captionTracks[0];

  if (!track?.baseUrl) return null;

  let xml;
  try {
    const res = await fetch(track.baseUrl);
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  }

  // Parse the captions XML and concatenate all <text> elements
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const textNodes = doc.querySelectorAll('text');
  if (!textNodes.length) return null;

  const transcript = Array.from(textNodes)
    .map((node) => {
      // Decode HTML entities that YouTube double-encodes in caption XML
      const el = document.createElement('span');
      el.innerHTML = node.textContent;
      return el.textContent.trim();
    })
    .filter(Boolean)
    .join(' ');

  return transcript || null;
})();
