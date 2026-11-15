import type { Provider } from "./types.js";

export type ChildProcessKind = "binary-detection" | "git" | "verification" | Provider;

const SYSTEM_VARIABLES = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "SYSTEMDRIVE",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "USER",
  "LOGNAME",
  "USERNAME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "__CF_USER_TEXT_ENCODING",
] as const;

const CODEX_VARIABLES = [
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_FEDERATION_RULE_ID",
  "OPENAI_IDENTITY_TOKEN_FILE",
  "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
  "CODEX_CA_CERTIFICATE",
] as const;

const CLAUDE_VARIABLES = [
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "NODE_EXTRA_CA_CERTS",
  "CLAUDE_CODE_GIT_BASH_PATH",
] as const;

const CLAUDE_BACKEND_SELECTORS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const;

const NETWORK_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

const AWS_CREDENTIAL_VARIABLES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_SDK_LOAD_CONFIG",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
] as const;

const CLAUDE_BEDROCK_VARIABLES = [
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_USE_MANTLE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_BEDROCK_REGION_PREFIX",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
] as const;

const CLAUDE_VERTEX_VARIABLES = [
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_VERTEX_BASE_URL",
] as const;

const CLAUDE_FOUNDRY_VARIABLES = [
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_CERTIFICATE_PASSWORD",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_AUTHORITY_HOST",
] as const;

const CLAUDE_ANTHROPIC_AWS_VARIABLES = [
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_AWS_BASE_URL",
] as const;

function sourceKey(source: NodeJS.ProcessEnv, name: string): string | undefined {
  if (source[name] !== undefined) return name;
  if (process.platform !== "win32") return undefined;
  return Object.keys(source).find(key => key.toUpperCase() === name.toUpperCase());
}

function copy(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  names: readonly string[],
): void {
  for (const name of names) {
    const key = sourceKey(source, name);
    if (key) target[key] = source[key];
  }
}

function enabled(source: NodeJS.ProcessEnv, name: string): boolean {
  const key = sourceKey(source, name);
  return Boolean(key && /^(?:1|true|yes|on)$/i.test(source[key]!.trim()));
}

export function childProcessEnvironment(
  kind: ChildProcessKind,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  copy(environment, source, SYSTEM_VARIABLES);

  if (kind === "codex") {
    copy(environment, source, CODEX_VARIABLES);
  } else if (kind === "claude") {
    copy(environment, source, CLAUDE_VARIABLES);
    copy(environment, source, NETWORK_VARIABLES);
    const backendVariables = {
      CLAUDE_CODE_USE_BEDROCK: [...AWS_CREDENTIAL_VARIABLES, ...CLAUDE_BEDROCK_VARIABLES],
      CLAUDE_CODE_USE_VERTEX: CLAUDE_VERTEX_VARIABLES,
      CLAUDE_CODE_USE_FOUNDRY: CLAUDE_FOUNDRY_VARIABLES,
      CLAUDE_CODE_USE_ANTHROPIC_AWS: [...AWS_CREDENTIAL_VARIABLES, ...CLAUDE_ANTHROPIC_AWS_VARIABLES],
    } as const;
    for (const selector of CLAUDE_BACKEND_SELECTORS) {
      if (!enabled(source, selector)) continue;
      environment[selector] = "1";
      copy(environment, source, backendVariables[selector]);
    }
  }

  if (kind === "codex" || kind === "claude" || kind === "verification") {
    environment.CI = "true";
  }
  return environment;
}
