import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import Ajv from 'ajv';

// Model constant at top of file - using current recommended Gemini Flash model
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Load prompts, schema, few-shot examples, and sample analysis at startup
const systemPromptText = fs.readFileSync(path.join(__dirname, 'research_agent_prompt.txt'), 'utf8');
const fewShotExamples = JSON.parse(fs.readFileSync(path.join(__dirname, 'few_shot_examples.json'), 'utf8'));
const schemaJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));
const sampleAnalysisJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample_analysis.json'), 'utf8'));
const sampleAnalysisTxt = fs.readFileSync(path.join(__dirname, 'sample_analysis.txt'), 'utf8');

const ajv = new Ajv({ allErrors: true });
const validateSchema = ajv.compile(schemaJson);

function extractJson(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Model returned an empty response.');
  }
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  } else {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }
  return JSON.parse(cleaned);
}

// Endpoint to fetch bundled sample data
app.get('/api/sample', (req, res) => {
  res.json(sampleAnalysisJson);
});

app.get('/api/sample/text', (req, res) => {
  res.type('text/plain').send(sampleAnalysisTxt);
});

// Primary analysis endpoint
app.post('/api/analyze', async (req, res) => {
  const { inputType, content } = req.body || {};

  // Validation
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({
      error: { code: 'INVALID_INPUT', message: 'Input cannot be empty. Please provide a paper URL, title, or abstract.' }
    });
  }

  const trimmed = content.trim();

  let isUrl = false;
  const isUrlLike = /^([a-zA-Z0-9+.-]+:\/\/|[a-z0-9-]+\.[a-z]{2,})/i.test(trimmed);

  if (inputType === 'url') {
    if (isUrlLike) {
      if (!/^https?:\/\//i.test(trimmed)) {
        return res.status(400).json({
          error: { code: 'INVALID_URL', message: 'Invalid URL protocol. URLs must start with http:// or https://' }
        });
      }
      try {
        new URL(trimmed);
        isUrl = true;
      } catch {
        return res.status(400).json({
          error: { code: 'MALFORMED_URL', message: 'Malformed URL. Please check the URL formatting and try again.' }
        });
      }
    } else {
      // It's a plain title - allowed!
      isUrl = false;
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim() || apiKey.trim() === 'your_key_here') {
    return res.status(500).json({
      error: {
        code: 'MISSING_API_KEY',
        message: 'GEMINI_API_KEY is not configured on the server. Please add your Gemini API key to .env.'
      }
    });
  }

  // Build few-shot history
  const fewShotTurns = [];
  for (const item of fewShotExamples) {
    fewShotTurns.push({
      role: 'user',
      parts: [{ text: item.input }]
    });
    fewShotTurns.push({
      role: 'model',
      parts: [{ text: JSON.stringify(item.output, null, 2) }]
    });
  }

  let promptInstruction = '';
  if (inputType === 'url') {
    if (isUrl) {
      promptInstruction = `Analyze the research paper at the following URL:\nURL: ${trimmed}\n\n` +
        `Use Google Search grounding to retrieve information about the paper, including its official abstract, architecture details, methodologies, authors, publication venue, and open-source implementations.\n` +
        `If the paper cannot be accessed or read (due to a paywall, login requirement, or broken link) and reliable information cannot be grounded, return status 'unavailable' with clear explanation and suggestions as instructed.\n` +
        `If the paper content is long, use search for the abstract, authoritative summaries, and open-source implementations. Output valid JSON only.`;
    } else {
      promptInstruction = `Analyze the research paper with the following title:\nTitle: "${trimmed}"\n\n` +
        `Use Google Search grounding to retrieve information about the paper, including its official abstract, architecture details, methodologies, authors, publication venue, and open-source implementations.\n` +
        `If the paper cannot be identified or reliable information cannot be grounded, return status 'unavailable' with clear explanation and suggestions as instructed.\n` +
        `Output valid JSON only.`;
    }
  } else {
    promptInstruction = `Analyze the following research paper abstract / methodology text provided directly by the user:\n\n${trimmed}\n\n` +
      `Use Google Search grounding if helpful to identify the paper, venue, and authors. Note that because only the abstract/text was provided, set status to 'partial' unless full paper details are verified.\n` +
      `Output valid JSON only.`;
  }

  const ai = new GoogleGenAI({ apiKey });

  const config = {
    systemInstruction: systemPromptText,
    tools: [{ googleSearch: {} }],
    maxOutputTokens: 4000,
    temperature: 0.2
  };

  const contents = [
    ...fewShotTurns,
    {
      role: 'user',
      parts: [{ text: promptInstruction }]
    }
  ];

  try {
    let resultText = '';
    let parsedResult = null;

    // Call 1 with automatic fallback if search grounding is unsupported or quota-limited
    let response;
    let usedConfig = config;
    try {
      response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: usedConfig
      });
    } catch (groundingErr) {
      const gMsg = groundingErr?.message || '';
      if (groundingErr?.status === 429 || gMsg.includes('429') || gMsg.includes('RESOURCE_EXHAUSTED') || gMsg.includes('tools')) {
        console.warn('Grounding unavailable or quota-limited; falling back to direct analysis without search grounding...');
        usedConfig = {
          systemInstruction: systemPromptText,
          maxOutputTokens: 4000,
          temperature: 0.2
        };
        response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents,
          config: usedConfig
        });
      } else {
        throw groundingErr;
      }
    }

    resultText = response.text;
    let activeResponse = response;

    try {
      parsedResult = extractJson(resultText);
      const isValid = validateSchema(parsedResult);
      if (!isValid) {
        throw new Error('Schema validation error: ' + ajv.errorsText(validateSchema.errors));
      }
    } catch (parseOrValidationError) {
      // Retry once on invalid JSON or schema error
      const retryContents = [
        ...contents,
        { role: 'model', parts: [{ text: resultText || '' }] },
        {
          role: 'user',
          parts: [{
            text: `The previous response failed validation: ${parseOrValidationError.message}. Please fix the issue and return ONLY a single strictly valid JSON object adhering precisely to the required schema, with no markdown fences.`
          }]
        }
      ];

      const retryResponse = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: retryContents,
        config: usedConfig
      });
      activeResponse = retryResponse;

      resultText = retryResponse.text;
      parsedResult = extractJson(resultText);
      const isRetryValid = validateSchema(parsedResult);
      if (!isRetryValid) {
        throw new Error('Retry response failed schema validation: ' + ajv.errorsText(validateSchema.errors));
      }
    }

    // Post-processing check for metadata honesty
    if (parsedResult && parsedResult.metadata) {
      const candidate = (activeResponse?.candidates && activeResponse.candidates[0]) || {};
      const groundingMeta = candidate.groundingMetadata || activeResponse?.groundingMetadata;
      const chunks = (groundingMeta && Array.isArray(groundingMeta.groundingChunks)) ? groundingMeta.groundingChunks : [];
      const webChunks = chunks.filter(c => c && (c.web?.uri || c.web?.title));
      const queries = (groundingMeta && Array.isArray(groundingMeta.webSearchQueries)) ? groundingMeta.webSearchQueries : [];
      const hasRetrievedWebSources = (webChunks.length > 0) || (queries.length > 0);

      const verificationNotes = parsedResult.metadata.verification_notes || '';
      const namedSourcesPattern = /(Semantic Scholar|Google Scholar|OpenAlex|Crossref|publisher)/i;
      const mentionsNamedSource = namedSourcesPattern.test(verificationNotes);

      // Check citations
      if (parsedResult.metadata.citations !== null && parsedResult.metadata.citations !== undefined) {
        if (!hasRetrievedWebSources || !mentionsNamedSource) {
          parsedResult.metadata.citations = null;
          parsedResult.metadata.verification_notes = ((parsedResult.metadata.verification_notes || '') + " Citation count removed: no retrieved source supported it.").trim();
        }
      }

      // Check authors
      if (!hasRetrievedWebSources) {
        parsedResult.metadata.verification_notes = ((parsedResult.metadata.verification_notes || '') + " Author list not confirmed by a retrieved source.").trim();
      }
    }

    if (inputType === 'url' && !parsedResult.source_url) {
      parsedResult.source_url = trimmed;
    }

    return res.json(parsedResult);
  } catch (err) {
    console.error('API Error during /api/analyze:', err);
    const errMsg = err?.message || '';
    if (err?.status === 429 || errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
      return res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Gemini API rate limit reached. Please wait a moment and click Retry.'
        }
      });
    }

    if (err?.name === 'AbortError' || errMsg.includes('timeout')) {
      return res.status(504).json({
        error: {
          code: 'TIMEOUT',
          message: 'The paper analysis request timed out. Please try again with a specific URL or abstract.'
        }
      });
    }

    return res.status(500).json({
      error: {
        code: 'ANALYSIS_ERROR',
        message: 'Failed to analyze paper: ' + (errMsg || 'Unknown internal error')
      }
    });
  }
});

