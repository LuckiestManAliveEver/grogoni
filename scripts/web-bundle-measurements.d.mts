export interface WebBundleMeasurements {
  initialJavaScriptGzip: number;
  initialCssGzip: number;
  ownerRouteGzip: number;
}

export function measureWebBundles(
  manifest: Record<string, unknown>,
  gzipBytes: (file: string) => number
): WebBundleMeasurements;
