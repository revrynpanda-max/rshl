// Content for the KAI-api bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import csharpKAIApi from './KAI-api/csharp/KAI-api.md'
import curlExamples from './KAI-api/curl/examples.md'
import goKAIApi from './KAI-api/go/KAI-api.md'
import javaKAIApi from './KAI-api/java/KAI-api.md'
import phpKAIApi from './KAI-api/php/KAI-api.md'
import pythonAgentSdkPatterns from './KAI-api/python/agent-sdk/patterns.md'
import pythonAgentSdkReadme from './KAI-api/python/agent-sdk/README.md'
import pythonKAIApiBatches from './KAI-api/python/KAI-api/batches.md'
import pythonKAIApiFilesApi from './KAI-api/python/KAI-api/files-api.md'
import pythonKAIApiReadme from './KAI-api/python/KAI-api/README.md'
import pythonKAIApiStreaming from './KAI-api/python/KAI-api/streaming.md'
import pythonKAIApiToolUse from './KAI-api/python/KAI-api/tool-use.md'
import rubyKAIApi from './KAI-api/ruby/KAI-api.md'
import skillPrompt from './KAI-api/SKILL.md'
import sharedErrorCodes from './KAI-api/shared/error-codes.md'
import sharedLiveSources from './KAI-api/shared/live-sources.md'
import sharedModels from './KAI-api/shared/models.md'
import sharedPromptCaching from './KAI-api/shared/prompt-caching.md'
import sharedToolUseConcepts from './KAI-api/shared/tool-use-concepts.md'
import typescriptAgentSdkPatterns from './KAI-api/typescript/agent-sdk/patterns.md'
import typescriptAgentSdkReadme from './KAI-api/typescript/agent-sdk/README.md'
import typescriptKAIApiBatches from './KAI-api/typescript/KAI-api/batches.md'
import typescriptKAIApiFilesApi from './KAI-api/typescript/KAI-api/files-api.md'
import typescriptKAIApiReadme from './KAI-api/typescript/KAI-api/README.md'
import typescriptKAIApiStreaming from './KAI-api/typescript/KAI-api/streaming.md'
import typescriptKAIApiToolUse from './KAI-api/typescript/KAI-api/tool-use.md'

// @[MODEL LAUNCH]: Update the model IDs/names below. These are substituted into {{VAR}}
// placeholders in the .md files at runtime before the skill prompt is sent.
// After updating these constants, manually update the two files that still hardcode models:
//   - KAI-api/SKILL.md (Current Models pricing table)
//   - KAI-api/shared/models.md (full model catalog with legacy versions and alias mappings)
export const SKILL_MODEL_VARS = {
  OPUS_ID: 'KAI-opus-4-6',
  OPUS_NAME: 'KAI Opus 4.6',
  SONNET_ID: 'KAI-sonnet-4-6',
  SONNET_NAME: 'KAI Sonnet 4.6',
  HAIKU_ID: 'KAI-haiku-4-5',
  HAIKU_NAME: 'KAI Haiku 4.5',
  // Previous Sonnet ID — used in "do not append date suffixes" example in SKILL.md.
  PREV_SONNET_ID: 'KAI-sonnet-4-5',
} satisfies Record<string, string>

export const SKILL_PROMPT: string = skillPrompt

export const SKILL_FILES: Record<string, string> = {
  'csharp/KAI-api.md': csharpKAIApi,
  'curl/examples.md': curlExamples,
  'go/KAI-api.md': goKAIApi,
  'java/KAI-api.md': javaKAIApi,
  'php/KAI-api.md': phpKAIApi,
  'python/agent-sdk/README.md': pythonAgentSdkReadme,
  'python/agent-sdk/patterns.md': pythonAgentSdkPatterns,
  'python/KAI-api/README.md': pythonKAIApiReadme,
  'python/KAI-api/batches.md': pythonKAIApiBatches,
  'python/KAI-api/files-api.md': pythonKAIApiFilesApi,
  'python/KAI-api/streaming.md': pythonKAIApiStreaming,
  'python/KAI-api/tool-use.md': pythonKAIApiToolUse,
  'ruby/KAI-api.md': rubyKAIApi,
  'shared/error-codes.md': sharedErrorCodes,
  'shared/live-sources.md': sharedLiveSources,
  'shared/models.md': sharedModels,
  'shared/prompt-caching.md': sharedPromptCaching,
  'shared/tool-use-concepts.md': sharedToolUseConcepts,
  'typescript/agent-sdk/README.md': typescriptAgentSdkReadme,
  'typescript/agent-sdk/patterns.md': typescriptAgentSdkPatterns,
  'typescript/KAI-api/README.md': typescriptKAIApiReadme,
  'typescript/KAI-api/batches.md': typescriptKAIApiBatches,
  'typescript/KAI-api/files-api.md': typescriptKAIApiFilesApi,
  'typescript/KAI-api/streaming.md': typescriptKAIApiStreaming,
  'typescript/KAI-api/tool-use.md': typescriptKAIApiToolUse,
}
