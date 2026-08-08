# RWA Asset Identity & Data Rules

> 本文记录 RWA Dashboard 的资产准入、ticker 归一、类别/地区标签及上线校验规则。  
> 最近审计：2026-08-08。生产站点：<https://avenir-rwa-analyst.vercel.app/>

## 1. 核心原则

1. **Ticker 不是资产身份。** 同一个 ticker 可能同时指股票、商品代码和 crypto token。
2. **交易所官方产品元数据优先。** 聚合器、RWA CLI、静态 symbol 表和名称搜索只用于发现候选，不能单独证明资产身份。
3. **Fail closed。** 无法确认资产类型时不展示；不能用“不是 crypto”代替“已确认是 RWA”。
4. **先确认类别，再做 alias。** `CL/BZ/NG/PL/HG/GC/QNT` 等歧义代码不能全局替换。
5. **保留两层 symbol。** `venueSymbol` 用于请求交易所 API；canonical symbol 用于跨场所聚合和展示。
6. **资产类别和市场来源分开。** Equity/ETF/Commodity 是类别；ADR/HK/KR/TW/JP/CN 是独立 market tags。

## 2. 身份证据优先级

从高到低：

1. 交易所官方 catalog 中的 RWA/TradFi/asset-class 字段。
2. 官方 tokenized-asset catalog，例如 Bitget Reality、Kraken `tokenized_asset`。
3. 两个独立官方 catalog 对同一 wrapper underlying 的交叉确认。
4. 已审计、带日期的精确 exception 或 snapshot。
5. 名称、ticker 后缀、价格接近度等辅助信号。

第 5 层只能用于发现异常，不能独立放行资产。价格接近股票参考价也不能证明身份，因为同名 crypto 可能偶然价格接近；反过来，股票拆分、币种或计价单位不同也可能造成大幅偏差。

## 3. 各场所准入规则

### Perpetuals

| Venue | 必须满足 | 必须拒绝 |
|---|---|---|
| trade.xyz | `perpCategories` 明确属于 stock/equity/ETF/commodity/index/FX/pre-IPO | crypto、未知新类别；分类接口不可用时仅使用已审计 snapshot |
| Bitget | `isRwa=YES`、`status=online`，且类型属于 stock/metal/commodity | 普通 crypto；只有精确审计 exception 可以覆盖错误的官方类型 |
| Gate.io | `status=trading` 且 `contract_type` 属于 stocks/metals/commodities/indices/forex | `contract_type` 为空或其他类型的普通 crypto perpetual |
| Binance | `contractType=TRADIFI_PERPETUAL`；PAXG/XAUT 可使用普通 PERPETUAL | 普通 `PERPETUAL + COIN` 合约 |

### Spot

| Venue | 身份依据 |
|---|---|
| Bitget | Reality catalog 的 `isReality=YES`；legacy feed 只允许已审计贵金属/FX token |
| Kraken | `asset_class=tokenized_asset` 且 wrapper 为官方 xStocks；另允许已审计贵金属 token |
| Binance | `B` suffix 只是候选，underlying 还必须出现在官方 TradFi catalog；PAXG/XAUT 单独允许 |
| Gate.io | 不再仅凭 `X/ON` suffix 放行；必须是精确审计 wrapper，或 underlying 已被其他官方 tokenized catalog 交叉确认 |

## 4. 同名 crypto 的处理

### QNT / Quantinuum

- `QNTUSDT` 在 Bitget 是 `isRwa=NO + symbolType=crypto`，必须拒绝。
- `QNT_USDT` 在 Gate 没有 RWA `contract_type`，必须拒绝。
- `QNTUSDT` 在 Binance 是普通 `PERPETUAL + COIN`，必须拒绝。
- `xyz:QNT` 的官方类别是 stocks，代表 Quantinuum，可以接收。
- `QNTX`、`QNTSTOCK` 只有在官方类别已经确认是 security 后，才归一为 canonical `QNT`。
- Quantinuum 已上市，因此 canonical 类别为 Equity，不再是 Pre-IPO。

这条规则说明：**同一个裸 ticker 可以在一个场所是股票、在另一个场所是 crypto；准入必须绑定 venue metadata。**

