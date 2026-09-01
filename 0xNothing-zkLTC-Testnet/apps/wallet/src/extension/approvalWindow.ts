export interface ApprovalWindowLike {
  id?: number;
  tabs?: readonly { url?: string; pendingUrl?: string }[];
}

/** Finds an approval popup that survived an MV3 service-worker restart. */
export function findApprovalWindowId(
  windows: readonly ApprovalWindowLike[],
  approvalRouteUrl: string,
): number | undefined {
  for (const candidate of windows) {
    if (candidate.id === undefined) continue;
    const match = candidate.tabs?.some((tab) => {
      // Chrome may expose an about:blank/current URL and the real extension
      // target in pendingUrl while the popup is still navigating. Inspect both
      // so a worker restart during that narrow window cannot open a duplicate.
      return [tab.url, tab.pendingUrl].some((url) =>
        url === approvalRouteUrl || url?.startsWith(`${approvalRouteUrl}?`) === true
      );
    });
    if (match) return candidate.id;
  }
  return undefined;
}
