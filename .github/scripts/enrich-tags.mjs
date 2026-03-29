#!/usr/bin/env node

/**
 * enrich-tags.mjs — GitHub Action script
 *
 * Finds sources in topics/*.json that have an `_excerpt` field,
 * calls GitHub Models to generate tags from the excerpt,
 * merges generated tags with any existing manual tags,
 * removes the `_excerpt` field, and commits the changes.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const TOPICS_DIR = 'topics';
const MODEL = 'gpt-5-mini';
const API_URL = 'https://models.inference.ai.azure.com/chat/completions';
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.log('No GITHUB_TOKEN — skipping tag enrichment.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Find sources with _excerpt
// ---------------------------------------------------------------------------

const topicFiles = readdirSync(TOPICS_DIR).filter((f) => f.endsWith('.json'));
let totalEnriched = 0;
const modifiedFiles = [];

for (const file of topicFiles) {
  const filePath = join(TOPICS_DIR, file);
  const topic = JSON.parse(readFileSync(filePath, 'utf8'));

  if (!topic.items || !Array.isArray(topic.items)) continue;

  let modified = false;

  for (const source of topic.items) {
    if (!source._excerpt) continue;

    console.log(`Enriching tags for: ${source.url}`);

    try {
      const generatedTags = await generateTags(source.title, source._excerpt);

      // Merge with existing tags (dedupe, preserve manual ones first)
      const existingTags = source.tags || [];
      const merged = [...new Set([...existingTags, ...generatedTags])];
      source.tags = merged.slice(0, 15); // cap at 15 tags

      console.log(`  Generated: ${generatedTags.join(', ')}`);
      console.log(`  Final:     ${source.tags.join(', ')}`);
      totalEnriched++;
    } catch (err) {
      console.warn(`  Failed to generate tags: ${err.message}`);
      // Keep the _excerpt so it can be retried next run
      continue;
    }

    // Remove the excerpt now that tags are generated
    delete source._excerpt;
    modified = true;
  }

  if (modified) {
    writeFileSync(filePath, JSON.stringify(topic, null, 2) + '\n');
    modifiedFiles.push(filePath);
  }
}

if (totalEnriched === 0) {
  console.log('No sources with _excerpt found — nothing to enrich.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Commit changes
// ---------------------------------------------------------------------------

console.log(`\nEnriched ${totalEnriched} source(s) in ${modifiedFiles.length} file(s).`);

execSync(`git config user.name "github-actions[bot]"`);
execSync(`git config user.email "github-actions[bot]@users.noreply.github.com"`);

for (const f of modifiedFiles) {
  execSync(`git add "${f}"`);
}

execSync(`git commit -m "Auto-enrich source tags via GitHub Models" --allow-empty`);

// Pull + rebase to handle concurrent index update commits
try {
  execSync('git pull --rebase origin main');
} catch {
  console.warn('Rebase failed — will try push anyway.');
}

execSync('git push');
console.log('Done — tags committed and pushed.');

// ---------------------------------------------------------------------------
// GitHub Models API call
// ---------------------------------------------------------------------------

async function generateTags(title, excerpt) {
  const prompt = `You are a tag generator for a technical knowledge base.

Given the title and content excerpt of a web page, generate 3-8 concise, lowercase, kebab-case tags that capture the key topics, technologies, and concepts.

Rules:
- Tags must be lowercase kebab-case (e.g., "incident-graph", "microsoft-sentinel", "kql")
- Focus on technologies, products, concepts, and techniques
- Avoid generic tags like "blog", "article", "security" unless highly specific
- Prefer specific terms over broad ones
- Return ONLY a JSON array of strings, nothing else

Title: ${title}

Content:
${excerpt.slice(0, 1500)}`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 200,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub Models API ${res.status}: ${body}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) throw new Error('Empty response from model');

  // Parse the JSON array from the response
  // Handle cases where model wraps in markdown code blocks
  const cleaned = content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  const tags = JSON.parse(cleaned);

  if (!Array.isArray(tags)) throw new Error('Response is not an array');

  // Validate and normalize
  return tags
    .filter((t) => typeof t === 'string')
    .map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
    .filter((t) => t.length >= 2 && t.length <= 40);
}
