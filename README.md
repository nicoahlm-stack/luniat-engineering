# Luniat Engineering: AI in production

The code from [Luniat Engineering](https://luniat.com/en/magazine/engineering), a series of technical articles on building, evaluating and operating LLM systems that have to work every day.

Every snippet in the articles is taken from this code. It is type-checked with strict TypeScript and tested with Vitest on every change, and the SQL runs against a real Postgres with pgvector, compiled to WebAssembly with [PGlite](https://pglite.dev), so no database or API key is needed.

| No. | Article | Code |
| --- | --- | --- |
| 01 | [A reference architecture for LLM systems in production](https://luniat.com/en/magazine/engineering/llm-gateway-reference-architecture) | [`llm-gateway/`](./llm-gateway) |
| 02 | [Evals as CI: release gates for LLM systems](https://luniat.com/en/magazine/engineering/evals-as-ci) | [`evals/`](./evals) |
| 03 | [Retrieval that holds up: hybrid search, chunking and citations in Postgres](https://luniat.com/en/magazine/engineering/rag-in-production) | [`rag/`](./rag) |
| 04 | [Structured output and tool calls that do not break production](https://luniat.com/en/magazine/engineering/structured-output-and-tools) | [`structured/`](./structured) |
| 05 | [Multi-tenant AI without leaks: isolation from the database to the prompt](https://luniat.com/en/magazine/engineering/multi-tenant-ai) | [`multitenant/`](./multitenant) |
| 06 | [One rate limit, many tenants: fair queues and adaptive throttling](https://luniat.com/en/magazine/engineering/fair-scheduling-and-rate-limits) | [`scheduling/`](./scheduling) |
| 07 | [Cost and latency: caching, batching, routing and budgets](https://luniat.com/en/magazine/engineering/cost-and-latency) | [`cost/`](./cost) |
| 08 | [Security for LLM applications: injection, exfiltration and excessive agency](https://luniat.com/en/magazine/engineering/llm-security-in-production) | [`security/`](./security) |
| 09 | [Observability for LLM systems: traces, metrics and samples without leaking data](https://luniat.com/en/magazine/engineering/observability-for-llm-systems) | [`observability/`](./observability) |
| 10 | [Agents in production: state machines, budgets and humans in the loop](https://luniat.com/en/magazine/engineering/agents-in-production) | [`agents/`](./agents) |

## Våga hela vägen (in Swedish)

Shorter, practical articles for teams with an AI demo that works but has not shipped yet. Code from those articles:

| Nr | Article | Code |
| --- | --- | --- |
| 03 | [Ert första test av AI-svaren, på en eftermiddag](https://luniat.com/sv/magazine/vaga-hela-vagen/forsta-testet) | [`first-eval/`](./first-eval) |

## Running it

```sh
npm install
npm test
```

Node.js 22 or later. The tests use fake clocks, scripted models and an in-process Postgres; nothing calls a real model provider.

## What this is, and what it is not

This is reference code: small, readable implementations of the patterns the articles describe, with tests that pin down their behaviour. It is meant to be read, copied and adapted. It is not a framework or a library with a stable API, and some pieces are deliberately simplified, for example in-memory stores where production needs Redis or a database. The articles say where.

## Contributing

This repository is a mirror. The source lives with the articles, so pull requests cannot be merged here directly, but issues are welcome: if something is wrong, unclear or out of date, open an issue and we will fix it at the source.

## License

MIT. See [LICENSE](./LICENSE).
