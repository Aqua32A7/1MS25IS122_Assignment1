# ScholarFlow: Computer Science Research Paper Agent

ScholarFlow is an AI research assistant and architecture analyzer specifically designed for undergraduate computer science students. It bridges the gap between academic theory and practical engineering by extracting core research contributions, rendering system flowcharts, and proposing rigorous portfolio project extensions.

## Key Features

- **Core Concept Extraction**: Distills the paper into 5 student-friendly fields (Problem Statement, Primary Methodology, Algorithmic Contributions, Key Findings, Plain-Language Explanation) strictly under 300 words total.
- **Architectural Flowchart**: Generates valid Mermaid.js (`graph TD`) system architecture diagrams with explicit identification of inferred components.
- **Undergraduate Build Opportunities**: Proposes exactly 3 realistic semester-length extensions for 3rd-year CS students featuring technical modifications, expected benefits (without fabricated experimental claims), tech stacks, implementation steps, and evaluation plans.
- **Grounded Metadata**: Accurately tracks authors, publication venues, years, and explicitly handles citation tracking with honest notes (citations set to null where unverified).
- **Graceful Paywall & Error Handling**: Transparently flags paywalled, unreadable, or abstract-only papers, preventing hallucinated architecture summaries.
- **Secure Architecture**: Server-side API key handling via `dotenv`, strict Mermaid security modes, and sanitized DOM operations (`textContent` rather than `innerHTML`).

---

## Architecture Overview

```
                      +-----------------------------------+
                      |   Browser Client (public/index.html)|
                      |   - Tailored Editorial UI         |
                      |   - Mermaid.js (strict security)  |
                      |   - Client-side Word Counter      |
                      +-----------------+-----------------+
                                        |  REST API
                                        v
                      +-----------------+-----------------+
                      |    Node.js / Express (server.js)  |
                      |   - Input Validation              |
                      |   - Prompt & Few-shot Injection   |
                      |   - Ajv Schema Validation         |
                      |   - Automatic Shorten Endpoint    |
                      +-----------------+-----------------+
                                        |  @google/genai SDK
                                        v
                      +-----------------+-----------------+
                      |     Google Gemini 2.5 Flash       |
                      |   - Google Search Grounding       |
                      |   - Multi-Turn Few-Shot Context   |
                      +-----------------------------------+
```

---

## Setup & Installation

### Prerequisites
- Node.js v20+ (tested on Node v24)
- npm v10+
- A Google Gemini API Key from [Google AI Studio](https://aistudio.google.com/)

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy the template and provide your Gemini API key:
```bash
cp .env.example .env
```
Edit `.env`:
```env
GEMINI_API_KEY=your_gemini_api_key_here
PORT=3000
```
> **Security Note:** Never commit your `.env` file to version control. The repository's `.gitignore` automatically excludes all `.env*` files.

### 3. Launch the Server
```bash
npm start
```
The application will be live at `http://localhost:3000`.

---

## Prompting Approach & Assignment Compliance

- **Role Definition**: The agent is prompted as an expert Computer Science research educator assisting 3rd-year undergraduate students.
- **Internal Reasoning vs Output**: Adheres strictly to internal reasoning guidelines: *"Reason carefully internally. Output only concise justifications in inference_notes. Do not output private reasoning."*
- **Few-Shot Grounding**: Injects two synthetic few-shot examples (`few_shot_examples.json`) demonstrating both successful complete extractions and unavailable/paywalled fallbacks.
- **Schema Validation**: Outputs strictly adhere to `schema.json`. Responses are validated using `Ajv` on the backend, with an automatic single retry on schema or formatting anomalies.
- **Client-Side Word Counter**: Real-time counter validates the 5 summary fields. If they exceed 300 words, the application automatically requests an AI compression pass (`/api/shorten`) and displays a warning badge if still over limit.

---

## Project Structure

```
├── .env.example              # Placeholder environment configuration
├── .gitignore                # Excludes secrets, node_modules, build outputs
├── few_shot_examples.json    # Synthetic multi-turn few-shot prompt examples
├── package.json              # Project metadata, dependencies, start script
├── public/
│   └── index.html            # Frontend UI (Mermaid.js, Tailwind, client scripts)
├── README.md                 # Complete documentation
├── research_agent_prompt.txt # System prompt with content & schema rules
├── sample_analysis.json      # Bundled reference analysis conforming to schema
├── sample_analysis.txt       # Plain-text representation of the sample analysis
├── schema.json               # JSON Schema for Ajv backend validation
└── server.js                 # Express server with @google/genai SDK integration
```

---

## Honest Limitations

1. **Grounded Search Availability**: If an obscure paper is behind an aggressive publisher paywall (e.g. IEEE Xplore, ScienceDirect without open preprints), the model will return `unavailable` status rather than fabricating content.
2. **Citation Counters**: Citation metrics are volatile and frequently vary across Google Scholar, Semantic Scholar, and publishers. ScholarFlow leaves citations as null unless verified with certainty through grounded metadata.
3. **Token Ceilings**: Analysis requests are bounded by `maxOutputTokens: 4000`, keeping total execution comfortably under 25,000 tokens while preventing token bloat.
