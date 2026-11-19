#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warnings = [];
const jsonMode = process.argv.includes("--json");
const tripArgumentIndex = process.argv.indexOf("--trip");
const tripFile = tripArgumentIndex >= 0 ? process.argv[tripArgumentIndex + 1] : "trip-data.json";
if (!tripFile) errors.push("--trip 必须后跟一个 JSON 文件路径");

function readJson(relative) {
  const file = path.isAbsolute(relative) ? relative : path.join(ROOT, relative);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${relative}: JSON 无法读取或格式不合法 (${error.message})`);
    return null;
  }
}

function exists(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

function pngSize(relative) {
  const file = path.join(ROOT, relative);
  if (!fs.existsSync(file)) return null;
  const buffer = fs.readFileSync(file);
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const MAX_MERCATOR_LAT = 85.05112878;

function validBasemapBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every((value) => Number.isFinite(value))) return false;
  const [west, south, east, north] = bounds;
  if (!(east > west) || !(north > south)) return false;
  if (west < -180 || east > 180) return false;
  if (south < -MAX_MERCATOR_LAT || north > MAX_MERCATOR_LAT) return false;
  return true;
}

function pending(value) {
  return /待补充|待确认|pending/i.test(JSON.stringify(value || ""));
}

function validUtcOffset(value) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (minutes > 59) return false;
  const totalMinutes = (hours * 60 + minutes) * (match[1] === "-" ? -1 : 1);
  return totalMinutes >= -12 * 60 && totalMinutes <= 14 * 60;
}

function rentalRenderable(rental) {
  return Boolean(
    rental && typeof rental === "object" &&
    typeof rental.company === "string" && rental.company.trim() &&
    rental.vehicle && typeof rental.vehicle === "object" &&
    rental.price && typeof rental.price === "object" &&
    rental.pickup && typeof rental.pickup.date === "string" && typeof rental.pickup.time === "string" &&
    rental.dropoff && typeof rental.dropoff.date === "string" && typeof rental.dropoff.time === "string"
  );
}

const trip = tripFile ? readJson(tripFile) : null;
const validTripObject = Boolean(trip && typeof trip === "object" && !Array.isArray(trip));
const uninitialized = validTripObject && trip.trip?.status === "uninitialized";
const config = validTripObject ? trip.config : null;
const map = validTripObject ? trip.map : null;

if (!validTripObject) errors.push("trip-data.json 根节点必须是 JSON object");

for (const file of ["index.html", "styles.css", "app.js", "overview-map.js", "route-ui.js", "ledger.js", "runtime-storage.js"]) {
  if (!exists(file)) errors.push(`缺少页面核心文件: ${file}`);
}

if (validTripObject) {
  if (trip.schemaVersion !== "2.0-lite") errors.push("trip-data.json schemaVersion 必须为 2.0-lite");
  if (!config || typeof config !== "object") errors.push("trip-data.json 缺少 config");
  if (!map || typeof map !== "object") errors.push("trip-data.json 缺少 map");
  if (uninitialized) {
    if (trip.trip.startDate !== null || trip.trip.endDate !== null || trip.trip.dayCount !== 0) errors.push("空白底板必须使用 null 日期和 dayCount 0");
    for (const name of ["flightJourneys", "flights", "accommodations", "days", "places", "restaurants", "bookingsAndTickets", "issuesAndUncertainties"]) {
      if (!Array.isArray(trip[name]) || trip[name].length) errors.push(`空白底板的 ${name} 必须是空数组`);
    }
    if (trip.routeMap || trip.metadata?.assets?.routeMaps?.length) errors.push("空白底板不得包含 Builder 派生地图");
    if (map && (!["places", "routes", "dailyRoutes"].every((name) => Array.isArray(map[name]) && map[name].length === 0))) errors.push("空白底板的 map 地点与路线必须为空数组");
    warnings.push("trip-data.json 尚未首次生成；当前为不含 Demo 行程的空白底板");
  } else {
    if (trip.metadata?.tripId === "unconfigured") errors.push("首次生成必须替换 metadata.tripId");
    if (!trip.metadata?.title || !trip.trip?.startDate || !trip.trip?.endDate) errors.push("trip-data.json 缺少标题、开始日期或结束日期");
    if (!Number.isInteger(trip.trip?.dayCount) || trip.trip.dayCount < 1) errors.push("trip.dayCount 必须是正整数");
    if (!Array.isArray(trip.days) || trip.days.length !== trip.trip?.dayCount) errors.push("days 数量必须与 trip.dayCount 一致");
    const dayNumbers = new Set();
    for (const day of trip.days || []) {
      if (!Number.isInteger(day.day) || dayNumbers.has(day.day) || !day.date || !Array.isArray(day.locations) || !Array.isArray(day.schedule)) errors.push(`Day ${day.day ?? "?"} 无效、重复或缺少 locations / schedule`);
      dayNumbers.add(day.day);
    }
  }
}

if (config && trip) {
  if (config.schemaVersion !== "1.0.0") errors.push("config.schemaVersion 必须为 1.0.0");
  const modules = config.modules || {};
  const moduleLabels = {
    flights: "航班",
    overview: "地图",
    itinerary: "每日行程",
    driving: "租车",
    todo: "To Do",
    ledger: "记账"
  };
  const checks = {
    flights: Array.isArray(trip.flightJourneys) && trip.flightJourneys.length ? trip.flightJourneys : null,
    overview: Boolean(map?.places?.length && map?.routes?.length),
    itinerary: trip.days,
    todo: trip.preTrip?.packingItems,
    driving: rentalRenderable(trip.groundTransport?.rentalCar) && Array.isArray(trip.groundTransport?.rentalChecklist) ? trip.groundTransport.rentalCar : null,
    ledger: exists("ledger.js")
  };

  for (const name of Object.keys(checks)) {
    if (typeof modules[name] !== "boolean") errors.push(`modules.${name}（${moduleLabels[name]}）必须存在且为 boolean`);
  }
  if (uninitialized && Object.keys(checks).some((name) => modules[name] !== false)) errors.push("空白底板的六个模块必须全部关闭");

  for (const [name, enabled] of Object.entries(modules)) {
    if (!Object.hasOwn(checks, name)) {
      errors.push(name === "tickets"
        ? "modules.tickets 不再是独立模块；门票资料属于每日行程，并跟随 modules.itinerary 显示"
        : `modules.${name} 不是支持的用户模块`);
      continue;
    }
    if (typeof enabled !== "boolean") errors.push(`modules.${name}（${moduleLabels[name]}）必须是 boolean`);
    if (enabled && !checks[name]) errors.push(`模块“${moduleLabels[name]}”已开启，但没有可用数据或核心文件`);
    if (enabled && pending(checks[name])) warnings.push(`模块“${moduleLabels[name]}”已开启，并包含明确的“待补充/待确认”状态`);
  }
  if (modules.flights && Array.isArray(trip.flightJourneys)) {
    for (const journey of trip.flightJourneys) {
      const journeyFlights = (trip.flights || []).filter((flight) => flight.journeyId === journey.id);
      const placeholder = journey.placeholder || ["missing", "pending"].includes(journey.status);
      if (!placeholder && !journeyFlights.length) errors.push(`航班 Journey ${journey.id || "?"} 没有航段，也未标记为待补充`);
      for (const flight of journeyFlights) {
        const airline = flight.airline?.nameZh || flight.airline?.name;
        const endpointReady = [flight.departure, flight.arrival].every((endpoint) => endpoint?.airportCode && endpoint?.date && endpoint?.time);
        if (!flight.id || !Number.isFinite(Number(flight.sequence)) || !airline || !flight.flightNumber || !endpointReady) errors.push(`航段 ${flight.id || "?"} 缺少页面必需字段`);
        if (!flight.placeholder) {
          for (const endpointName of ["departure", "arrival"]) {
            if (!validUtcOffset(flight[endpointName]?.utcOffset)) {
              errors.push(`航段 ${flight.id || "?"} ${endpointName}.utcOffset 必须使用有效的 ±HH:MM（-12:00 至 +14:00）`);
            }
          }
        }
      }
    }
  }
  if (modules.driving) {
    const rental = trip.groundTransport?.rentalCar;
    if (rental && typeof rental === "object") {
      for (const endpointName of ["pickup", "dropoff"]) {
        if (!validUtcOffset(rental[endpointName]?.utcOffset)) {
          errors.push(`租车 ${endpointName}.utcOffset 必须使用有效的 ±HH:MM（-12:00 至 +14:00）`);
        }
      }
    }
  }
  if (modules.overview && !trip.routeMap?.regions?.length) errors.push("地图模块已开启，但缺少 Builder 生成的 routeMap；请先运行 npm run build:map");
  if (config.persistence?.mode !== "local" && config.persistence?.mode !== "d1") errors.push("persistence.mode 只能是 local 或 d1");
  if (config.persistence?.mode === "d1") {
    const sharedCollections = config.persistence.sharedCollections;
    const allowedCollections = new Set(["todos", "tickets", "ledger"]);
    if (!Array.isArray(sharedCollections) || !sharedCollections.length || sharedCollections.some((name) => !allowedCollections.has(name))) {
      errors.push("D1 模式必须提供有效的 persistence.sharedCollections");
    }
    const apiBase = config.persistence.apiBase || "/api/trip";
    if (!/^\/(?!\/)/.test(apiBase) || apiBase.includes("\\") || /[?#]/.test(apiBase)) errors.push("D1 apiBase 必须是同源绝对路径");
  }
}

if (map) {
  if (map.schemaVersion !== "1.0-lite") errors.push("map.schemaVersion 必须为 1.0-lite");
  if (map.mapMode !== "template-auto") errors.push("map.mapMode 必须为 template-auto");
}

const basemap = map && typeof map.basemap === "object" && !Array.isArray(map.basemap) ? map.basemap : null;
if (map?.basemap !== undefined && !basemap) errors.push("map.basemap 必须是对象");
if (basemap) {
  if (uninitialized) errors.push("空白底板不得包含 map.basemap");
  if (config?.modules?.overview === false) warnings.push("map.basemap 已设置，但地图模块已关闭，底图不会被使用");
  if ((map.regions || []).length > 1) errors.push("map.basemap 目前只支持单一目的地；多目的地请拆分行程或使用 template-auto");

  const file = typeof basemap.file === "string" ? basemap.file.trim() : "";
  if (!file) {
    errors.push("map.basemap.file 必须是非空字符串");
  } else {
    const normalized = path.posix.normalize(file);
    if (/^[a-z][a-z0-9+.-]*:/i.test(file) || path.posix.isAbsolute(file) || normalized.startsWith("../") || normalized.includes("/../")) {
      errors.push(`map.basemap.file 必须是仓库内相对路径：${file}`);
    } else if (!normalized.startsWith("assets/maps/")) {
      errors.push(`map.basemap.file 必须位于 assets/maps/ 下：${file}`);
    } else if (!/\.png$/i.test(normalized)) {
      errors.push(`map.basemap.file 必须是 PNG：${file}`);
    } else if (!exists(normalized)) {
      errors.push(`map.basemap.file 不存在：${file}；请先运行 npm run build:basemap`);
    } else {
      const size = pngSize(normalized);
      if (!size || size.width !== 1448 || size.height !== 1086) {
        errors.push(`map.basemap.file 必须是 1448x1086 的 PNG：${file}${size ? ` (实际 ${size.width}x${size.height})` : ""}`);
      }
    }
  }

  if (!validBasemapBounds(basemap.bounds)) {
    errors.push("map.basemap.bounds 必须是 [west, south, east, north]，四个有限数值，east>west、north>south，且不超出 Web Mercator 范围");
  }
  if (typeof basemap.attribution !== "string" || !basemap.attribution.trim()) {
    errors.push("map.basemap.attribution 必须是非空的版权署名");
  }
  if (basemap.zoom !== undefined && (!Number.isInteger(basemap.zoom) || basemap.zoom < 0 || basemap.zoom > 22)) {
    errors.push("map.basemap.zoom 必须是 0-22 的整数");
  }

  if ((map.places || []).length >= 8) {
    warnings.push("真实底图模式不做点位疏散：地点较多时圆点可能重叠，标签仍会自动避让");
  }

  const regions = trip?.routeMap?.regions;
  if (Array.isArray(regions) && regions.length) {
    for (const region of regions) {
      const base = `routeMap region ${region.id || "?"}`;
      if (region.mapMode !== "real-basemap" || region.scope !== "real-basemap" || region.templateId !== "real-basemap") {
        errors.push(`${base} 与 map.basemap 不一致；请重新运行 npm run build:map`);
      }
      if (region.baseImage !== basemap.file) errors.push(`${base} 的 baseImage 与 map.basemap.file 不一致`);
      const projection = region.projection || {};
      if (projection.type !== "web-mercator") errors.push(`${base} 的 projection.type 必须是 web-mercator`);
      const expected = basemap.bounds;
      if (!Array.isArray(projection.bounds) || !expected || projection.bounds.length !== expected.length || projection.bounds.some((value, index) => Math.abs(value - expected[index]) > 1e-9)) {
        errors.push(`${base} 的 projection.bounds 与 map.basemap.bounds 不一致`);
      }
      if (typeof region.disclaimer === "string" && typeof basemap.attribution === "string" && !region.disclaimer.includes(basemap.attribution)) {
        warnings.push(`${base} 的免责声明未包含底图版权署名`);
      }
    }
  }
} else if (Array.isArray(trip?.routeMap?.regions) && trip.routeMap.regions.some((region) => region.scope === "real-basemap")) {
  errors.push("routeMap 仍是真实底图输出，但 map.basemap 已被移除；请重新运行 npm run build:map");
}

if (!uninitialized && config?.modules?.overview === true && map?.mapMode === "template-auto") {
  if (!basemap) {
    const manifestPath = "assets/maps/templates/manifest.json";
    const manifest = exists(manifestPath) ? readJson(manifestPath) : null;
    if (!manifest) errors.push(`缺少冻结地图模板清单：${manifestPath}`);
    for (const template of manifest?.templates || []) {
      if (!template.id || !template.file || !template.safeArea) errors.push("地图模板清单包含无效条目");
      if (template.file && !exists(template.file)) errors.push(`缺少冻结地图底图：${template.file}`);
    }
  }
  if (!Array.isArray(map.places) || !map.places.length) errors.push("trip-data.json map.places 必须包含地点");
  const placeIds = new Set();
  const regionDefinitions = map.regions?.length ? map.regions : [map.region];
  const destinationCodes = new Set(regionDefinitions.flatMap((region) => [...(region?.countryCodes || []), region?.countryCode]).filter(Boolean).map((code) => String(code).toUpperCase()));
  for (const place of map.places || []) {
    if (!place.id) errors.push("Map place 缺少 id");
    if (placeIds.has(place.id)) errors.push(`Map place id 重复：${place.id}`);
    placeIds.add(place.id);
    if (regionDefinitions.length > 1 && !place.countryCode && !place.mapRegionId) errors.push(`多目的地地图中的地点 ${place.id || "unknown"} 必须提供 countryCode 或 mapRegionId`);
    if (place.countryCode && destinationCodes.size && !destinationCodes.has(String(place.countryCode).toUpperCase())) warnings.push(`地点 ${place.id} 不属于目的地国家，将不会显示在地图中`);
    if (!Number.isFinite(Number(place.geo?.lat)) || !Number.isFinite(Number(place.geo?.lng))) warnings.push(`地点 ${place.id || "unknown"} 缺少有效经纬度，将使用确定性备用布局${basemap ? "；真实底图模式下该位置与真实地理不符" : ""}`);
  }
  for (const route of map.routes || []) {
    if (!Number.isInteger(route.day) || !Array.isArray(route.placeIds) || route.placeIds.length < 2) errors.push("每条 Map route 必须包含 day 和至少两个 placeIds");
    for (const placeId of route.placeIds || []) if (!placeIds.has(placeId)) errors.push(`Map route 引用了不存在的地点：${placeId}`);
  }
  for (const route of map.dailyRoutes || []) {
    if (!Number.isInteger(route.day) || !Array.isArray(route.placeIds) || route.placeIds.length < 2) errors.push("每条 Map dailyRoute 必须包含 day 和至少两个 placeIds");
    for (const placeId of route.placeIds || []) if (!placeIds.has(placeId)) errors.push(`Map dailyRoute 引用了不存在的地点：${placeId}`);
  }
}

if (map && map.mapMode !== "template-auto") {
  const boundary = map.region?.boundary;
  let resolvedBoundary = boundary;
  if (boundary && !exists(boundary)) {
    const boundaryIndex = readJson("assets/boundaries/boundary-index.json");
    const alias = boundaryIndex?.aliases?.[String(boundary).trim().toLocaleLowerCase("en-US")];
    if (alias) resolvedBoundary = `assets/boundaries/${alias}`;
  }
  if (!map.scope || !map.region?.id) errors.push("trip-data.json map 缺少 scope 或 region.id");
  if (!boundary) warnings.push("未提供 Boundary；Map Builder 将固定使用非国家级通用示意图");
  if (boundary && !exists(resolvedBoundary)) errors.push(`引用的 Boundary 不存在: ${boundary}`);
  if (boundary && exists(resolvedBoundary)) {
    const boundaryData = readJson(resolvedBoundary);
    if (boundaryData && !["Feature", "FeatureCollection", "Polygon", "MultiPolygon"].includes(boundaryData.type)) errors.push(`Boundary 类型无效: ${boundaryData.type}`);
  }
  const placeIds = new Set();
  for (const place of map.places || []) {
    if (!place.id || placeIds.has(place.id)) errors.push(`地图地点 ID 缺失或重复: ${place.id || "?"}`);
    placeIds.add(place.id);
    if (!Number.isFinite(place.geo?.lat) || !Number.isFinite(place.geo?.lng)) errors.push(`地图地点缺少有效坐标: ${place.id}`);
  }
  for (const route of [...(map.routes || []), ...(map.dailyRoutes || [])]) {
    if (!Number.isInteger(route.day) || !Array.isArray(route.placeIds) || route.placeIds.length < 2) errors.push(`地图路线 Day ${route.day ?? "?"} 无效`);
    for (const id of route.placeIds || []) if (!placeIds.has(id)) errors.push(`地图路线引用不存在的地点: ${id}`);
  }
}

function scanSecrets(value, trail = []) {
  if (Array.isArray(value)) return value.forEach((item, index) => scanSecrets(item, [...trail, index]));
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC )?PRIVATE KEY-----)/.test(value)) errors.push(`疑似 Secret: ${trail.join(".")}`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/^(api[-_]?key|access[-_]?token|secret|password|database[-_]?id|account[-_]?id)$/i.test(key) && String(child || "").trim()) errors.push(`不应提交敏感字段: ${[...trail, key].join(".")}`);
    scanSecrets(child, [...trail, key]);
  }
}
scanSecrets(trip);

const primaryCountryCodes = trip?.trip?.primaryDestinationCountries || [];
const domesticTrip = primaryCountryCodes.length > 0 && primaryCountryCodes.every((code) => code === "CN");
if (domesticTrip && !String(trip.trip.heroTitle || trip.trip.primaryDestinationName || trip.trip.primaryDestinationCity || trip.trip.citiesAndAreas?.[0] || "").trim()) {
  errors.push("国内旅行缺少 Hero 主要目的地名称");
}

const result = { ok: errors.length === 0, errors, warnings };
if (jsonMode) console.log(JSON.stringify(result, null, 2));
else {
  console.log(result.ok ? "validate-lite: PASS" : "validate-lite: FAIL");
  warnings.forEach((message) => console.log(`WARN  ${message}`));
  errors.forEach((message) => console.log(`ERROR ${message}`));
}
if (!result.ok) process.exitCode = 1;