// Automatic shorten endpoint if 5 core summary fields combined exceed 300 words
app.post('/api/shorten', async (req, res) => {
  const { core_summary } = req.body || {};
  if (!core_summary) {
    return res.status(400).json({ error: { message: 'Missing core_summary in request' } });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_key_here') {
    return res.status(500).json({ error: { message: 'No GEMINI_API_KEY configured' } });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const prompt = `Here are the 5 core summary fields of a computer science research paper:\n${JSON.stringify(core_summary, null, 2)}\n\n` +
      `The total combined word count of all 5 fields currently exceeds 300 words.\n` +
      `Please rewrite and compress the fields so that their COMBINED word count is strictly under 300 words total (target 200-250 words).\n` +
      `Preserve all key technical contributions, problem clarity, methodology, and findings.\n` +
      `Output ONLY a valid JSON object with the exact same 5 keys: problem_statement, methodology, algorithmic_contributions, key_findings, plain_language_explanation. No markdown fences.`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: { maxOutputTokens: 1000, temperature: 0.1 }
    });

    const shortened = extractJson(response.text);
    return res.json({ core_summary: shortened });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to compress summary: ' + err.message } });
  }
});

app.listen(PORT, () => {
  console.log(`ScholarFlow backend running on http://localhost:${PORT}`);
  console.log(`Configured Gemini Model: ${GEMINI_MODEL}`);
});