### Spot wrapper

- `AAPLX`、`TSLAON`、`QNTB` 等 suffix 不能单独证明身份。
- 先验证 issuer/catalog，再解析 underlying。
- 普通股票 ticker（如 `CAT`、`PEP`、`AI`、`GME`）不能直接作为 spot RWA；现货股票通常应有 issuer wrapper 或官方 Reality/bStock 身份。
- `CORN/BRN/OIL/WHEAT` 等普通 crypto ticker 不能按商品名称误收。

## 5. Canonicalization 规则

1. Alias 必须按类别应用：
   - Commodity：`CL -> WTI`、`BZ -> BRENTOIL`、`GC -> XAU`。
   - Index：`SP500 -> SPX`、`NAS100 -> NDX`。
   - Security：`QNTX/QNTSTOCK -> QNT`。
2. `CL` 也可能是 Colgate-Palmolive，`PL` 也可能是 Planet Labs，因此不能使用全局 alias。
3. Wrapper 可以保留 venue ticker 展示，但跨场所匹配必须使用 underlying。
4. 同一 canonical asset 在多个 venue 出现时，类别必须一致；出现冲突应阻止发布并人工核对。

## 6. 类别与上市状态

类别优先级：

1. 已审计的 ETF wrapper override。
2. `SECURITY_LISTING_REGISTRY` 中的公司上市生命周期。
3. 交易所官方细分类别的精确映射。
4. 静态 ETF 集合。
5. 名称推断，仅作为最后 fallback。

当前重要 override：

- `SPCX/SPACEX/SPCXB/SPCXON/SPCXX`：统一为已上市的 SpaceX Equity。
- `CBRS/CBRSB/CBRSON/CBRSX/sCBRS`：统一为已上市的 Cerebras Equity。
- `QNT/QNTX/QNTSTOCK/QNTB`：统一为已上市的 Quantinuum Equity，但只有场所先确认 security 后才应用 alias。
- `MINIMAX/ZHIPU/CXMT`：已上市 Equity。
- `OPENAI/ANTHROPIC/ANDURIL/KALSHI/KIMI/NEURALINK/POLYMARKET`：Pre-IPO；后五项由 Gate 官方 `stocks + is_pre_market=true` catalog 交叉审计纳入。
- `UNITREE`：已获 IPO 注册、尚未找到开始交易公告，因此仍为 Pre-IPO。
- `EWH/DFEN/QQQX/SPYX/TQQQX/SLVON`：ETF。
- `H100`：计算资源类 Commodity，不是股票指数。
- 已公开上市的公司不能因为场所残留 `is_pre_market` 就继续显示为 Pre-IPO。

“已上市”以交易所开始公开交易为准；递表、审核通过或发行注册都不等于已经上市。Pre-IPO 集合应保持小而明确，并定期核对上市事件。

上市状态只能在 `SECURITY_LISTING_REGISTRY` 更新一次，由它统一派生 canonical category、名称和 aliases。场所 snapshot 的 `PRE-IPO` 分组只是当时的产品目录，不拥有最终分类权；即使 fallback 分组过期，也必须经过 registry 再分类。

官方类型只允许精确归一化映射，例如 `PRE-IPO/PRE_IPO/PREIPO -> PREIPO`、`PRE-MARKET -> PREMARKET`。禁止用 `includes('PRE')` 判断，否则 `PREFERRED_STOCK` 等无关类型也可能被误判为 Pre-IPO。布尔字段也必须显式解析，字符串 `"false"` 不能按 JavaScript truthy 值处理。

Registry 只纠正“已经由场所确认是 security”的产品；显式 `crypto/coin/token/meme` 类型永远先返回 Other/拒绝，不能因为 ticker 命中 `QNT` 等已上市公司 alias 而被 registry 反向放行。

Gate 当前另有 `BP + is_pre_market=true`，但其 `contract_type` 为空，未通过 RWA 身份门控，所以不能仅凭 premarket flag 纳入 registry 或页面。

## 7. Market tags

