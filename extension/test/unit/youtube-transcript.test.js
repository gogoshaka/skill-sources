import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isYouTubeVideo,
  parseTranscriptXml,
  TRANSCRIPT_MAX_LENGTH,
} from '../../lib/youtube-utils.js';

// ---------------------------------------------------------------------------
// YouTube URL detection
// ---------------------------------------------------------------------------

describe('isYouTubeVideo', () => {
  it('accepts standard www.youtube.com watch URL', () => {
    assert.equal(isYouTubeVideo('https://www.youtube.com/watch?v=abc123'), true);
  });

  it('accepts youtube.com without www', () => {
    assert.equal(isYouTubeVideo('https://youtube.com/watch?v=abc123'), true);
  });

  it('accepts mobile m.youtube.com watch URL', () => {
    assert.equal(isYouTubeVideo('https://m.youtube.com/watch?v=abc123'), true);
  });

  it('rejects YouTube homepage', () => {
    assert.equal(isYouTubeVideo('https://www.youtube.com/'), false);
  });

  it('rejects YouTube channel page', () => {
    assert.equal(isYouTubeVideo('https://www.youtube.com/channel/xxx'), false);
  });

  it('rejects non-YouTube URL', () => {
    assert.equal(isYouTubeVideo('https://example.com'), false);
  });

  it('rejects invalid URL string', () => {
    assert.equal(isYouTubeVideo('not-a-url'), false);
  });

  it('rejects watch path without v parameter', () => {
    assert.equal(isYouTubeVideo('https://www.youtube.com/watch'), false);
  });
});

// ---------------------------------------------------------------------------
// Captions XML parsing
// ---------------------------------------------------------------------------

describe('parseTranscriptXml', () => {
  it('parses basic transcript XML into plain text', () => {
    const xml =
      '<transcript><text start="0" dur="5.2">Hello</text><text start="5.2" dur="3.1">world</text></transcript>';
    assert.equal(parseTranscriptXml(xml), 'Hello world');
  });

  it('decodes HTML entities in text content', () => {
    const xml =
      '<transcript><text start="0" dur="2">rock &amp; roll</text><text start="2" dur="2">it&#39;s great</text></transcript>';
    assert.equal(parseTranscriptXml(xml), "rock & roll it's great");
  });

  it('decodes &lt; &gt; and &quot; entities', () => {
    const xml =
      '<transcript><text start="0" dur="1">&lt;bold&gt;</text><text start="1" dur="1">&quot;quoted&quot;</text></transcript>';
    assert.equal(parseTranscriptXml(xml), '<bold> "quoted"');
  });

  it('returns empty string for empty XML', () => {
    assert.equal(parseTranscriptXml(''), '');
  });

  it('returns empty string for null input', () => {
    assert.equal(parseTranscriptXml(null), '');
  });

  it('returns empty string for undefined input', () => {
    assert.equal(parseTranscriptXml(undefined), '');
  });

  it('returns empty string for non-string input', () => {
    assert.equal(parseTranscriptXml(42), '');
  });

  it('returns empty string when there are no <text> elements', () => {
    assert.equal(parseTranscriptXml('<transcript></transcript>'), '');
  });

  it('strips whitespace from individual text nodes', () => {
    const xml =
      '<transcript><text start="0" dur="1">  hello  </text><text start="1" dur="1">  world  </text></transcript>';
    assert.equal(parseTranscriptXml(xml), 'hello world');
  });

  it('skips empty text nodes', () => {
    const xml =
      '<transcript><text start="0" dur="1">hello</text><text start="1" dur="1">   </text><text start="2" dur="1">world</text></transcript>';
    assert.equal(parseTranscriptXml(xml), 'hello world');
  });
});

// ---------------------------------------------------------------------------
// Transcript truncation
// ---------------------------------------------------------------------------

describe('transcript truncation', () => {
  it(`truncates transcripts longer than ${TRANSCRIPT_MAX_LENGTH} characters`, () => {
    // Build an XML with enough text to exceed the limit
    const word = 'abcdefghij'; // 10 chars
    const count = Math.ceil(TRANSCRIPT_MAX_LENGTH / (word.length + 1)) + 100;
    const textElements = Array.from({ length: count }, (_, i) =>
      `<text start="${i}" dur="1">${word}</text>`
    ).join('');
    const xml = `<transcript>${textElements}</transcript>`;

    const result = parseTranscriptXml(xml);
    assert.equal(result.length, TRANSCRIPT_MAX_LENGTH);
  });

  it('does not truncate transcripts within the limit', () => {
    const xml =
      '<transcript><text start="0" dur="1">short transcript</text></transcript>';
    const result = parseTranscriptXml(xml);
    assert.equal(result, 'short transcript');
    assert.ok(result.length < TRANSCRIPT_MAX_LENGTH);
  });
});
