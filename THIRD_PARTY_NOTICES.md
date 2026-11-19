# Third-Party Notices

The MIT License in `LICENSE` covers only original project code and original project assets. The geographic data below remains governed by its own source license.

The bundled Boundary Library is retained only for advanced/legacy maintenance and reference workflows. The current ordinary map path uses the ten fixed templates in `assets/maps/templates/manifest.json`; neither that Builder nor the ordinary page reads or renders these Boundary files. Keeping the files in this repository still requires the source and license notices below.

## Country boundaries

- Source: [Natural Earth](https://www.naturalearthdata.com/) data distributed through [`datasets/geo-countries`](https://github.com/datasets/geo-countries).
- License: Natural Earth states that its map data is [public domain](https://www.naturalearthdata.com/about/terms-of-use/). The data package and its transformations are distributed under [Open Data Commons PDDL 1.0](https://opendatacommons.org/licenses/pddl/1-0/).
- Attribution: Natural Earth and `datasets/geo-countries`.
- Repository changes: The aggregate country dataset was reduced to the selected countries and serialized as one GeoJSON `FeatureCollection` per country.
- Provenance note: `scripts/sync-boundaries.mjs` currently references the mutable `main` branch. The exact revision represented by the checked-in snapshot was not recorded and must be confirmed or pinned by a maintainer before the data is refreshed or represented as a reproducible release.

## China provincial boundaries

- Source: the pinned [`geoBoundaries` `gbOpen` CHN ADM1 simplified release](https://github.com/wmgeolab/geoBoundaries/tree/9469f09/releaseData/gbOpen/CHN/ADM1). The corresponding [CHN ADM1 API metadata](https://www.geoboundaries.org/api/current/gbOpen/CHN/ADM1/) names geoBoundaries and Wikimedia Commons as sources.
- License: The layer metadata reports the individual upstream data as Public Domain. The [geoBoundaries project license](https://github.com/wmgeolab/geoBoundaries/blob/main/LICENSE) applies CC BY 4.0 to project code and derivative works while stating that individual Boundary files remain governed by their own metadata. geoBoundaries attribution is retained accordingly.
- Attribution: geoBoundaries at William & Mary, plus the upstream source identified by the release metadata.
- Repository changes: The simplified ADM1 collection was split into individual GeoJSON `FeatureCollection` files and given normalized local filenames; the geometry was not redrawn.
- Provenance note: The downloaded metadata exposes only the generic `commons.wikimedia.org/wiki/File` value for the upstream Wikimedia source. A maintainer must confirm the exact Wikimedia file URL before claiming more specific upstream provenance.

## Major-city boundaries

- Source: [OpenStreetMap](https://www.openstreetmap.org/copyright) data returned by the public [Nominatim service](https://operations.osmfoundation.org/policies/nominatim/).
- License: [Open Database License 1.0 (ODbL-1.0)](https://opendatacommons.org/licenses/odbl/1-0/).
- Attribution: © OpenStreetMap contributors.
- Repository changes: Results for a fixed list of cities were cached and serialized as one administrative-boundary GeoJSON `FeatureCollection` per city. Returned `osm_type` and `osm_id` values remain in each feature's properties.
- Provenance note: The exact retrieval date and OpenStreetMap database snapshot were not recorded. A maintainer must record them when these cached files are refreshed.

Source and license review is a maintainer task whenever Boundary Library files are added, refreshed, or prepared for a public release. Ordinary trip generation must not use or refresh this library.

## Esri ArcGIS basemap tiles (optional advanced workflow)

- Source: Esri ArcGIS REST services `Canvas/World_Light_Gray_Base` and `World_Street_Map`, fetched on demand only when a user runs `scripts/build-basemap.mjs` for the opt-in `map.basemap` mode.
- License: Governed by the applicable ArcGIS service terms. Not covered by this project's MIT license. This repository does not redistribute tiles or generated basemap images.
- Attribution: The service `copyrightText` is stored in each generated sidecar and rendered into the basemap image and the region disclaimer. Light: `Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS user community`. Street: `Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, (c) OpenStreetMap contributors, and the GIS User Community`.
- Repository changes: None. The test suite uses a synthetic solid-color PNG, not provider imagery.
- Provenance note: Each sidecar records provider, zoom, bounds, canvas, tile count, and attribution. The tile snapshot is not pinned; users must confirm that their intended use complies with the provider's terms.