- Market tag 与资产类别无关，并允许多标签。
- `ADR` 表示美国上市的 depositary receipt/share。
- `HK/KR/TW/JP/CN` 表示 underlying、主要市场或明确的市场 exposure。
- 双重上市可以同时展示两个标签，例如 GigaDevice 为 `HK + CN`。
- ADR 也可以保留来源地，例如 `TSM = ADR + TW`、`BABA = ADR + CN`、`SKHY = ADR + KR`。
- ETF 的地区标签表示 exposure，不代表 ETF 自身在该地区上市，例如 `EWT = TW`、`EWY = KR`。

## 8. 数据完整度状态

页面字段统一使用：

- **Full**：官方接口直接返回，覆盖完整。
- **Partial**：只抓取部分资产、部分深度层级或有限历史区间。
- **Estimated**：通过明确公式、fallback 或投影得到。
- **Unavailable**：接口不支持、未返回或本轮未成功抓取。

身份确认与字段完整度是两件事。资产可以是已确认 RWA，但 OI/Depth 等字段仍为 Partial 或 Unavailable。

## 9. 上线前审计清单

每次更新资产规则至少完成以下检查：

1. 拉取四家 perp 官方 catalog，统计准入数量和官方类型分布。
2. 明确断言普通 QNT crypto 等已知冲突不会进入结果。
3. 检查所有 canonical ticker 是否存在跨 venue 类别冲突。
4. 检查 Equity 名称中是否出现 ETF/Fund/Trust/Index 等明显错标。
5. 检查 `SECURITY_LISTING_REGISTRY`：public 必须有开始交易日期；Pre-IPO 不得有开始交易日期；alias 不得跨公司冲突。
6. 检查 spot 是否存在裸股票 ticker、普通 crypto ticker 或未经确认的 suffix wrapper。
7. 对现货价格与股票参考价做异常比率扫描；异常只触发复核，不自动决定身份。
8. Preview 中核对 venue counts、目标资产标签、Top 30 和 Cross-Venue Coverage。
9. 推送 Git 后再 promote 到生产，最后复查生产 DOM、Vercel `Ready` 和 5xx 日志。

## 10. 已知精确例外

### Bitget KUAISHOU

Bitget 当前同时返回 `isRwa=YES` 和 `symbolType=crypto`，但该产品对应 Kuaishou Technology（港股）。代码只对 `KUAISHOU` 设置精确 Equity/HK 例外；不能把该例外扩大为“所有 `isRwa=YES` 的 crypto 类型都允许”。

### 聚合器/RWA CLI

聚合器可能把同名 ticker 合并错。例如 RWA CLI 的 `resolve qnt` 曾把 Bitget `QNTUSDT` 解析为 Equity，而 Bitget 官方 catalog 明确说明它是 crypto 且 `isRwa=NO`。因此 CLI 只负责 discovery/候选解析，最终身份必须回到场所官方 catalog。

## 11. 2026-08-08 基线

该数字只用于发现突然缺失或暴增，不应被当成永久硬编码：

| Market | Venue | Listings |
|---|---|---:|
| Perpetuals | trade.xyz | 108 |
| Perpetuals | Bitget | 273 |
| Perpetuals | Gate.io | 360 |
| Perpetuals | Binance | 155 |
| Spot | Gate.io | 60 |
| Spot | Binance | 68 |
| Spot | Bitget | 627 |
| Spot | Kraken | 167 |

合约合计 896 listings、471 个 canonical assets；现货合计 922 listings。

## 12. 维护约定

- 新规则优先写成 venue-specific identity gate，不要继续扩大全局 symbol 白名单。
- 所有人工 exception 必须精确到 symbol、说明原因并记录审计日期。
- Snapshot 只用于接口故障时维持可用性，正常情况下始终优先 live catalog。
- 上市状态只修改 `SECURITY_LISTING_REGISTRY`；venue allowlist/snapshot 只描述产品覆盖，不能重复拥有 public-vs-pre-IPO 结论。
- 修改本文件时，应同步检查 `index.html` 中对应的 allowlist、market tags 和 spot wrapper 规则。
- Git 历史保留旧规则，生产发布必须从已验证的 Preview promote，避免本地与线上规则漂移。

## 13. 传统市场成交量与期权异动

