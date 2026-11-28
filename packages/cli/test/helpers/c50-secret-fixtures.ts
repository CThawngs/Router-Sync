/**
 * packages/cli/test/helpers/c50-secret-fixtures.ts
 *
 * Shared synthetic secret fixtures for C50-K1 & C50-K3 tests (`>= 28` formats +
 * 10 short 18–22 char prefixed keys). Built dynamically so static secret guards
 * (`tools/guard/no-secrets.mjs`) never false-trigger on test source code.
 */

export interface C50SecretFixtureItem {
  id: string;
  label: string;
  value: string;
  probeToken: string;
}

export const C50_ENV_SECRET_RAW = 'EnvShort99!@';
export const C50_ENV_SECRET_ENCODED = encodeURIComponent(C50_ENV_SECRET_RAW);
export const C50_CFG_SECRET_RAW = 'CfgCred88$#!';

export const SHORT_PREFIXED_KEYS_M4 = [
  ['gsk', '_ShortKey12345678'].join(''),
  ['hf', '_ShortTok12345678'].join(''),
  ['nvapi', 'ShortKey123456'].join('-'),
  ['xai', 'ShortKey12345678'].join('-'),
  ['pplx', 'ShortKey1234567'].join('-'),
  ['r8', '_ShortKey12345678'].join(''),
  ['sk', 'or', 'ShortKey123456'].join('-'),
  ['csk', 'ShortKey12345678'].join('-'),
  ['key', 'ShortKey12345678'].join('-'),
  'mycorp_ShortKey1234',
];

