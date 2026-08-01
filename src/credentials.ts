export interface MangabuffCredentials {
  login: string;
  password: string;
}

export function readMangabuffCredentials(
  env: NodeJS.ProcessEnv = process.env,
): MangabuffCredentials | undefined {
  const login = env.MANGABUFF_LOGIN?.trim();
  const password = env.MANGABUFF_PASSWORD;

  if (!login || password === undefined || password.length === 0) {
    return undefined;
  }

  return { login, password };
}

export function hasMangabuffPassword(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MANGABUFF_PASSWORD?.length ?? 0) > 0;
}
