export const PROVIDER_NAMES = ['OpenAI', 'Claude'] as const;

export type Provider = (typeof PROVIDER_NAMES)[number];

export type ProviderRuntimeName = 'codex' | 'claude';

export type ProviderTraits = {
  label: string;
  vendor: string;
  runtime: ProviderRuntimeName;
  keyPrefix: string;
  keyPattern: RegExp | null;
  maskLead: number;
  attachmentLimitMb: number;
  liveInput: boolean;
  accountLogin: boolean;
  accountName: string;
  accountArticle: 'a' | 'an' | '';
  rank: number;
};

export const PROVIDER_TRAITS: Record<Provider, ProviderTraits> = {
  OpenAI: {
    label: 'ChatGPT', vendor: 'OpenAI', runtime: 'codex',
    keyPrefix: 'sk-', keyPattern: /^sk-[A-Za-z0-9_-]{8,}$/,
    maskLead: 7, attachmentLimitMb: 512, liveInput: true, accountLogin: true,
    accountName: 'ChatGPT', accountArticle: 'a', rank: 0
  },
  Claude: {
    label: 'Claude', vendor: 'Anthropic', runtime: 'claude',
    keyPrefix: 'sk-ant-', keyPattern: /^sk-ant-[A-Za-z0-9_-]{8,}$/,
    maskLead: 10, attachmentLimitMb: 30, liveInput: true, accountLogin: true,
    accountName: 'Claude', accountArticle: 'a', rank: 1
  }
};

export const BUNDLED_RUNTIMES = ['claude', 'codex'] as const;

export const PROVIDERS: Provider[] = [...PROVIDER_NAMES]
  .sort((left, right) => PROVIDER_TRAITS[left].rank - PROVIDER_TRAITS[right].rank);

export function providerTraits(provider: Provider) {
  return PROVIDER_TRAITS[provider];
}

export function accountPhrase(provider: Provider) {
  const { accountArticle, accountName } = PROVIDER_TRAITS[provider];
  return accountName ? `${accountArticle} ${accountName} account` : '';
}

export function accountLabel(provider: Provider) {
  const { accountName } = PROVIDER_TRAITS[provider];
  return accountName ? `${accountName} account` : '';
}

export const ACCOUNT_PROVIDERS = PROVIDERS.filter((provider) => PROVIDER_TRAITS[provider].accountLogin);

export const KEY_PROVIDERS = PROVIDERS.filter((provider) => PROVIDER_TRAITS[provider].keyPattern);

export const REFRESHABLE_PROVIDERS = PROVIDERS.filter((provider) => PROVIDER_TRAITS[provider].accountLogin);
