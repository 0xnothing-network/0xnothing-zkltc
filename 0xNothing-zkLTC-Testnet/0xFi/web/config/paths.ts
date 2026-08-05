export const FI_BASE_PATH = "/0xFi" as const;

export function fiPath(path: `/${string}`): string {
  return `${FI_BASE_PATH}${path}`;
}
