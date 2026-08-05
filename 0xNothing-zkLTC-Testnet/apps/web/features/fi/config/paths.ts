export const FI_BASE_PATH = "/0xFi" as const;

export function fiPath(path: `/${string}`): string {
  return path === "/" ? FI_BASE_PATH : `${FI_BASE_PATH}${path}`;
}
