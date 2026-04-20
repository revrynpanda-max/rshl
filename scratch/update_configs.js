const fs = require('fs');
let content = fs.readFileSync('src/utils/model/configs.ts', 'utf8');

content = content.replace(/(  foundry: '[^']+',)(\r?\n)}( as const satisfies ModelConfig)/g, "$1\n  ollama: 'kai-fast:latest',$2}$3");

const newConfigs = `
export const KAI_FAST_CONFIG = {
  firstParty: 'kai-fast:latest',
  bedrock: 'kai-fast:latest',
  vertex: 'kai-fast:latest',
  foundry: 'kai-fast:latest',
  ollama: 'kai-fast:latest',
} as const satisfies ModelConfig

export const KAI_OPEN_CONFIG = {
  firstParty: 'kai-open:latest',
  bedrock: 'kai-open:latest',
  vertex: 'kai-open:latest',
  foundry: 'kai-open:latest',
  ollama: 'kai-open:latest',
} as const satisfies ModelConfig
`;

content = content.replace('// @[MODEL LAUNCH]: Register the new config here.', newConfigs + '\n// @[MODEL LAUNCH]: Register the new config here.');

content = content.replace('export const ALL_MODEL_CONFIGS = {', 'export const ALL_MODEL_CONFIGS = {\n  kaiFast: KAI_FAST_CONFIG,\n  kaiOpen: KAI_OPEN_CONFIG,');

fs.writeFileSync('src/utils/model/configs.ts', content);
console.log('Done');
