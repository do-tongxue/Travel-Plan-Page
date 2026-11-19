#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertBasemapBounds, layoutWebMercator } from "./web-mercator.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = "assets/maps/templates/manifest.json";
const GOLDEN = Object.freeze({
  width: 1448,
  height: 1086,
  routeColors: ["#397dc1", "#e77e22", "#618344", "#209aaa", "#8865a5", "#df6185"],
  maxOverviewPlaces: 10
});

function argsFrom(argv) {
  const supported = new Set(["trip", "config", "map", "out"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (!supported.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a file path`);
    values[name] = value;
    index += 1;
  }
  return values;
}

function absolute(value, fallback) {
  return path.resolve(ROOT, value || fallback);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJsonAtomically(file, value) {
  const temporaryFile = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporaryFile, file);
  } catch (error) {
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
    throw error;
  }
}

function finiteGeo(place) {
  const lat = Number(place?.geo?.lat);
  const lng = Number(place?.geo?.lng ?? place?.geo?.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function distanceKm(first, second) {
  const radians = (value) => value * Math.PI / 180;
  const lat1 = radians(first.lat);
  const lat2 = radians(second.lat);
  const deltaLat = lat2 - lat1;
  const deltaLng = radians(second.lng - first.lng);
  const value = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}

function maximumDistance(points) {
  let maximum = 0;
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) maximum = Math.max(maximum, distanceKm(points[first], points[second]));
  }
  return maximum;
}

function averageNearestDistance(points) {
  if (points.length < 2) return 0;
  return points.reduce((sum, point, index) => {
    const others = points.filter((_, candidate) => candidate !== index);
    return sum + Math.min(...others.map((candidate) => distanceKm(point, candidate)));
  }, 0) / points.length;
}

function routeComponents(mapData) {
  const ids = [...new Set((mapData.routes || []).flatMap((route) => route.placeIds || []))];
  if (!ids.length) return 0;
  const adjacency = new Map(ids.map((id) => [id, new Set()]));
  for (const route of mapData.routes || []) {
    const routeIds = (route.placeIds || []).filter((id) => adjacency.has(id));
    for (let index = 1; index < routeIds.length; index += 1) {
      adjacency.get(routeIds[index - 1]).add(routeIds[index]);
      adjacency.get(routeIds[index]).add(routeIds[index - 1]);
    }
  }
  const visited = new Set();
  let count = 0;
  for (const id of ids) {
    if (visited.has(id)) continue;
    count += 1;
    const queue = [id];
    visited.add(id);
    while (queue.length) {
      for (const next of adjacency.get(queue.shift()) || []) {
        if (!visited.has(next)) { visited.add(next); queue.push(next); }
      }
    }
  }
  return count;
}

function routeLegMetrics(mapData, placeById) {
  const distances = [];
  for (const route of mapData.routes || []) {
    for (let index = 1; index < (route.placeIds || []).length; index += 1) {
      const first = finiteGeo(placeById.get(route.placeIds[index - 1]));
      const second = finiteGeo(placeById.get(route.placeIds[index]));
      if (first && second) distances.push(distanceKm(first, second));
    }
  }
  if (!distances.length) return { largestLegKm: 0, jumpRatio: 0 };
  const sorted = [...distances].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1;
  const largest = sorted.at(-1);
  return { largestLegKm: largest, jumpRatio: largest / Math.max(1, median) };
}

function mapMetrics(mapData) {
  const points = (mapData.places || []).map(finiteGeo).filter(Boolean);
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  const averageLat = lats.length ? lats.reduce((sum, value) => sum + value, 0) / lats.length : 0;
  const widthKm = lngs.length ? (Math.max(...lngs) - Math.min(...lngs)) * 111 * Math.max(0.2, Math.cos(averageLat * Math.PI / 180)) : 0;
  const heightKm = lats.length ? (Math.max(...lats) - Math.min(...lats)) * 111 : 0;
  const placeById = new Map((mapData.places || []).map((place) => [place.id, place]));
  return {
    placeCount: mapData.places?.length || 0,
    geoPlaceCount: points.length,
    widthKm,
    heightKm,
    spanKm: maximumDistance(points),
    averageNearestKm: averageNearestDistance(points),
    components: routeComponents(mapData),
    ...routeLegMetrics(mapData, placeById)
  };
}

function deterministicTemplateId(mapData, ids) {
  const signature = JSON.stringify({
    region: mapData.region?.id || mapData.region?.label || "",
    places: (mapData.places || []).map((place) => place.id),
    routes: (mapData.routes || []).map((route) => ({ day: route.day, placeIds: route.placeIds || [] }))
  });
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ids[(hash >>> 0) % ids.length];
}

function templateSelection(mapData, manifest) {
  const templates = new Map(manifest.templates.map((template) => [template.id, template]));
  if (mapData.templateId && mapData.templateId !== "auto") {
    const selected = templates.get(mapData.templateId);
    if (!selected) throw new Error(`Unknown frozen map template: ${mapData.templateId}`);
    return { template: selected, reason: "explicit-diy-override", metrics: mapMetrics(mapData) };
  }
  const metrics = mapMetrics(mapData);
  const dense = metrics.placeCount >= 6 && metrics.averageNearestKm > 0 && metrics.averageNearestKm < 12;
  let candidates = ["inland-alpine", "river-highland", "upland-basin", "compact-basin", "broad-riverland"];
  let reason = "balanced-or-east-west-route";
  if (metrics.spanKm < 45 || dense) {
    candidates = ["urban-radial", "compact-basin", "upland-basin"];
    reason = dense ? "dense-place-cluster" : "compact-city-route";
  } else if (metrics.components > 1 || (metrics.largestLegKm > 160 && metrics.jumpRatio > 2.8)) {
    candidates = ["island-archipelago", "river-highland", "broad-riverland"];
    reason = "separated-clusters-or-long-jump";
  } else if (metrics.heightKm > metrics.widthKm * 1.1) {
    candidates = ["coastal-region", "radial-watershed", "compact-basin"];
    reason = "north-south-route";
  } else if (metrics.widthKm > metrics.heightKm * 1.3) {
    candidates = ["inland-alpine", "wide-valley", "broad-riverland"];
    reason = "east-west-route";
  }
  const available = candidates.filter((id) => templates.has(id));
  const id = available.length ? deterministicTemplateId(mapData, available) : manifest.defaultTemplate;
  return { template: templates.get(id) || templates.get(manifest.defaultTemplate), reason, metrics };
}

function routeOrder(places, routes) {
  const ids = [];
  const known = new Set(places.map((place) => place.id));
  for (const id of routes.flatMap((route) => route.placeIds || [])) if (known.has(id) && !ids.includes(id)) ids.push(id);
  for (const place of places) if (!ids.includes(place.id)) ids.push(place.id);
  return ids;
}

function fallbackLayout(places, routes, area) {
  const ids = routeOrder(places, routes);
  const columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(ids.length * 1.35))));
  const rows = Math.max(1, Math.ceil(ids.length / columns));
  const points = new Map();
  ids.forEach((id, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const rowSize = Math.min(columns, ids.length - row * columns);
    const logicalColumn = row % 2 ? rowSize - column - 1 : column;
    const x = rowSize === 1 ? area.x + area.width / 2 : area.x + area.width * logicalColumn / (rowSize - 1);
    const y = rows === 1 ? area.y + area.height / 2 : area.y + area.height * row / (rows - 1);
    points.set(id, { x, y, originalX: x, originalY: y });
  });
  return points;
}

function projectedLayout(places, routes, area) {
  const valid = places.map((place) => ({ place, geo: finiteGeo(place) })).filter((entry) => entry.geo);
  if (valid.length < 2) return fallbackLayout(places, routes, area);
  const meanLat = valid.reduce((sum, entry) => sum + entry.geo.lat, 0) / valid.length;
  const factor = Math.max(0.2, Math.cos(meanLat * Math.PI / 180));
  const raw = valid.map((entry) => ({ id: entry.place.id, x: entry.geo.lng * factor, y: -entry.geo.lat }));
  const xs = raw.map((point) => point.x);
  const ys = raw.map((point) => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX, rangeY = maxY - minY;
  const fill = places.length <= 4 ? 0.58 : places.length <= 10 ? 0.74 : 0.84;
  const scaleX = rangeX > 1e-9 ? area.width * fill / rangeX : Infinity;
  const scaleY = rangeY > 1e-9 ? area.height * fill / rangeY : Infinity;
  const scale = Math.min(scaleX, scaleY);
  if (!Number.isFinite(scale)) return fallbackLayout(places, routes, area);
  const centerX = area.x + area.width / 2, centerY = area.y + area.height / 2;
  const rawCenterX = (minX + maxX) / 2, rawCenterY = (minY + maxY) / 2;
  const points = new Map(raw.map((point) => {
    const x = centerX + (point.x - rawCenterX) * scale;
    const y = centerY + (point.y - rawCenterY) * scale;
    return [point.id, { x, y, originalX: x, originalY: y }];
  }));
  places.filter((place) => !points.has(place.id)).forEach((place, index) => {
    const angle = index * 2.3999632297;
    const radius = 42 + Math.floor(index / 6) * 46;
    const x = centerX + Math.cos(angle) * radius, y = centerY + Math.sin(angle) * radius;
    points.set(place.id, { x, y, originalX: x, originalY: y });
  });
  return points;
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function separatePoints(points, places, area) {
  const entries = places.map((place) => ({ id: place.id, ...points.get(place.id) }));
  const minimumGap = Math.max(58, Math.min(102, Math.sqrt(area.width * area.height / Math.max(1, entries.length)) * 0.44));
  for (let iteration = 0; iteration < 44; iteration += 1) {
    for (let first = 0; first < entries.length; first += 1) {
      for (let second = first + 1; second < entries.length; second += 1) {
        const a = entries[first], b = entries[second];
        let dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy);
        if (distance >= minimumGap) continue;
        if (distance < 0.001) {
          const angle = hashText(`${a.id}:${b.id}`) / 0xffffffff * Math.PI * 2;
          dx = Math.cos(angle); dy = Math.sin(angle); distance = 1;
        }
        const push = (minimumGap - distance) * 0.52;
        const ux = dx / distance, uy = dy / distance;
        a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push;
      }
    }
    for (const point of entries) {
      point.x += (point.originalX - point.x) * 0.055;
      point.y += (point.originalY - point.y) * 0.055;
      point.x = Math.max(area.x + 24, Math.min(area.x + area.width - 24, point.x));
      point.y = Math.max(area.y + 24, Math.min(area.y + area.height - 24, point.y));
    }
  }
  return new Map(entries.map((point) => [point.id, { x: Number(point.x.toFixed(2)), y: Number(point.y.toFixed(2)) }]));
}

function routePath(ids, placeById, seed = 0) {
  const points = ids.map((id) => placeById.get(id)).filter(Boolean);
  if (points.length < 2) return "";
  let result = `M${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1], current = points[index];
    const dx = current.x - previous.x, dy = current.y - previous.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const bend = ((seed + index) % 2 ? 1 : -1) * Math.min(30, distance * 0.1);
    const nx = -dy / distance, ny = dx / distance;
    const c1x = previous.x + dx * 0.34 + nx * bend, c1y = previous.y + dy * 0.34 + ny * bend;
    const c2x = previous.x + dx * 0.68 + nx * bend, c2y = previous.y + dy * 0.68 + ny * bend;
    result += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${current.x} ${current.y}`;
  }
  return result;
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function labelFor(place, index, occupied) {
  const choices = [[32, -32], [32, 50], [-32, -32], [-32, 50], [78, -62], [78, 76], [-78, -62], [-78, 76], [138, -88], [-138, -88], [138, 102], [-138, 102]];
  const automatic = choices.map((_, offset) => choices[(offset + index * 2) % choices.length]);
  const candidates = place.labelOffset ? [[place.labelOffset.x, place.labelOffset.y], ...automatic] : automatic;
  const width = Math.max(154, Math.min(330, Math.max(String(place.name || "").length, String(place.nameZh || "").length * 2) * 13));
  let best;
  for (const [dx, dy] of candidates) {
    const anchor = place.anchor || (dx < 0 ? "end" : "start");
    const x = place.x + dx, y = place.y + dy;
    const box = { x: anchor === "end" ? x - width : x, y: y - 26, width, height: 58 };
    const inCanvas = box.x >= 18 && box.x + box.width <= GOLDEN.width - 18 && box.y >= 18 && box.y + box.height <= GOLDEN.height - 18;
    const collisions = occupied.filter((item) => overlaps(item, box)).length;
    const score = collisions * 10000 + Math.hypot(dx, dy) + (inCanvas ? 0 : 100000);
    if (!best || score < best.score) best = { x, y, anchor, box, score };
    if (inCanvas && collisions === 0) { occupied.push(box); return { x, y, anchor }; }
  }
  occupied.push(best.box);
  return { x: best.x, y: best.y, anchor: best.anchor };
}

function midpoint(first, second) {
  return { x: Number(((first.x + second.x) / 2).toFixed(2)), y: Number(((first.y + second.y) / 2).toFixed(2)) };
}

function daysForPlace(place, routes) {
  const authored = Array.isArray(place.days) ? place.days : [];
  const derived = routes.filter((route) => route.placeIds?.includes(place.id)).map((route) => route.day);
  return [...new Set([...authored, ...derived])].sort((a, b) => a - b);
}

function overviewPlaces(places, routes) {
  if (places.length <= GOLDEN.maxOverviewPlaces) return places.map((place) => place.id);
  const score = new Map(places.map((place) => [place.id, place.overview ? 1000 : 0]));
  for (const route of routes) {
    const ids = route.placeIds || [];
    ids.forEach((id) => score.set(id, (score.get(id) || 0) + 1));
    if (ids[0]) score.set(ids[0], (score.get(ids[0]) || 0) + 24);
    if (ids.at(-1)) score.set(ids.at(-1), (score.get(ids.at(-1)) || 0) + 24);
    if (ids.length > 2) score.set(ids[Math.floor(ids.length / 2)], (score.get(ids[Math.floor(ids.length / 2)]) || 0) + 8);
  }
  const selected = new Set([...score.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, GOLDEN.maxOverviewPlaces).map(([id]) => id));
  return routeOrder(places, routes).filter((id) => selected.has(id));
}

function overviewRouteIds(ids, overviewSet) {
  if (ids.length <= 2) return ids;
  const result = [ids[0], ...ids.slice(1, -1).filter((id) => overviewSet.has(id)), ids.at(-1)];
  return result.filter((id, index) => index === 0 || id !== result[index - 1]);
}

function normalizeCountryCode(value) {
  return String(value || "").trim().toUpperCase();
}

function destinationRegions(mapData, tripData) {
  if (Array.isArray(mapData.regions) && mapData.regions.length) {
    return mapData.regions.map((region) => ({
      ...region,
      countryCodes: [...new Set([...(region.countryCodes || []), region.countryCode].map(normalizeCountryCode).filter(Boolean))]
    }));
  }
  const primaryCodes = [...new Set((tripData.trip?.primaryDestinationCountries || []).map((entry) =>
    normalizeCountryCode(typeof entry === "string" ? entry : entry?.code)
  ).filter(Boolean))];
  if (primaryCodes.length > 1) {
    return primaryCodes.map((code) => {
      const country = (tripData.trip?.countries || []).find((entry) => normalizeCountryCode(entry.code) === code) || {};
      const label = country.nameZh || country.name || code;
      return {
        id: code.toLowerCase(),
        label,
        countryCode: code,
        countryCodes: [code],
        heading: `${String(country.name || code).toUpperCase()} / ${label}`,
        description: `${label}行程示意图`
      };
    });
  }
  const region = mapData.region || { id: "trip-map", label: "本次旅程" };
  return [{
    ...region,
    countryCodes: [...new Set([...(region.countryCodes || []), region.countryCode, ...primaryCodes].map(normalizeCountryCode).filter(Boolean))]
  }];
}

function scopedRoute(route, includedIds) {
  const originalIds = route.placeIds || [];
  const runs = [];
  let current = null;
  originalIds.forEach((id, index) => {
    if (!includedIds.has(id)) {
      if (current) runs.push(current);
      current = null;
      return;
    }
    if (!current) current = { ids: [], start: index, end: index };
    current.ids.push(id);
    current.end = index;
  });
  if (current) runs.push(current);
  if (!runs.length) return null;
  runs.sort((first, second) => second.ids.length - first.ids.length || Number(second.end === originalIds.length - 1) - Number(first.end === originalIds.length - 1));
  const selected = runs[0];
  const isArrivalPoint = selected.end === originalIds.length - 1;
  if (selected.ids.length === 1 && originalIds.length > 1 && !isArrivalPoint) return null;
  return {
    ...route,
    placeIds: selected.ids,
    scheduleItems: Array.isArray(route.scheduleItems)
      ? route.scheduleItems.slice(selected.start, selected.end)
      : route.scheduleItems
  };
}

function mapDataForRegion(mapData, region, regionCount) {
  const acceptedCodes = new Set(region.countryCodes || []);
  const places = (mapData.places || []).filter((place) => {
    if (place.includeInMap === false) return false;
    if (place.mapRegionId) return place.mapRegionId === region.id;
    const code = normalizeCountryCode(place.countryCode);
    if (code && acceptedCodes.size) return acceptedCodes.has(code);
    return regionCount === 1;
  });
  const includedIds = new Set(places.map((place) => place.id));
  const routes = (mapData.routes || []).map((route) => scopedRoute(route, includedIds)).filter(Boolean);
  const dailyRoutes = (mapData.dailyRoutes || []).map((route) => scopedRoute(route, includedIds)).filter(Boolean);
  return { ...mapData, region, places, routes, dailyRoutes };
}

function buildRegion(mapData, manifest) {
  if (!mapData.places.length) return null;
  const basemap = mapData.basemap && typeof mapData.basemap === "object" ? mapData.basemap : null;
  let selection;
  let template;
  let points;
  if (basemap) {
    assertBasemapBounds(basemap.bounds);
    template = { id: "real-basemap", file: basemap.file, safeArea: { x: 0, y: 0, width: GOLDEN.width, height: GOLDEN.height } };
    selection = { template, reason: "real-basemap-explicit", metrics: mapMetrics(mapData) };
    points = layoutWebMercator(mapData.places, basemap.bounds, GOLDEN);
  } else {
    selection = templateSelection(mapData, manifest);
    template = selection.template;
    points = separatePoints(projectedLayout(mapData.places, mapData.routes, template.safeArea), mapData.places, template.safeArea);
  }
  const occupied = [{ x: 18, y: 38, width: 335, height: 360 }, ...mapData.places.map((place) => { const point = points.get(place.id); return { x: point.x - 17, y: point.y - 17, width: 34, height: 34 }; })];
  const renderedPlaces = mapData.places.map((place, index) => {
    const point = points.get(place.id);
    const days = daysForPlace(place, mapData.routes);
    const colored = { ...place, ...point, color: GOLDEN.routeColors[((days[0] || 1) - 1) % GOLDEN.routeColors.length] };
    const label = labelFor(colored, index, occupied);
    const primary = place.name || place.nameZh || place.id;
    const secondary = place.nameZh && place.nameZh !== primary ? place.nameZh : null;
    return { id: place.id, ...point, color: colored.color, tx: Number(label.x.toFixed(2)), ty: Number(label.y.toFixed(2)), size: 24, anchor: label.anchor, lines: secondary ? [`${primary} /`, secondary] : [primary], query: place.query || `${primary} ${mapData.region.label}`, geo: place.geo, days };
  });
  const placeById = new Map(renderedPlaces.map((place) => [place.id, place]));
  const overviewPlaceIds = overviewPlaces(mapData.places, mapData.routes);
  const overviewSet = new Set(overviewPlaceIds);
  const routes = mapData.routes.map((route) => {
    const ids = (route.placeIds || []).filter((id) => placeById.has(id));
    const detailed = routePath(ids, placeById, route.day);
    const overview = routePath(overviewRouteIds(ids, overviewSet), placeById, route.day);
    return { day: route.day, color: GOLDEN.routeColors[(route.day - 1) % GOLDEN.routeColors.length], placeIds: ids, paths: detailed ? [detailed] : [], overviewPaths: overview ? [overview] : [] };
  });
  const dailyDefinitions = mapData.dailyRoutes?.length ? mapData.dailyRoutes : mapData.routes;
  const dailyLayouts = Object.fromEntries(dailyDefinitions.map((daily) => {
    const ids = (daily.placeIds || []).filter((id) => placeById.has(id));
    const uniqueIds = [...new Set(ids)];
    const labels = Object.fromEntries(uniqueIds.map((id) => { const place = placeById.get(id); return [id, { x: place.tx, y: place.ty, anchor: place.anchor }]; }));
    const transport = ids.slice(0, -1).map((id, index) => ({ items: daily.scheduleItems?.[index] || [], ...midpoint(placeById.get(id), placeById.get(ids[index + 1])) }));
    return [String(daily.day), { places: uniqueIds, labels, transport }];
  }));
  const days = [...new Set([...mapData.routes, ...dailyDefinitions].map((route) => route.day))].sort((a, b) => a - b);
  const regionId = String(mapData.region.id || "trip-map").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return {
    id: regionId,
    label: mapData.region.label,
    countryCode: mapData.region.countryCode,
    scope: basemap ? "real-basemap" : "template-schematic",
    mapMode: basemap ? "real-basemap" : "frozen-template",
    templateId: template.id,
    mapModeReason: selection.reason,
    mapModeMetrics: Object.fromEntries(Object.entries(selection.metrics).map(([key, value]) => [key, typeof value === "number" ? Number(value.toFixed(2)) : value])),
    days,
    canvas: { width: GOLDEN.width, height: GOLDEN.height },
    projection: basemap ? { type: "web-mercator", bounds: basemap.bounds, padding: 0 } : { type: "relative-schematic", bounds: null },
    baseImage: template.file,
    title: mapData.region.title || mapData.title || `${mapData.region.label} · 旅行路线`,
    ariaLabel: `${mapData.region.label}${basemap ? "旅行路线图" : "模板化旅行路线示意图"}，共${days.length}天`,
    description: mapData.region.description,
    disclaimer: basemap ? `${basemap.attribution}；路线为行程示意，导航请以地图服务为准。` : mapData.disclaimer || manifest.disclaimer,
    heading: { text: mapData.region.heading || mapData.region.label, x: 33, y: 105, size: 40 },
    legend: { x: 35, y: 168, gap: 43 },
    annotations: [],
    routes,
    places: renderedPlaces,
    overviewPlaceIds,
    dailyLayouts
  };
}

const cli = argsFrom(process.argv.slice(2));
const tripPath = absolute(cli.trip, "trip-data.json");
const tripData = await readJson(tripPath);
const [config, mapData] = await Promise.all([
  cli.config ? readJson(absolute(cli.config)) : tripData.config,
  cli.map ? readJson(absolute(cli.map)) : tripData.map
]);
if (!config || typeof config !== "object") throw new Error("trip-data.json must contain config");
if (!mapData || typeof mapData !== "object") throw new Error("trip-data.json must contain map");
const outPath = cli.out ? absolute(cli.out) : tripPath;

if (config.modules?.overview === false) {
  const assets = { ...(tripData.metadata?.assets || {}) };
  delete assets.routeMaps;
  const output = {
    ...tripData,
    config,
    map: mapData,
    metadata: { ...tripData.metadata, assets }
  };
  delete output.routeMap;
  await writeJsonAtomically(outPath, output);
  console.log(`Skipped map build for ${path.relative(ROOT, outPath)} because the map module is disabled.`);
} else {
  const manifest = await readJson(absolute(MANIFEST_PATH));
  if (mapData.mapMode !== "template-auto") throw new Error("trip-data.json map.mapMode must be template-auto");
  if (!Array.isArray(mapData.places) || !mapData.places.length) throw new Error("trip-data.json map.places must contain places");
  if (!Array.isArray(mapData.routes) || !mapData.routes.length) throw new Error("trip-data.json map.routes must contain routes");

  const definitions = destinationRegions(mapData, tripData);
  if (mapData.basemap && definitions.length > 1) {
    throw new Error("map.basemap supports a single destination region; split the trip or use template-auto");
  }
  const regions = definitions.map((definition) => buildRegion(mapDataForRegion(mapData, definition, definitions.length), manifest)).filter(Boolean);
  if (!regions.length) throw new Error("No destination map regions contain usable places");
  for (const region of regions) {
    try {
      await fs.access(absolute(region.baseImage));
    } catch {
      throw new Error(`Map base image not found: ${region.baseImage}. Run npm run build:basemap or restore the file.`);
    }
  }
  const output = {
    ...tripData,
    config,
    map: mapData,
    metadata: { ...tripData.metadata, language: config.language || tripData.metadata?.language || "zh-CN", assets: { ...(tripData.metadata?.assets || {}), routeMaps: [...new Set(regions.map((region) => region.baseImage))] } },
    routeMap: { defaultRegionId: regions.some((region) => region.id === mapData.defaultRegionId) ? mapData.defaultRegionId : regions[0].id, regions }
  };
  await writeJsonAtomically(outPath, output);
  console.log(`Built ${path.relative(ROOT, outPath)} with ${regions.length} destination map region(s): ${regions.map((region) => `${region.label}=${region.templateId}`).join(", ")}.`);
}
