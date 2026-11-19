#!/usr/bin/env node
/**
 * Opt-in advanced tool: build a real, geo-accurate basemap image for one trip.
 *
 * The output is a PNG cropped to the Golden canvas (1448 x 1086) plus a sidecar
 * JSON recording the exact Web Mercator box, so `build-map.mjs` can place
 * places at their true positions on top of that same image.
 *
 * Tiles are composited by rendering a grid of data-URI images in a headless
 * browser, so no image library is required. Playwright is an optional global
 * prerequisite: only this tool needs it, and `--dry-run` works without it.
 *
 * This is an advanced/DIY escape hatch. Ordinary generation uses the ten fixed
 * templates in `assets/maps/templates/manifest.json` and must not run this.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { boundsToWorld, worldToBounds, assertBasemapBounds } from "./web-mercator.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANVAS = { width: 1448, height: 1086 };
const TILE_SIZE = 256;
const MAX_CROP_PX = 3000;

const SERVICES = {
  light: {
    label: "Esri World Light Gray Base",
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
    attribution: "Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS user community"
  },
  street: {
    label: "Esri World Street Map",
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`,
    attribution: "Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, (c) OpenStreetMap contributors, and the GIS User Community"
  }
};

const USAGE = `Usage: node scripts/build-basemap.mjs [options]

  --trip <file>          trip JSON to read (default: trip-data.json)
  --out <file>           output PNG (default: assets/maps/real/<tripId>.png)
  --service light|street tile style (default: light)
  --pad <ratio>          padding around the trip box (default: 0.08)
  --attribution <text>   override the provider copyright string
  --dry-run              print the plan without network, Playwright, or writes
  --json                 with --dry-run, print machine-readable JSON
  --force                overwrite an existing output file
`;

function parseArgs(argv) {
  const options = {
    trip: "trip-data.json",
    out: "",
    service: "light",
    pad: "0.08",
    attribution: "",
    dryRun: false,
    json: false,
    force: false
  };
  const flags = new Set(["dry-run", "json", "force"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}\n\n${USAGE}`);
    const name = argument.slice(2);
    if (flags.has(name)) {
      options[name === "dry-run" ? "dryRun" : name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    if (!(name in options)) throw new Error(`Unknown option: --${name}\n\n${USAGE}`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function validGeo(place) {
  const lat = Number(place?.geo?.lat);
  const lng = Number(place?.geo?.lng ?? place?.geo?.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function tripBounds(places, pad) {
  const points = places.map(validGeo).filter(Boolean);
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const point of points) {
    west = Math.min(west, point.lng);
    east = Math.max(east, point.lng);
    south = Math.min(south, point.lat);
    north = Math.max(north, point.lat);
  }
  if (east - west > 180) throw new Error("Trip places cross the antimeridian; split the trip into separate maps");

  const world = boundsToWorld([west, south, east, north]);
  const centerX = (world.west + world.east) / 2;
  const centerY = (world.north + world.south) / 2;
  const aspect = CANVAS.width / CANVAS.height;
  let width = Math.max(world.width, 1e-9) * (1 + pad * 2);
  let height = Math.max(world.height, 1e-9) * (1 + pad * 2);
  if (width / height > aspect) height = width / aspect;
  else width = height * aspect;

  const expanded = {
    west: centerX - width / 2,
    east: centerX + width / 2,
    north: centerY - height / 2,
    south: centerY + height / 2,
    width,
    height
  };
  if (expanded.west < 0 || expanded.east > 1 || expanded.north < 0 || expanded.south > 1) {
    throw new Error("Trip bounds fall outside the Web Mercator world; reduce --pad or narrow the trip area");
  }
  return expanded;
}

function chooseZoom(world) {
  for (let zoom = 18; zoom >= 5; zoom -= 1) {
    const cropWidth = world.width * TILE_SIZE * 2 ** zoom;
    if (cropWidth <= MAX_CROP_PX && cropWidth >= CANVAS.width) return zoom;
  }
  return 5;
}

function tileGrid(world, zoom, service) {
  const worldPx = TILE_SIZE * 2 ** zoom;
  const left = world.west * worldPx;
  const top = world.north * worldPx;
  const right = world.east * worldPx;
  const bottom = world.south * worldPx;
  const tiles = [];
  for (let x = Math.floor(left / TILE_SIZE); x <= Math.floor((right - 1) / TILE_SIZE); x += 1) {
    for (let y = Math.floor(top / TILE_SIZE); y <= Math.floor((bottom - 1) / TILE_SIZE); y += 1) {
      tiles.push({
        x,
        y,
        left: Number((x * TILE_SIZE - left).toFixed(2)),
        top: Number((y * TILE_SIZE - top).toFixed(2)),
        url: service.url(zoom, x, y)
      });
    }
  }
  return { tiles, crop: { width: right - left, height: bottom - top } };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function downloadTiles(tiles) {
  const queue = [...tiles];
  const missing = [];
  const worker = async () => {
    while (queue.length) {
      const tile = queue.shift();
      for (let attempt = 1; attempt <= 4 && !tile.src; attempt += 1) {
        try {
          const response = await fetch(tile.url, {
            headers: { "User-Agent": "Mozilla/5.0 TravelPlanBasemap/1.0" },
            signal: AbortSignal.timeout(20000)
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const type = response.headers.get("content-type") || "";
          const buffer = Buffer.from(await response.arrayBuffer());
          if (!type.startsWith("image/") || buffer.length < 500) throw new Error(`not an image (${type}, ${buffer.length}B)`);
          tile.src = `data:${type};base64,${buffer.toString("base64")}`;
        } catch (error) {
          if (attempt === 4) missing.push(`${tile.x}/${tile.y}: ${error.message}`);
          else await sleep(400 * attempt);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return missing;
}

function renderHtml(grid, scale, attribution) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#f3f6f2;overflow:hidden}
  .stage{position:relative;transform-origin:top left}
  .tile{position:absolute;width:${TILE_SIZE}px;height:${TILE_SIZE}px;display:block}
  .attribution{position:absolute;right:6px;bottom:4px;font:11px/1.4 Georgia,serif;color:#3b4250;background:rgba(255,255,255,.78);padding:1px 6px;border-radius:3px}
</style></head><body>
  <div class="stage" style="width:${grid.crop.width.toFixed(2)}px;height:${grid.crop.height.toFixed(2)}px;transform:scale(${scale})">
    ${grid.tiles.map((tile) => `<img class="tile" alt="" src="${tile.src}" style="left:${tile.left}px;top:${tile.top}px">`).join("")}
  </div>
  <div class="attribution">${attribution}</div>
</body></html>`;
}

function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function ensurePlaywright() {
  try {
    await execFileAsync("playwright", ["--version"], { timeout: 15000 });
  } catch {
    throw new Error("Playwright CLI not found. Install it with:\n  npm install -g playwright && playwright install chromium\nOr run with --dry-run to inspect the tile plan without rendering.");
  }
}

const cli = parseArgs(process.argv.slice(2));
const service = SERVICES[cli.service];
if (!service) throw new Error(`Unknown tile service: ${cli.service}. Use light or street.`);

const tripFile = path.resolve(ROOT, cli.trip);
const trip = JSON.parse(await fs.readFile(tripFile, "utf8"));
const map = trip.map || {};
const places = Array.isArray(map.places) ? map.places : [];
if ((map.regions || []).length > 1) {
  throw new Error("map.basemap supports a single destination region; split the trip into separate trip files");
}

const missingGeo = places.filter((place) => !validGeo(place)).map((place) => place.id || "(no id)");
if (missingGeo.length) {
  throw new Error(`Real basemap needs geo coordinates for every place. Missing: ${missingGeo.join(", ")}. A place without coordinates would be plotted at an arbitrary position.`);
}
if (places.length < 2) throw new Error("Real basemap needs at least two places with geo coordinates");

const world = tripBounds(places, Number(cli.pad));
const zoom = chooseZoom(world);
const grid = tileGrid(world, zoom, service);
const bounds = worldToBounds(world);
assertBasemapBounds(bounds);
const scale = CANVAS.width / grid.crop.width;

const tripId = trip.metadata?.tripId || "trip";
const outFile = path.resolve(ROOT, cli.out || `assets/maps/real/${tripId}.png`);
const sidecarFile = outFile.replace(/\.png$/i, ".json");
const relativeOut = path.relative(ROOT, outFile);
const attribution = cli.attribution || service.attribution;

const plan = {
  trip: path.relative(ROOT, tripFile),
  output: relativeOut,
  service: service.label,
  zoom,
  bounds,
  canvas: CANVAS,
  tiles: {
    count: grid.tiles.length,
    first: grid.tiles[0]?.url || "",
    last: grid.tiles.at(-1)?.url || ""
  },
  basemap: { file: relativeOut, bounds, attribution, provider: service.label, zoom }
};

if (cli.dryRun) {
  if (cli.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`Plan: ${service.label}, zoom ${zoom}, ${grid.tiles.length} tiles`);
    console.log(`Bounds: [${bounds.join(", ")}]`);
    console.log(`Output: ${relativeOut}`);
    console.log(`Sample tile: ${plan.tiles.first}`);
    console.log("\nmap.basemap snippet:\n" + JSON.stringify(plan.basemap, null, 2));
  }
  process.exit(0);
}

if (!cli.force) {
  const exists = await fs.access(outFile).then(() => true, () => false);
  if (exists) throw new Error(`${relativeOut} already exists. Pass --force to overwrite.`);
}

await ensurePlaywright();

console.log(`Basemap: ${service.label}, zoom ${zoom}, ${grid.tiles.length} tiles, ${grid.crop.width.toFixed(0)}x${grid.crop.height.toFixed(0)}px -> ${CANVAS.width}x${CANVAS.height}`);
const missingTiles = await downloadTiles(grid.tiles);
if (missingTiles.length) {
  if (missingTiles.length === grid.tiles.length) throw new Error("Every tile failed to download; check the network and the provider");
  console.warn(`WARN ${missingTiles.length} tile(s) unavailable, left as paper background:\n  ${missingTiles.join("\n  ")}`);
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "travel-basemap-"));
const htmlFile = path.join(tempDir, "basemap.html");
try {
  await fs.writeFile(htmlFile, renderHtml(grid, scale, attribution), "utf8");
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await execFileAsync("playwright", [
    "screenshot",
    `--viewport-size=${CANVAS.width},${CANVAS.height}`,
    "--wait-for-timeout=2500",
    `file://${htmlFile}`,
    outFile
  ], { maxBuffer: 8 * 1024 * 1024 });
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

const rendered = pngSize(await fs.readFile(outFile));
if (!rendered || rendered.width !== CANVAS.width || rendered.height !== CANVAS.height) {
  throw new Error(`Rendered PNG is not ${CANVAS.width}x${CANVAS.height} (got ${rendered ? `${rendered.width}x${rendered.height}` : "an unreadable file"})`);
}

const sidecar = {
  schemaVersion: "1.0.0",
  file: relativeOut,
  projection: "web-mercator",
  canvas: CANVAS,
  zoom,
  bounds,
  tiles: { provider: service.label, attribution, count: grid.tiles.length },
  generatedBy: "scripts/build-basemap.mjs"
};
await fs.writeFile(sidecarFile, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");

console.log(`Wrote ${relativeOut} and ${path.relative(ROOT, sidecarFile)}.`);
console.log("\nPaste into trip-data.json > map:\n" + JSON.stringify({ basemap: plan.basemap }, null, 2));
console.log("\nNext: npm run build:map && npm run validate && npm run preview");