`Traditional Market Activity Monitor` 必须以传统市场为主表。传统 universe、候选池和排名全部完成后，才把已通过本文身份规则的 Perp/Spot 作为 left join 覆盖层；Crypto 是否上币、交易量大小或异常信号都不能改变传统排名。

- 首版身份 universe 使用 Nasdaq Trader 官方 `nasdaqlisted.txt` 与 `otherlisted.txt`。排除 Test Issue、warrant、right、unit、preferred、债券/票据等非普通 Equity/ETF；ADR/ADS 由官方证券名称打 tag。不得设置任意股价下限改变官方榜单。
- Top 100 候选池是 `当前 Nasdaq Most Active by Dollar Volume 快照 ∪ OCC 排名日标准期权合约量 Top 100 ∪ 前一完成交易日 OCC 标准期权合约量 Top 100`。候选标的必须存在于 Nasdaq Trader 官方目录；实时价差层再用 Nasdaq Quote Info 的 `companyName` 与 `assetClass` 二次确认后才接入价格。页面必须同时披露候选榜 as-of 与实际排名 session。公开源无法回溯指定日期的完整 Nasdaq leader snapshot 时，只能称“官方候选集内 Top 100”，不得宣称完整美股全市场 Top 100。
- 默认排名是 `Estimated Share Value + Estimated Standard-Options Underlying Notional`。该排名不使用 Perp/Spot 成交量，也不按 Crypto coverage 或异动 signal 重排。
- 日排名变化比较最近两个 Nasdaq/OCC 对齐的已完成交易 session，不是自然日、滚动 24 小时或浏览器本地快照。当前和前日使用同一估算公式与上述联合候选集分别完整排序，`delta = 前一 session rank - 当前 rank`；正数为上升、负数为下降、零为不变。
- `NEW` 只表示该标的当前进入联合候选集 Top 100、但前一 session 不在 Top 100（前次 rank 缺失或大于 100）；不表示新上市、IPO 或首次被交易所支持。前一 session 的 OCC 报告、Nasdaq 历史结构或候选比较覆盖不完整时，整榜变化统一标 Unavailable，严禁把未知误标成 `NEW`。
- 页面默认显示前 50 行，More 仅把同一服务端 Top 100 展开到 100；搜索和筛选可作用于完整 Top 100，但不得重新编号或重算排名。
- 首版覆盖美国上市的 Equity、ETF 与 ADR；纯 HK/KR/TW/JP/CN 本地上市、Pre-IPO、现货商品、商品期货和指数不拿同名美股代替，官方源不支持时显示 Unavailable。
- 股票/ETF 成交股数和收盘价来自 Nasdaq Market Activity 官方历史接口，并强制与 OCC 最近完成交易日对齐；Nasdaq 展示的 Average Volume 只用于基线。没有同一 session 的历史行时，该标的不得把跨日金额相加排名。
- OCC 主报告不可用、ranking session 无效、或任一 eligible 官方候选因请求/结构错误缺少 Nasdaq 同日历史时必须 fail closed；不得把当前 Nasdaq 数据降级成同日完整排名，也不得缓存 `200 + 空榜`。Nasdaq 返回业务成功且明确没有该 session 行的标的（例如排名日后才上市或当日无交易）标为 session-ineligible 并从排名分母排除；不得把任意接口失败伪装成 ineligible。响应需披露 aligned / ineligible / dropped candidates；宁可由 CDN 保留上一份正确榜单，也不能让缺失的头部标的扭曲排序。
- 期权成交合约数来自 OCC 官方 batch-processing report。当前值使用最近完成交易日（通常 T+1）；基线使用此前四周同一星期几的四个日度报告取平均。OCC 的 weekly download 当前只返回日期区间、没有逐标数据行，因此不能假装成 20 日均量。
- 股票美元值是 `Nasdaq same-session shares × same-session close`，只能标 Estimated，不是 consolidated/VWAP turnover。
- 期权美元值是 `OCC standard contracts × 100 × Nasdaq displayed underlying price`，代表 underlying notional，不是 option premium。`2AAPL`、`4SPY` 等 adjusted roots 的交割乘数未知，必须从标准 ×100 公式中排除并单独披露。
- `Est. Total Notional = Estimated Share Value + Estimated Options Underlying Notional`。Perp/Spot 24h USD volume 只做并列覆盖展示，不得加进这个传统总值。
- Cboe delayed quote table 明确禁止自动抓取，因此生产代码不得调用其网页/JSON 端点。需要真正实时期权时，应采购 OPRA 授权数据或合规的数据供应商。
- `Trad RelVol = Nasdaq aligned completed-session Share Volume / 此前最多 20 个完成交易日的 Nasdaq 官方历史 Share Volume 均值`。历史请求与两日排名共用同一条官方接口；20 个样本齐全为 Full，样本不足为 Partial。
- `Options RelVol = OCC latest completed-day contracts / prior four same-weekday observations average`。
- High：`Trad RelVol >= 2.0` 或 `Options RelVol >= 2.5`；Watch：`Trad RelVol >= 1.5` 或 `Options RelVol >= 1.75`。阈值只是监控提示，不构成交易建议。
- Perp/Spot 只按精确 canonical underlying + Equity/ETF category 联结。Spot wrapper 还必须有官方 catalog 提供的 `underlyingSymbol`、静态可信 issuer wrapper，或与当前 venue 匹配的注册记录；禁止仅凭 token ticker 像股票 ticker 就联结。
- Perp/Spot 场所短时失败时，last-good snapshot 仍保留 listing coverage 与已知 24h volume，并把该字段标 Partial / `Stale cache`；stale 价格不得进入 Max Spread。volume 缺失必须保留 null 并标 Unavailable/Partial，禁止补成真实 `$0`。
- `Indicative Max Spread = (最高可比价格 - 最低可比价格) / 最低可比价格`。价格集合只包含 60 秒缓存 Nasdaq USD/share quote、live Perp mark 与 live Spot bid/ask midpoint（无有效盘口时用 last）；至少两个有效点才显示，并精确标出 Spot token ticker。超出 Nasdaq 价格 0.5×–1.5× 的点进入 quarantine，不参与 spread。该字段自身标 Estimated；它不含手续费、滑点或延迟，不得描述成可执行套利。
- 真正实时版本需要 Nasdaq Basic/NLS（或 SIP 授权）和 OPRA 授权。未配置授权数据前，页面必须明确标注公开源的延迟，不得显示 `Real-time`。

