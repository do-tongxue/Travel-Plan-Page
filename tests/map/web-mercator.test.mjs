import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MERCATOR_LAT,
  projectLatLng,
  unprojectY,
  assertBasemapBounds,
  boundsToWorld,
  worldToBounds,
  layoutWebMercator
} from "../../scripts/web-mercator.mjs";

const CANVAS = { width: 1448, height: 1086 };

test("projectLatLng maps the origin to the centre of the world", () => {
  const point = projectLatLng(0, 0);
  assert.equal(point.x, 0.5);
  assert.equal(point.y, 0.5);
});

test("projectLatLng maps the Mercator limits to the world edges", () => {
  const northWest = projectLatLng(MAX_MERCATOR_LAT, -180);
  assert.equal(northWest.x, 0);
  assert.ok(Math.abs(northWest.y) < 1e-9);
  assert.ok(Math.abs(unprojectY(0)) > 84);
});

test("bounds round-trip through world coordinates", () => {
  const bounds = [100, 30, 102, 32];
  const back = worldToBounds(boundsToWorld(bounds));
  back.forEach((value, index) => assert.ok(Math.abs(value - bounds[index]) < 1e-6, `index ${index}: ${value}`));
});

test("assertBasemapBounds rejects malformed boxes", () => {
  assert.throws(() => assertBasemapBounds([100, 30, 102]), /four finite numbers/);
  assert.throws(() => assertBasemapBounds([102, 30, 100, 32]), /east must be greater than west/);
  assert.throws(() => assertBasemapBounds([100, 32, 102, 30]), /north must be greater than south/);
  assert.throws(() => assertBasemapBounds([100, 30, 182, 32]), /longitudes/);
  assert.throws(() => assertBasemapBounds([100, -89, 102, 32]), /latitudes/);
  assert.throws(() => assertBasemapBounds([100, 30, 102, Infinity]), /four finite numbers/);
});

test("layoutWebMercator places places at true positions", () => {
  const places = [
    { id: "a", geo: { lat: 30, lng: 100 } },
    { id: "b", geo: { lat: 32, lng: 102 } },
    { id: "c", geo: { lat: 31, lng: 101 } },
    { id: "d", geo: { lat: 30.5, lng: 100.5 } }
  ];
  const points = layoutWebMercator(places, [100, 30, 102, 32], CANVAS);
  assert.deepEqual([points.get("a").x, points.get("a").y], [0, 1086]);
  assert.deepEqual([points.get("b").x, points.get("b").y], [1448, 0]);
  assert.deepEqual([points.get("c").x, points.get("c").y], [724, 545.85]);
  assert.deepEqual([points.get("d").x, points.get("d").y], [362, 816.62]);
});

test("layoutWebMercator keeps a deterministic fallback for missing geo", () => {
  const places = [{ id: "a", geo: { lat: 30, lng: 100 } }, { id: "unknown" }];
  const first = layoutWebMercator(places, [100, 30, 102, 32], CANVAS);
  const second = layoutWebMercator(places, [100, 30, 102, 32], CANVAS);
  assert.deepEqual(first.get("unknown"), second.get("unknown"));
  assert.ok(Number.isFinite(first.get("unknown").x));
});
