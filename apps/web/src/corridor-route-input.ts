import type { CorridorLineString } from "@grogoni/shared-types";

// Turns the route an owner types or pastes into a GeoJSON LineString. People copy points from a
// maps app as "latitude, longitude" (Google Maps' "-1.2921, 36.8219"), one per line; GeoJSON wants
// [longitude, latitude]. Swapping them here, in one tested place, is the whole job: the server
// still validates the geometry and computes the route length itself (A14), so this never decides
// anything about the corridor.

export type RouteInputResult =
  | { ok: true; geometry: CorridorLineString }
  | { ok: false; line: number | null; reason: "format" | "range" | "too_few" };

const pointPattern = /^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/u;

export function parseRoutePoints(text: string): RouteInputResult {
  const coordinates: Array<[number, number]> = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const match = pointPattern.exec(line);
    if (match === null) return { ok: false, line: index + 1, reason: "format" };
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return { ok: false, line: index + 1, reason: "range" };
    }
    coordinates.push([longitude, latitude]);
  }
  if (coordinates.length < 2) return { ok: false, line: null, reason: "too_few" };
  return { ok: true, geometry: { type: "LineString", coordinates } };
}

/** Appends one "latitude, longitude" line, e.g. from the device GPS, to the typed route. */
export function appendRoutePoint(text: string, latitude: number, longitude: number): string {
  const point = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
  const trimmed = text.trimEnd();
  return trimmed === "" ? point : `${trimmed}\n${point}`;
}