字段状态：Nasdaq 与 OCC 都有完整原始字段和基线、且当前日和四周基线都没有被排除的 adjusted options 时为 Full；只有一侧、历史不足或任一相关报告存在 adjusted roots 时为 Partial；金额公式本身必须明确标 Estimated；官方源没有匹配时为 Unavailable。

2026-08-08 抽查发现 `MUU` 的 Nasdaq 官方身份是 `Direxion Daily MU Bull 2X ETF`，因此全局类别修正为 ETF；这类纠错必须回写主分类规则，不能只在传统成交量板块临时隐藏。

## 14. Reference Price、历史覆盖与容错

Reference Price 必须经过服务端归一化，前端不得直接并发抓取每个 Yahoo chart，也不得通过 URL query 传第三方 API key。

- 第一层使用 Yahoo Finance 对应的传统 ticker，并保留 `asOf`、交易时段、交易所、原始币种和延迟秒数。
- KRW、JPY、HKD、TWD、CNY、CAD、EUR、GBP/GBp 等非美元报价先用同源 FX ticker 转为 USD；换汇后的值标为 Estimated，不能标为 Full。
- Yahoo 不可用时，可使用已通过 RWA 身份门控的跨场所 Perp Index median；至少两个现货场所一致时也可使用 Spot Median。两者都是 Estimated。
- 没有正数参考价时显示 Unavailable；禁止把缺失价格写成 `0`。
- 参考价请求必须覆盖所有 spot/perp 可联动 underlying，通过服务端分块和缓存控流，不能再使用任意 Top N 截断。

Funding History 必须按用户选择的真实时间窗裁剪，接口为了满足最小返回条数而多取的数据不能混入 24h/3d/7d/30d 图表。

