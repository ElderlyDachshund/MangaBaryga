export type LogFields = Record<string, boolean | number | string | undefined>;

export function logInfo(message: string, fields: LogFields = {}): void {
  console.log(formatLogLine("info", message, fields));
}

export function logWarn(message: string, fields: LogFields = {}): void {
  console.warn(formatLogLine("warn", message, fields));
}

export function logError(message: string, fields: LogFields = {}): void {
  console.error(formatLogLine("error", message, fields));
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatLogLine(level: string, message: string, fields: LogFields): string {
  const details = Object.entries(fields)
    .filter((entry): entry is [string, boolean | number | string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${formatFieldValue(value)}`)
    .join(" ");

  return details
    ? `${new Date().toISOString()} level=${level} message=${JSON.stringify(message)} ${details}`
    : `${new Date().toISOString()} level=${level} message=${JSON.stringify(message)}`;
}

function formatFieldValue(value: boolean | number | string): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  return String(value);
}
