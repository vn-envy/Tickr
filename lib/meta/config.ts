export const META_API_BASE_URL = "https://api.meta.ai/v1" as const;

export const META_MODEL_ENV_VARS = {
  reasoning: "META_REASONING_MODEL",
  strategy: "META_STRATEGY_MODEL",
  image: "META_IMAGE_MODEL",
  segmentation: "META_SEGMENTATION_MODEL",
} as const;

export type MetaModelRole = keyof typeof META_MODEL_ENV_VARS;
export type MetaModelConfig = Partial<Record<MetaModelRole, string>>;

export class MetaClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly outcome: "unknown" | "not_applicable";

  constructor(code: string, message: string, options: { status?: number; outcome?: "unknown" | "not_applicable" } = {}) {
    super(message);
    this.name = "MetaClientError";
    this.code = code;
    this.status = options.status;
    this.outcome = options.outcome ?? "not_applicable";
  }
}

export function getServerEnvironment(): NodeJS.ProcessEnv {
  if (typeof window !== "undefined") {
    throw new MetaClientError("SERVER_ONLY", "The Meta client can only run on the server");
  }
  return process.env;
}

/** Configuration is not proof that the account supports a model or operation. */
export function getMetaModelConfig(environment: Record<string, string | undefined> = getServerEnvironment()): MetaModelConfig {
  return Object.fromEntries(
    Object.entries(META_MODEL_ENV_VARS)
      .map(([role, variable]) => [role, environment[variable]?.trim()])
      .filter(([, value]) => Boolean(value)),
  );
}

export function requireMetaModel(role: MetaModelRole, config: MetaModelConfig = getMetaModelConfig()): string {
  const model = config[role]?.trim();
  if (!model) {
    throw new MetaClientError("MODEL_NOT_CONFIGURED", `Set ${META_MODEL_ENV_VARS[role]} after verifying model access`);
  }
  return model;
}