- 时间戳统一成毫秒、升序并按 timestamp 去重；真实的 `0` funding 必须保留。
- `expected = floor(windowHours / fundingIntervalHours)`；观测数达到 expected 的 80% 为 Full，至少 2 条为 Partial，否则 Unavailable。
- Sparkline、有效费率和 modal chart 必须使用同一份裁剪后的 rows 与 coverage，避免图、分母和状态各算一套。
- Funding 历史统一通过服务端批量接口获取，带超时、有限重试、并发上限和 CDN stale-while-revalidate 缓存。

Perp 与 Spot 的每个 venue 都保存 last-good snapshot。刷新失败时允许继续展示该 snapshot，但必须显式标为 `Stale cache` 并保留上次成功时间；没有任何成功快照时标为 Unavailable。上游字段缺失必须保持 `null`，禁止用 `parseFloat(value) || 0` 把缺失伪装成有效零值。

架构约定：超时、重试、并发与缓存策略集中在 `api/_lib/upstream.js`；传统 ticker 与 FX 映射集中在 `api/_lib/reference-map.js`；新服务端数据源优先复用这两个模块，并为 normalization 增加 Node contract test。

### Gate 批量请求与缓存预算

批量接口只是传输/缓存层，不拥有资产准入权：

- `type=perp-snapshot` 与 `type=spot-snapshot` 分别合并并裁剪 Gate 合约/行情和现货 pair/行情；它们只允许固定官方 host/path 和固定 `type` 查询。Spot 官方 pair catalog 是身份权威，缺失时即 fail closed，禁止从 ticker 伪造 catalog。生产环境不再公开任意路径的 `/api/gate/:path*` 或 `/api/gate-spot/:path*` rewrite。
- `type=spot-depth` 只能接收已经通过 Gate 现货身份门控的 pair；返回深度不能反向证明一个 ticker 是 RWA。单次最多 80 个 pair，列表必须大写、去重并按字典序排列；CDN 新鲜期 30 秒，stale-while-revalidate 120 秒。
- `type=growth` 不接受客户端 symbol 列表。服务端在每个新缓存窗口重新读取 Gate 官方 futures catalog，仅保留 `status=trading` 且 `contract_type` 属于 stocks/metals/commodities/indices/forex 的产品。过滤后为空或超过 500 必须 fail closed；CDN 新鲜期 15 分钟，stale-while-revalidate 60 分钟。
- 生产前端不得再按 Gate symbol 调用 Vercel rewrite。同一数据窗口必须共享稳定 cache key；symbol 列表排序，kline `from/to` 对齐固定时间桶。
- 单个上游失败保留 `null` 并降级为 Partial；客户端按 venue、按 symbol 合并成功值，失败 symbol 继续显示 last-good，不能把缺失填成 `0`，也不能由其他 venue 的成功延后本 venue 的重试。全部上游失败必须返回错误且 `no-store`，禁止 CDN 缓存空结果。

页面可见性只影响请求调度，不影响数据语义：页面 hidden 时暂停轮询，恢复可见后只更新已过期数据。Traditional 排名只在用户进入该页时按需加载，客户端保留 1 小时，服务端 CDN 新鲜期 1 小时、stale-while-revalidate 24 小时；Traditional quote 仅在该页激活时请求，美股常规时段客户端保留 60 秒，休市时保留 15 分钟。

## 15. 主要核验来源

