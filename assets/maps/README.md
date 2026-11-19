# Fixed Map Templates

普通旅行生成只使用 `templates/manifest.json` 中登记的十张固定底图。Manifest 的运行时路径全部指向 WebP；底图负责纸张、地形、水体、山林和整体构图，路线、节点、地点标签、目的地标题及日期图例始终由固定 Renderer 叠加。

1. `inland-alpine`：均衡或东西向路线。
2. `island-archipelago`：分离地点簇或存在明显长距离跳转。
3. `coastal-region`：以南北方向为主的路线。
4. `urban-radial`：单城市、紧凑或高密度点位。
5. `river-highland`：均衡路线或分离地点簇。
6. `upland-basin`：紧凑或均衡路线。
7. `compact-basin`：紧凑或高密度点位。
8. `wide-valley`：东西向路线。
9. `radial-watershed`：南北向或放射型路线。
10. `broad-riverland`：大跨度或多站路线。

Builder 先根据地点经纬度、路线跨度、方向、密度和连通关系形成候选池，再使用由区域、地点与路线组成的旅行签名稳定哈希，从候选池中确定性选择一张。Manifest 中的 `selectionRole` 只是维护说明，Builder 不会直接解析这些字符串作为选择规则。Agent 不得自行选择视觉风格、生成新底图、重画国家轮廓或修改模板安全区域。

十张图片均作为本项目的固定静态模板资产；普通生成不得覆盖这些文件。

`aster-isles-base.png`、`mist-coast-base.png`、`generic-diagram-template.svg` 与 `generated-japan.svg` 仅作为旧实现参考保留，不再进入默认 Builder 链路。

可选的 `map.basemap` 模式会把用户生成的底图写到 `assets/maps/real/`，永远不覆盖 `templates/` 下的固定模板，也不进入 `manifest.json`。说明见 [`references/advanced/real-basemap.md`](../../references/advanced/real-basemap.md)。