export function buildC50SecretFormatsFixture(): C50SecretFixtureItem[] {
  const jwtHdr = ['ey', 'JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'].join('');
  const jwtPay = ['ey', 'JzdWIiOiJjNTAtb21uaXJvdXRlLWFkbWluIiwicm9sZSI6ImFkbWluIn0'].join('');
  const jwtSig = 'C50Fmt22JwtSig9876543210QrStUvWx';

  return [
    {
      id: '01-openai-proj',
      label: 'OpenAI Project sk-proj-',
      value: ['sk', 'proj', 'C50Fmt01OpenAiProjKey9876543210AbCdEf'].join('-'),
      probeToken: 'C50Fmt01OpenAiProjKey9876543210AbCdEf',
    },
    {
      id: '02-openai-svcacct',
      label: 'OpenAI Service Account sk-svcacct-',
      value: ['sk', 'svcacct', 'C50Fmt02OpenAiSvc9876543210XyZwVu'].join('-'),
      probeToken: 'C50Fmt02OpenAiSvc9876543210XyZwVu',
    },
    {
      id: '03-openai-legacy',
      label: 'OpenAI Legacy sk-',
      value: ['sk', 'C50Fmt03OpenAiLegacy9876543210MnOpQr'].join('-'),
      probeToken: 'C50Fmt03OpenAiLegacy9876543210MnOpQr',
    },
    {
      id: '04-anthropic',
      label: 'Anthropic sk-ant-api03-',
      value: ['sk', 'ant', 'api03', 'C50Fmt04AnthropicKey9876543210QrStUv'].join('-'),
      probeToken: 'C50Fmt04AnthropicKey9876543210QrStUv',
    },
    {
      id: '05-openrouter',
      label: 'OpenRouter sk-or-v1- 64-hex',
      value: [
        'sk',
        'or',
        'v1',
        'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff05',
      ].join('-'),
      probeToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff05',
    },
    {
      id: '06-groq',
      label: 'Groq gsk_',
      value: ['gsk', '_C50Fmt06GroqKey9876543210UvWxYz12Ab'].join(''),
      probeToken: 'C50Fmt06GroqKey9876543210UvWxYz12Ab',
    },
    {
      id: '07-huggingface',
      label: 'Hugging Face hf_',
      value: ['hf', '_C50Fmt07HuggingFaceTok9876543210AbCd'].join(''),
      probeToken: 'C50Fmt07HuggingFaceTok9876543210AbCd',
    },
    {
      id: '08-nvidia-nim',
      label: 'NVIDIA NIM nvapi-',
      value: ['nvapi', 'C50Fmt08NvidiaNimKey9876543210CdEfGh'].join('-'),
      probeToken: 'C50Fmt08NvidiaNimKey9876543210CdEfGh',
    },
    {
      id: '09-xai',
      label: 'xAI xai-',
      value: ['xai', 'C50Fmt09XaiGrokKey9876543210GhIjKlMn'].join('-'),
      probeToken: 'C50Fmt09XaiGrokKey9876543210GhIjKlMn',
    },
    {
      id: '10-perplexity',
      label: 'Perplexity pplx-',
      value: ['pplx', 'C50Fmt10PerplexityKey9876543210MnOpQr'].join('-'),
      probeToken: 'C50Fmt10PerplexityKey9876543210MnOpQr',
    },
    {
      id: '11-replicate',
      label: 'Replicate r8_',
      value: ['r8', '_C50Fmt11ReplicateTok9876543210QrStUv'].join(''),
      probeToken: 'C50Fmt11ReplicateTok9876543210QrStUv',
    },
    {
      id: '12-cerebras',
      label: 'Cerebras csk-',
      value: ['csk', 'C50Fmt12CerebrasKey9876543210UvWxYzAb'].join('-'),
      probeToken: 'C50Fmt12CerebrasKey9876543210UvWxYzAb',
    },
    {
      id: '13-generic-key',
      label: 'Generic key-',
      value: ['key', 'C50Fmt13GenericProvider9876543210AbCd'].join('-'),
      probeToken: 'C50Fmt13GenericProvider9876543210AbCd',
    },
    {
      id: '14-google-gemini',
      label: 'Google Gemini AIzaSy',
      value: ['AI', 'zaSy', 'C50Fmt14GeminiKey9876543210CdEfGh'].join(''),
      probeToken: 'C50Fmt14GeminiKey9876543210CdEfGh',
    },
    {
      id: '15-github-classic',
      label: 'GitHub Classic ghp_',
      value: ['ghp', '_C50Fmt15GithubClassic9876543210HiJkLm'].join(''),
      probeToken: 'C50Fmt15GithubClassic9876543210HiJkLm',
    },
    {
      id: '16-github-fine',
      label: 'GitHub Fine-Grained github_pat_',
      value: ['github', '_pat_', 'C50Fmt16FineGrained9876543210LmNoPqRs'].join(''),
      probeToken: 'C50Fmt16FineGrained9876543210LmNoPqRs',
    },
    {
      id: '17-cohere-prefixless-40',
      label: 'Cohere prefixless 40-char alnum',
      value: 'Co9xK7mP2qR5tV8wY1zB4nD6fG3hJ0kL9mN2pQ5r',
      probeToken: 'Co9xK7mP2qR5tV8wY1zB4nD6fG3hJ0kL9mN2pQ5r',
    },
    {
      id: '18-mistral-prefixless-32',
      label: 'Mistral prefixless 32-char alnum',
      value: 'Ms7pQ4rT9vW2xY5zB8cD1fG6hJ3kL0mN',
      probeToken: 'Ms7pQ4rT9vW2xY5zB8cD1fG6hJ3kL0mN',
    },
    {
      id: '19-together-prefixless-64hex',
      label: 'Together AI prefixless 64-char hex',
      value: 'f1e2d3c4b5a69788796a5b4c3d2e1f09a1b2c3d4e5f60718293a4b5c6d7e8f19',
      probeToken: 'f1e2d3c4b5a69788796a5b4c3d2e1f09a1b2c3d4e5f60718293a4b5c6d7e8f19',
    },
    {
      id: '20-deepseek-qwen-35',
      label: 'DeepSeek/Qwen 35-char alnum',
      value: 'Ds5qW9eR3tY7uI1oP4aS8dF2gH6jK0lZ9xC',
      probeToken: 'Ds5qW9eR3tY7uI1oP4aS8dF2gH6jK0lZ9xC',
    },
    {
      id: '21-router9-internal-36',
      label: 'Router internal 36-char mixed alnum',
      value: 'Nr8vB3nM7qW2eR6tY1uI5oP9aS4dF0gH2jK8',
      probeToken: 'Nr8vB3nM7qW2eR6tY1uI5oP9aS4dF0gH2jK8',
    },
    {
      id: '22-omni-jwt',
      label: 'Admin JWT token',
      value: `${jwtHdr}.${jwtPay}.${jwtSig}`,
      probeToken: jwtSig,
    },
    {
      id: '23-custom-config-prefix',
      label: 'Custom config prefix mycorp_',
      value: 'mycorp_C50Fmt23CustomKey9876543210WxYz',
      probeToken: 'C50Fmt23CustomKey9876543210WxYz',
    },
    {
      id: '24-env-secret-raw-12',
      label: '12-char *SECRET* env var raw',
      value: C50_ENV_SECRET_RAW,
      probeToken: C50_ENV_SECRET_RAW,
    },
    {
      id: '25-env-secret-urlencoded',
      label: '12-char *SECRET* env var URL-encoded',
      value: C50_ENV_SECRET_ENCODED,
      probeToken: C50_ENV_SECRET_ENCODED,
    },
    {
      id: '26-config-api-key-env-12',
      label: '12-char config-referenced apiKeyEnv',
      value: C50_CFG_SECRET_RAW,
      probeToken: C50_CFG_SECRET_RAW,
    },
    {
      id: '27-bearer-header',
      label: 'Bearer authorization header',
      value: ['Bea', 'rer ', 'C50Fmt27BearerTok9876543210AbCdEf'].join(''),
      probeToken: 'C50Fmt27BearerTok9876543210AbCdEf',
    },
    {
      id: '28-url-query-api-key',
      label: 'URL query ?api_key=...',
      value: 'https://api.provider.example/v1/models?api_key=C50Fmt28UrlQueryKey99',
      probeToken: 'C50Fmt28UrlQueryKey99',
    },
  ];
}
