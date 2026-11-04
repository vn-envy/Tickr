/** Resolve routing only. URL hints are not verified location or branch evidence. */
export interface BusinessReference {
  inputUrl: string;
  resolvedUrl: string;
  nameHint: string | null;
  coordinatesHint: { latitude: number; longitude: number; kind: "place" | "map_view" } | null;
  placeIdHint: string | null;
  featureIdHint: string | null;
  contextHint: string | null;
  warnings: string[];
}

const MAP_HOSTS = new Set(["google.com", "www.google.com", "maps.google.com", "google.co.in", "www.google.co.in"]);
const isMapsTarget = (url: URL) => MAP_HOSTS.has(url.hostname) && /^\/maps(?:\/|$)/.test(url.pathname);
const tokenPath = /^\/[a-zA-Z0-9_-]{4,100}\/?$/;

function decoded(value: string): string { try { return decodeURIComponent(value); } catch { return ""; } }
function boundedText(value: string): string | null {
  const text = value.replace(/\+/g, " ").trim();
  return text.length >= 2 && text.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(text) ? text : null;
}

function routingHints(url: URL): Pick<BusinessReference, "nameHint" | "coordinatesHint" | "placeIdHint" | "featureIdHint" | "contextHint" | "warnings"> {
  const result: ReturnType<typeof routingHints> = { nameHint: null, coordinatesHint: null, placeIdHint: null, featureIdHint: null, contextHint: null, warnings: [] };
  if (!isMapsTarget(url)) return result;
  const path = decoded(url.pathname);
  const rawName = url.pathname.startsWith("/maps/place/") ? url.pathname.slice("/maps/place/".length).split("/")[0] : "";
  result.nameHint = boundedText(decoded(rawName));
  const query = url.searchParams.get("query") || url.searchParams.get("q") || "";
  result.contextHint = boundedText(query) || result.nameHint;
  const coordinate = (latitude: string, longitude: string, kind: "place" | "map_view") => {
    if (!/^-?\d+(?:\.\d+)?$/.test(latitude) || !/^-?\d+(?:\.\d+)?$/.test(longitude)) return null;
    const lat = Number(latitude), lng = Number(longitude);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { latitude: lat, longitude: lng, kind } : null;
  };
  const pins = [...path.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)(?=!|\/|$)/g)].map((match) => coordinate(match[1], match[2], "place"));
  const queryPin = query.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (queryPin) pins.push(coordinate(queryPin[1], queryPin[2], "place"));
  const uniquePins = new Map(pins.filter((pin) => pin !== null).map((pin) => [`${pin.latitude},${pin.longitude}`, pin]));
  if (pins.some((pin) => pin === null) || uniquePins.size > 1) result.warnings.push("The Maps route contains invalid or conflicting place coordinates; no target coordinates were selected.");
  else if (uniquePins.size === 1) result.coordinatesHint = [...uniquePins.values()][0];
  else {
    const view = path.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|\/|$)/) || url.searchParams.get("ll")?.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
    if (view) result.coordinatesHint = coordinate(view[1], view[2], "map_view");
  }
  const ids = [url.searchParams.get("query_place_id"), url.searchParams.get("place_id"), query.startsWith("place_id:") ? query.slice(9) : null,
    ...[...path.matchAll(/!1s([^!\/]+)/g)].map((match) => match[1])].filter((value): value is string => Boolean(value));
  const placeIds = [...new Set(ids.filter((id) => /^[a-zA-Z0-9_-]{8,200}$/.test(id)))];
  const featureIds = [...new Set(ids.filter((id) => /^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(id)))];
  if (placeIds.length === 1) result.placeIdHint = placeIds[0];
  if (featureIds.length === 1) result.featureIdHint = featureIds[0];
  if (placeIds.length > 1 || featureIds.length > 1) result.warnings.push("The Maps route contains conflicting place identifiers; they were not treated as a branch match.");
  return result;
}

export async function resolveBusinessReference(input: string, dependencies: { fetch?: typeof fetch } = {}): Promise<BusinessReference> {
  const result: BusinessReference = { inputUrl: input, resolvedUrl: input, nameHint: null, coordinatesHint: null, placeIdHint: null, featureIdHint: null, contextHint: null, warnings: [] };
  let url: URL;
  try { url = new URL(input); } catch { result.warnings.push("The business link could not be interpreted."); return result; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.href.length > 8192) return result;
  if (url.hostname === "maps.app.goo.gl" && !url.search && !url.hash && /^\/[a-zA-Z0-9_-]{4,100}\.$/.test(url.pathname)) {
    url.pathname = url.pathname.slice(0, -1);
    result.resolvedUrl = url.href;
    result.warnings.push("Removed a trailing sentence period from the Maps short-link token; the original input is preserved.");
  }
  const applyHints = (target: URL) => {
    const hints = routingHints(target);
    result.nameHint = hints.nameHint; result.coordinatesHint = hints.coordinatesHint;
    result.placeIdHint = hints.placeIdHint; result.featureIdHint = hints.featureIdHint; result.contextHint = hints.contextHint;
    result.warnings.push(...hints.warnings);
  };
  applyHints(url);
  // All other sources are passed to Meta discovery; no arbitrary host can reach this fetch path.
  if (url.hostname !== "maps.app.goo.gl" || !tokenPath.test(url.pathname) || url.href.length > 2048) return result;
  const transport = dependencies.fetch ?? globalThis.fetch;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await transport(url.href, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(7000), headers: { Accept: "text/html" }, credentials: "omit", cache: "no-store" });
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (response.redirected || response.status < 300 || response.status >= 400 || !location || location.length > 8192) break;
      const destination = new URL(location, url);
      if (destination.protocol !== "https:" || destination.username || destination.password || destination.port) break;
      if (isMapsTarget(destination)) {
        result.resolvedUrl = destination.href;
        applyHints(destination);
        return result; // Deliberately never fetch the Maps destination.
      }
      if (destination.hostname !== "maps.app.goo.gl" || !tokenPath.test(destination.pathname)) break;
      url = destination;
    }
  } catch { /* Meta can still investigate the original URL. No unsafe redirect fallback. */ }
  result.warnings.push("The short link did not expose a usable Maps routing redirect. Meta will investigate the supplied reference directly.");
  return result;
}