- Hyperliquid/trade.xyz market identity：`https://api.hyperliquid.xyz/info` 的 `perpCategories` 与 `metaAndAssetCtxs`。
- Bitget perpetual/Reality catalogs：`/api/v3/market/instruments`。
- Gate futures/spot catalogs：`/api/v4/futures/usdt/contracts` 与 `/api/v4/spot/currency_pairs`。
- Binance futures/spot catalogs：`/fapi/v1/exchangeInfo` 与 `/api/v3/exchangeInfo`。
- Nasdaq Market Activity（股票/ETF Share Volume、Average Volume）：<https://www.nasdaq.com/market-activity>。
- OCC Volume Query / batch processing（期权成交量）：<https://www.theocc.com/market-data/market-data-reports/volume-and-open-interest/volume-query>。
- Quantinuum 上市状态：[Quantinuum Announces Closing of Upsized Initial Public Offering](https://ir.quantinuum.com/news-releases/news-release-details/quantinuum-announces-closing-upsized-initial-public-offering)。
- SpaceX 上市状态：[SEC free-writing prospectus（SPCX，2026-06-12 开始交易）](https://www.sec.gov/Archives/edgar/data/1181412/000162828026042466/spaceexplorationtechnologi.htm)。
- Cerebras 上市状态：[SEC Form 10-Q（CBRS，2026-05-14 开始交易）](https://www.sec.gov/Archives/edgar/data/2021728/000162828026044981/cbrs-20260331.htm)。
- MiniMax 上市状态：[HKEX allotment results（0100，2026-01-09 开始交易）](https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0108/2026010801342.pdf)。
- Z.AI / Zhipu 上市身份：[HKEX issuer announcement（2513）](https://www.hkexnews.hk/listedco/listconews/sehk/2026/0112/2026011201131.pdf)。
- 长鑫科技上市状态：[上交所上市交易公告（688825，2026-07-27）](https://www.sse.com.cn/disclosure/announcement/listing/ipo/c/c_20260724_10826610.shtml)。
- Unitree 当前阶段：[证监会 IPO 注册批复（2026-07-01）](https://www.csrc.gov.cn/csrc/c105906/c7642867/content.shtml)；注册不等于已经开始交易。
- GigaDevice 双重上市：[GigaDevice Successfully Lists in Hong Kong](https://www.gigadevice.com/about/news-and-event/news/gigadevice-listed-on-hkex)。

## 16. 健壮性与定期 Review

生产运维、阈值、定时机制与发布门禁统一记录在 `OPERATIONS.md`：

- Vercel 每日健康探针检查页面 shell、Reference Price 和四个合约场所的 Funding History sentinel。
- GitHub Actions 每日执行静态语法、数据契约和生产健康检查。
- Codex 每日生成只读健康摘要，每周重新核对完整场所 catalog、身份冲突、上市生命周期、分类标签和历史覆盖。
- 自动检查不得直接修改 allowlist、分类、基线或生产；发现漂移时必须给出官方证据并等待人工确认。
- 任何已知 crypto 同名资产泄漏、币种/单位错误或大面积 Reference/Funding 错误均按 P0 处理。

## 17. Asset Intelligence 与 Signal Radar

三处界面必须共享同一个身份键：`assetKey = category + ':' + canonical underlying`。精确 venue ticker / wrapper 只作为 listing 明细，不能作为跨场所聚合键。`AAPL`、`AAPLX`、`AAPLon` 可在官方 wrapper 证据成立后归入同一 underlying；普通 Crypto ticker 即使同名也不得加入。

### Asset Intelligence Drawer

- 旧 `openAssetModal(venue, asset)` 仅保留为兼容入口，实际模型必须在每次打开/刷新时按 canonical identity 重新从当前 Perp、Spot、Traditional 数据解析，不能长期持有旧 row 对象。
- Equity / ETF / Pre-IPO Spot 只有通过 `spotAssetSecurityIdentity()` 的 wrapper 才能进入 Drawer；商品等非证券 RWA 仍必须先通过场所官方 RWA catalog/category。标题显示 canonical、名称、category 与市场 tag；各场所表保留 venue symbol、wrapper、字段状态与 last-success timestamp。
- 参考价、Nasdaq/OCC、Perp、Spot、Funding、Volume、OI 和可比价格价差都必须保留 Full / Partial / Estimated / Unavailable。缺失字段不补零；stale price 不进入价差。
- 最大价差继续使用 `(max - min) / min`、USD/share 同单位及 0.5×–1.5× reference quarantine，且只能称 `Indicative / Estimated`，不称可执行套利。
- Drawer 和 Signal Radar 必须复用同一 canonical key；Radar 行点击后不得在 Drawer 中重新按裸 ticker 猜身份。

### 服务端信号快照

- `GET /api/signal-snapshot` 是固定来源、GET-only、无 query 的服务端分析接口。来源只能是 Gate、Binance、Bitget 与 trade.xyz 的官方 catalog/market snapshot；官方 identity/category 缺失的 listing 必须 fail closed。监控 universe 是在身份 quarantine 后按 `24h USD volume + USD OI` 排序的 Top 100，响应与历史使用同一 universe，不能返回永远没有历史资格的后排资产。
- 普通 `crypto/coin/token/meme` category 在服务端直接拒绝。相同 canonical symbol 出现互斥 category 时，该 symbol 整体 quarantine 并计入 `identityConflicts`，不得选择价格更像股票的一侧。
- 服务端证券生命周期、ETF underlying、显式 wrapper alias、精确官方类型和 Binance bStock 映射集中在 `api/_lib/security-identity.js`。结尾 `B` 不能通用剥离；只有审计过的 bStock wrapper 表可以映射 underlying。客户端 `SECURITY_LISTING_REGISTRY` / `ETF_SYMBOLS` / `TOKENIZED_ETF_WRAPPERS` 与服务端 registry 必须由 contract test 校验一致，避免场所笼统的 `stock` 类型把 QQQ、SPY、SOXL、MUU 等 ETF 错标 Equity。
- Funding 年化必须使用每个合约实际 interval：`rate × (24 / intervalHours) × 365`。真实零费率保留为 0；缺失保持 null。
- 绝对阈值首版版本为 `rwa-radar-1.0`：Funding Watch 50% APR / High 100%；跨场所 Perp 价格 dispersion Watch 1% / High 3%；24h price move Watch 5% / High 10%。Volume/OI 只有至少 24 个小时样本后才使用 robust history score。
- 综合分数取最强 component，并对额外触发项小幅加分；不得把 APR、美元成交量和百分比直接相加。每行披露 primary type、component、formula version、baseline status、reason codes 和 confidence。
- 小于 24 个小时样本必须显示 `Baseline warming`，24–167 为 Partial，168 个小时样本才是 Full baseline；无历史时仍可显示越过绝对阈值的 Partial 信号，但不得显示 `All Normal`。

### 历史连续性

- 当前首版通过受 `CRON_SECRET` 保护且 `no-store` 的 `/api/signal-snapshot-cron`，按 UTC 小时桶幂等写入 Vercel Runtime Cache；公开的 `/api/signal-snapshot` 是 CDN 缓存读接口，不能直接作为 Cron target。最多保留 168 个服务端快照、每个资产最多返回 48 点；浏览器 `localStorage` 不再是 KPI 或 Radar 历史的数据源。
- 只有 Gate、Binance、Bitget、trade.xyz 四份 source snapshot 都为 Full 时才把当前桶写进历史。来源不完整时允许返回当前 Partial 监控结果，但不写基线，且没有越过绝对阈值的资产不能显示为 Normal。
- Runtime Cache 跨部署保留但属于区域 best-effort cache，可能被逐出，不是永久数据库。因此 API 的 persistence 主状态最多为 Partial，并明确返回 continuity、region、storedSnapshots 和 baseline coverage。
- 如需 30 日以上、跨 region 严格连续、可审计的历史，应迁移到 Neon/Postgres（run 表 + observation 表 + signal/fingerprint 表）；在迁移前不得把本缓存描述为永久数据库。

## 18. 中英文展示层

- 英文是界面文案的 canonical source；中文只属于 presentation layer。语言切换不得修改 ticker、venue、company name、canonical identity、category key、API payload、排序值或缓存键。
- 右上角 `EN / 中文` 只保存 `rwa_dashboard_locale_v1` 这一项本地偏好。不得复用 localStorage 保存行情、排名、Radar 基线或其他市场历史。
- 切换语言必须是纯 DOM 展示操作：不得调用 `fetch`、页面导航、数据 refresh 或可能继续加载 Funding History 的 renderer；当前顶层页面、子页、筛选、搜索、More 展开状态和已打开的 Asset Intelligence Drawer 必须保持不变。
- 动态状态由同一套 `Full / Partial / Estimated / Unavailable` canonical 值生成，再在展示层翻译；数据状态语义、缺失值与真实零值不能因语言变化而改变。
- 新增页面或动态模板时，必须同时补英文 source、中文映射和契约哨兵；生产发布前至少验证一次 `EN → 中文 → EN`、动态 MutationObserver 内容、320px 手机导航和 ticker/venue 不被翻译。
