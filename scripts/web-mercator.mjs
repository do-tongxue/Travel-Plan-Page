/**
 * Web Mercator helpers for the opt-in real-basemap mode.
 *
 * Pure functions only: no file system, no network. `build-map.mjs` uses
 * `assertBasemapBounds` + `layoutWebMercator`; `build-basemap.mjs` uses
 * `boundsToWorld` + `worldToBounds` to describe the tile it rendered.
 */

export const MAX_MERCATOR_LAT = 85.05112878;

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;

/** WGS84 degrees -> normalized world coordinates in [0, 1]. */
export function projectLatLng(lat, lng) {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  return {
    x: (lng + 180) / 360,
    y: (1 - Math.log(Math.tan(toRadians(clamped)) + 1 / Math.cos(toRadians(clamped))) / Math.PI) / 2
  };
}

/** Normalized world y -> latitude in degrees. */
export function unprojectY(y) {
  return toDegrees(Math.atan(Math.sinh(Math.PI * (1 - 2 * y))));
}

/**
 * A basemap box is `[west, south, east, north]` in WGS84 degrees.
 * Throws when the box is malformed, inverted, or outside the Mercator world.
 */
export function assertBasemapBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every((value) => Number.isFinite(value))) {
    throw new Error("map.basemap.bounds must be [west, south, east, north] with four finite numbers");
  }
  const [west, south, east, north] = bounds;
  if (!(east > west)) throw new Error("map.basemap.bounds east must be greater than west");
  if (!(north > south)) throw new Error("map.basemap.bounds north must be greater than south");
  if (west < -180 || east > 180) throw new Error("map.basemap.bounds longitudes must stay within [-180, 180]");
  if (south < -MAX_MERCATOR_LAT || north > MAX_MERCATOR_LAT) {
    throw new Error(`map.basemap.bounds latitudes must stay within [-${MAX_MERCATOR_LAT}, ${MAX_MERCATOR_LAT}]`);
  }
}

/** Degrees box -> normalized world box (north/south converted through Mercator). */
export function boundsToWorld(bounds) {
  assertBasemapBounds(bounds);
  const [west, south, east, north] = bounds;
  const worldWest = (west + 180) / 360;
  const worldEast = (east + 180) / 360;
  const worldNorth = projectLatLng(north, west).y;
  const worldSouth = projectLatLng(south, east).y;
  return {
    west: worldWest,
    east: worldEast,
    north: worldNorth,
    south: worldSouth,
    width: worldEast - worldWest,
    height: worldSouth - worldNorth
  };
}

/** Normalized world box -> degrees box. */
export function worldToBounds(world) {
  return [
    Number((world.west * 360 - 180).toFixed(8)),
    Number(unprojectY(world.south).toFixed(8)),
    Number((world.east * 360 - 180).toFixed(8)),
    Number(unprojectY(world.north).toFixed(8))
  ];
}

/**
 * Place every geocoded place at its true position on the basemap canvas.
 * Returns a Map of id -> { x, y, originalX, originalY } in canvas pixels.
 * Places without usable geo coordinates keep the deterministic spiral fallback
 * used by the schematic layout, so the page still renders.
 */
export function layoutWebMercator(places, bounds, canvas) {
  const world = boundsToWorld(bounds);
  const points = new Map();

  for (const place of places) {
    const lat = Number(place?.geo?.lat);
    const lng = Number(place?.geo?.lng ?? place?.geo?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const projected = projectLatLng(lat, lng);
    const x = ((projected.x - world.west) / world.width) * canvas.width;
    const y = ((projected.y - world.north) / world.height) * canvas.height;
    points.set(place.id, { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), originalX: x, originalY: y });
  }

  places.filter((place) => !points.has(place.id)).forEach((place, index) => {
    const angle = index * 2.3999632297;
    const radius = 42 + Math.floor(index / 6) * 46;
    const x = canvas.width / 2 + Math.cos(angle) * radius;
    const y = canvas.height / 2 + Math.sin(angle) * radius;
    points.set(place.id, { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), originalX: x, originalY: y });
  });

  return points;
}
