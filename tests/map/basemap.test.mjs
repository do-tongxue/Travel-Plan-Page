import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "tests/map/fixtures/trip-basemap.json");
const CORE_FILES = ["index.html", "styles.css", "app.js", "overview-map.js", "route-ui.js", "ledger.js", "runtime-storage.js"];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function runNode(script, args, cwd = ROOT) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

test("build-map emits a real-basemap region from map.basemap", () => {
  const out = path.join(tempDir("travel-basemap-"), "out.json");
  const result = runNode(path.join(ROOT, "scripts/build-map.mjs"), ["--trip", FIXTURE, "--out", out]);
  assert.equal(result.status, 0, result.stderr);

  const region = readJson(out).routeMap.regions[0];
  assert.equal(region.mapMode, "real-basemap");
  assert.equal(region.scope, "real-basemap");
  assert.equal(region.templateId, "real-basemap");
  assert.equal(region.baseImage, "tests/map/fixtures/basemap.png");
  assert.deepEqual(region.projection, { type: "web-mercator", bounds: [100, 30, 102, 32], padding: 0 });
  assert.match(region.ariaLabel, /旅行路线图/);
  assert.match(region.disclaimer, /Test attribution/);
  assert.deepEqual([region.places[0].x, region.places[0].y], [0, 1086]);
  assert.deepEqual([region.places[1].x, region.places[1].y], [1448, 0]);
});

test("build-map keeps the schematic path when map.basemap is absent", () => {
  const dir = tempDir("travel-basemap-plain-");
  const trip = readJson(FIXTURE);
  delete trip.map.basemap;
  const fixture = path.join(dir, "trip.json");
  writeJson(fixture, trip);

  const out = path.join(dir, "out.json");
  const result = runNode(path.join(ROOT, "scripts/build-map.mjs"), ["--trip", fixture, "--out", out]);
  assert.equal(result.status, 0, result.stderr);

  const region = readJson(out).routeMap.regions[0];
  assert.equal(region.mapMode, "frozen-template");
  assert.equal(region.projection.type, "relative-schematic");
  assert.match(region.ariaLabel, /模板化旅行路线示意图/);
});

test("build-map is deterministic for the same basemap input", () => {
  const dir = tempDir("travel-basemap-determinism-");
  const first = path.join(dir, "first.json");
  const second = path.join(dir, "second.json");
  assert.equal(runNode(path.join(ROOT, "scripts/build-map.mjs"), ["--trip", FIXTURE, "--out", first]).status, 0);
  assert.equal(runNode(path.join(ROOT, "scripts/build-map.mjs"), ["--trip", FIXTURE, "--out", second]).status, 0);
  assert.equal(fs.readFileSync(first, "utf8"), fs.readFileSync(second, "utf8"));
});

test("build-basemap --dry-run plans the tile grid without network", () => {
  const result = runNode(path.join(ROOT, "scripts/build-basemap.mjs"), ["--trip", FIXTURE, "--dry-run", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.zoom, 10);
  assert.equal(plan.tiles.count, 99);
  assert.deepEqual(plan.bounds.map((value) => Number(value.toFixed(2))), [99.2, 29.84, 102.8, 32.16]);
  assert.equal(plan.basemap.file, plan.output);
  assert.ok(plan.basemap.attribution.length > 0);
});

function makeSite(mutate) {
  const dir = tempDir("travel-validate-");
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  for (const file of ["validate-lite.mjs", "build-map.mjs", "web-mercator.mjs"]) {
    fs.copyFileSync(path.join(ROOT, "scripts", file), path.join(dir, "scripts", file));
  }
  for (const file of CORE_FILES) fs.writeFileSync(path.join(dir, file), "");
  fs.mkdirSync(path.join(dir, "assets/maps/templates"), { recursive: true });
  writeJson(path.join(dir, "assets/maps/templates/manifest.json"), {
    schemaVersion: "1.0.0",
    canvas: { width: 1448, height: 1086 },
    defaultTemplate: "none",
    templates: [],
    disclaimer: "fixture"
  });
  fs.mkdirSync(path.join(dir, "assets/maps/real"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "tests/map/fixtures/basemap.png"), path.join(dir, "assets/maps/real/fixture.png"));

  const trip = readJson(FIXTURE);
  trip.map.basemap.file = "assets/maps/real/fixture.png";
  const tripFile = path.join(dir, "trip-data.json");
  writeJson(tripFile, trip);

  const built = runNode(path.join(dir, "scripts/build-map.mjs"), ["--trip", tripFile], dir);
  assert.equal(built.status, 0, built.stderr);

  if (mutate) {
    const data = readJson(tripFile);
    mutate(data);
    writeJson(tripFile, data);
  }

  const validate = () => runNode(path.join(dir, "scripts/validate-lite.mjs"), ["--trip", tripFile], dir);
  return { dir, tripFile, validate };
}

test("validate-lite accepts a consistent real-basemap trip", () => {
  const site = makeSite();
  const result = site.validate();
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /PASS/);
});

for (const [name, mutate, expected] of [
  ["missing file", (data) => { data.map.basemap.file = "assets/maps/real/missing.png"; }, /不存在/],
  ["empty attribution", (data) => { data.map.basemap.attribution = "  "; }, /attribution/],
  ["inverted bounds", (data) => { data.map.basemap.bounds = [102, 30, 100, 32]; }, /bounds/],
  ["path traversal", (data) => { data.map.basemap.file = "../assets/maps/real/fixture.png"; }, /相对路径/],
  ["stale routeMap", (data) => { data.map.basemap.bounds = [100, 30, 102.5, 32]; }, /不一致/],
  ["removed basemap", (data) => { delete data.map.basemap; }, /重新运行 npm run build:map/]
]) {
  test(`validate-lite rejects ${name}`, () => {
    const site = makeSite(mutate);
    const result = site.validate();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, expected);
  });
}

test("validate-lite rejects a PNG with the wrong canvas", () => {
  const site = makeSite();
  fs.copyFileSync(path.join(ROOT, "tests/map/fixtures/tiny.png"), path.join(site.dir, "assets/maps/real/fixture.png"));
  const result = site.validate();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /1448x1086/);
});
