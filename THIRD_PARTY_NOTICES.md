# 第三方素材与许可 / Third-party notices

Orbit Lab 的原创源码与文档采用 MIT。下列贴图、数据和依赖遵循各自的授权与署名要求。

## 行星影像 / Planetary imagery

| 仓库文件 | 作品、来源与处理 | 许可信息 |
| --- | --- | --- |
| `web/m3/textures/earth-day.jpg` | NASA Earth Observatory，Blue Marble Next Generation 2004 年 7 月全球地表。由 5400 × 2700 缩放至 3072 × 1536。 [原图](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/) | [NASA Earth Science 影像复用说明](https://science.nasa.gov/earth/faq/) |
| `web/m3/textures/earth-night.jpg` | NASA Earth Observatory，Black Marble 2016 全球夜灯。由 3600 × 1800 缩放至 2048 × 1024。 [原图](https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/) | [NASA Earth Science 影像复用说明](https://science.nasa.gov/earth/faq/) |
| `web/m3/textures/earth-clouds.jpg` | Matt Eason 的 Daily Cloud Maps，2022 年 7 月 27 日 2048 × 1024 云图，使用 NASA EOSDIS 的 Global Imagery Browse Services（GIBS）影像。原图经文件重命名纳入。 [原图](https://github.com/matteason/daily-cloud-maps/releases/download/2022-07-27/2048x1024-clouds.jpg) | [上游署名说明](https://github.com/matteason/daily-cloud-maps#licence--attribution) · [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `web/m3/textures/mercury.jpg` | Mercury MESSENGER MDIS Enhanced Color Global Mosaic。影像来自 NASA、Johns Hopkins University Applied Physics Laboratory 和 Carnegie Institution of Washington。Orbit Lab 由 NASA Solar System Treks 的 32 张图块拼接为 2048 × 1024 贴图。 [USGS 数据记录](https://astrogeology.usgs.gov/search/map/mercury_messenger_mdis_basemap_enhanced_color_global_mosaic_665m) · [图块服务](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mercury) | [USGS 版权与署名说明](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits) · [NASA 影像使用指南](https://www.nasa.gov/nasa-brand-center/images-and-media/) |
| `web/m3/textures/venus.jpg`、`mars.jpg`、`jupiter.jpg`、`saturn.jpg`、`saturn-rings.png`、`uranus.jpg`、`neptune.jpg`、`moon.jpg` | Solar System Scope 的 Solar Textures 2K 版本，金星采用大气贴图。原文件经重命名纳入。Git 历史里替换前的水星贴图也来自此贴图包。 [原图与制作说明](https://www.solarsystemscope.com/textures/) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `web/m3/body-portraits.webp` | Orbit Lab 使用上述贴图和自有着色器渲染并合成为一张天体预览图。沿用对应素材的署名与许可。 [生成脚本](scripts/render-m3-catalog.mjs) | 其中 Solar System Scope 贴图及对应预览保留 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 署名。 |

## 星历与参照数据 / Ephemerides and reference data

- `tests/fixtures/solar-system-de440.csv` 是 Orbit Lab 从 NASA/JPL DE440s 内核提取的采样向量，已换算为 J2000 黄道坐标和 AU。网页的 `solar-system-start.csv` 使用其中首个历元。 [DE440 说明](https://ssd.jpl.nasa.gov/doc/de440_de441.html) · [NAIF 使用规则](https://naif.jpl.nasa.gov/naif/rules.html) · [采样脚本](scripts/regenerate-solar-system-reference.py)
- `tests/fixtures/flyby-ias15*.csv` 是 Orbit Lab 用 REBOUND 5.2.2 的 IAS15 对项目自定义初值生成的数字参照。 [REBOUND](https://github.com/hannorein/rebound) · [再生成脚本](scripts/regenerate-flyby-reference.py)

## 网页依赖 / Web dependencies

- Three.js 0.187.0，Copyright © 2010–2026 three.js authors，MIT。静态网页包中的 `THREE-LICENSE.txt` 随构建从同版本的 npm 包复制。 [Three.js 许可证](https://github.com/mrdoob/three.js/blob/r187/LICENSE)
- `web/m3/package-lock.json` 记录构建依赖，包括 TypeScript（Apache-2.0）、esbuild 和 `@types/three`（MIT）。各包的许可证随 npm 安装获得。 [TypeScript](https://github.com/microsoft/TypeScript) · [esbuild](https://github.com/evanw/esbuild) · [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped)
