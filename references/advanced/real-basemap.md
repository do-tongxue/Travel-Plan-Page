# Real Basemap（可选高级 / DIY）

状态：高级 / DIY 可选能力；不属于普通单文件生成流程。  
范围：为一趟旅行生成一张真实地理底图，并按 Web Mercator 真投影落点。  
原则：默认链路一个字不改；不启用时构建产物与固定模板模式完全一致。

## 1. 与普通生成的关系

普通生成只使用 `assets/maps/templates/manifest.json` 中登记的十张固定底图，由 Builder 自动选择；Agent 不生成、不下载、不替换底图。这是 `SKILL.md` 的默认边界，**本能力不改变它**。

本能力是一条显式的逃逸路径，只在用户明确提出"想要真实地图"时使用：

- 输入仍是 `trip-data.json > map`，只增加一个 `map.basemap`；
- `map.mapMode` 仍固定为 `template-auto`；
- `build-map.mjs` 仍是唯一地图生成入口；
- 只有 `routeMap.regions[].mapMode` 变成 `real-basemap`，其余字段形状不变。

`validate-generation.mjs` 属于 canonical / legacy 管线，校验的是 `travel-data.json`，不适用于本能力；不要为了让它通过而伪造 boundary provenance。

## 2. 先决条件

- Node 18 以上；
- 全局 Playwright CLI 与 Chromium：`npm install -g playwright && playwright install chromium`；
- 生成底图时需要能访问瓦片服务；页面运行时不联网；
- 一趟旅行只支持一个目的地（`map.regions` 多于一个时报错）。

## 3. 用法

```bash
npm run build:basemap -- --trip trip-data.json --service street
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--service light` | 浅灰路网、无文字标签，贴合原页面米白质感（默认） |
| `--service street` | 彩色街道图，带地名标注 |
| `--out <path>` | 输出 PNG，默认 `assets/maps/real/<tripId>.png` |
| `--pad <ratio>` | 行程外扩比例，默认 `0.08` |
| `--attribution <text>` | 覆盖服务商版权字符串（换瓦片源时使用） |
| `--dry-run [--json]` | 只打印瓦片计划，不联网、不依赖 Playwright、不写文件 |
| `--force` | 允许覆盖已存在的输出 |

生成后会写出 PNG 与同名 `.json` 侧车文件（记录 bounds、zoom、服务商、瓦片数和版权署名），并把可粘贴的 `map.basemap` 片段打印出来。

```bash
npm run build:map && npm run validate && npm run preview
```

## 4. 数据形状

```json
"map": {
  "schemaVersion": "1.0-lite",
  "mapMode": "template-auto",
  "templateId": "auto",
  "basemap": {
    "file": "assets/maps/real/chengdu.png",
    "bounds": [103.5012024, 30.61622149, 104.1477948, 31.03266243],
    "attribution": "Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS user community",
    "provider": "Esri World Light Gray Base",
    "zoom": 12
  }
}
```

- `bounds`：`[west, south, east, north]`，WGS84 度；`east > west`、`north > south`；纬度不超过 ±85.05112878。
- `file`：仓库相对路径，必须在 `assets/maps/` 下，必须是 1448×1086 的 PNG。
- `attribution`：必填，非空。生成的免责声明会包含它。
- `provider`、`zoom`：可选，仅记录用途。

`routeMap` 由 Builder 生成，不要手写。

## 5. 与固定模板模式的差异

| | 固定模板 | 真实底图 |
|---|---|---|
| 底图 | 十张手绘模板，按旅行签名确定性选择 | 生成时拼接的真实地图瓦片 |
| 点位 | 相对方位 + 确定性疏散 | Web Mercator 真投影，不疏散 |
| 比例 | 示意图，不代表真实比例 | 真实比例 |
| 网络 | 不需要 | 仅在生成底图时需要 |
| 多目的地 | 每国独立区域 | 暂不支持 |

## 6. 已知限制

1. 不做点位疏散：同一城市点位较多时圆点可能重叠（标签仍会避让），`validate-lite` 会在 8 个地点以上给出警告。
2. 一个行程一张底图，不支持多目的地分区。
3. 高德、腾讯等 GCJ-02 瓦片源需要额外坐标纠偏；默认的 Esri 服务是 WGS-84，无需转换。
4. 缺少经纬度的地点会落到确定性备用位置，与真实地理不符；生成脚本会直接拒绝缺坐标的行程。
5. Renderer 的 geo 回退是等距近似；本模式所有地点都由 Builder 写入 `x`/`y`，不要依赖回退。

## 7. 版权

瓦片不随仓库分发，底图是用户本机生成的产物。底图版权归瓦片服务商所有，不在项目 MIT 许可范围内；生成图片右下角与页面免责声明都会渲染署名。公开发布前请自行确认所用服务的使用条款。详见 `THIRD_PARTY_NOTICES.md`。

## 8. 回退

删除 `trip-data.json > map.basemap`，重新运行 `npm run build:map`，即回到固定模板模式。`validate-lite` 会在检测到"已移除 basemap 但 routeMap 仍是真实底图输出"时报错，提示重新构建。
