# RWA Asset Identity & Data Rules

> 本文记录 RWA Dashboard 的资产准入、ticker 归一、类别/地区标签及上线校验规则。  
> 最近审计：2026-09-03。生产站点：<https://avenir-rwa-analyst.vercel.app/>

## 1. 核心原则

1. **Ticker 不是资产身份。** 同一个 ticker 可能同时指股票、商品代码和 crypto token。
2. **交易所官方产品元数据优先。** 聚合器、RWA CLI、静态 symbol 表和名称搜索只用于发现候选，不能单独证明资产身份。
3. **Fail closed。** 无法确认资产类型时不展示；不能用“不是 crypto”代替“已确认是 RWA”。
4. **先确认类别，再做 alias。** `CL/BZ/NG/PL/HG/GC/QNT` 等歧义代码不能全局替换。
5. **保留两层 symbol。** `venueSymbol` 用于请求交易所 API；canonical symbol 用于跨场所聚合和展示。
6. **资产类别和市场来源分开。** Equity/ETF/Commodity 是类别；US/ADR/HK/KR/TW/JP/CN 是独立 market tags。

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
| OKX | `state=live`，且 `instCategory` 精确属于 `3=Stocks / 4=Commodities / 5=Forex / 6=Bonds`；`SWAP` 与 `FUTURES + ruleType=xperp` 分开准入 | `instCategory=1` Crypto、空/未知类别、普通 dated `FUTURES`、`preopen`，以及只凭 `groupId` 或 ticker 猜测的产品 |

trade.xyz 当前专用 `xyz` DEX universe 有 5 个 `perpCategories` 空缺：`URANIUM`、`TTF`、`H100`、`NIFTY`、`IBOV`。它们只能通过这份逐项审计的 venue-scoped fallback 映射分别进入 Commodity / Index；任意其他空类别 ticker 仍拒绝。Binance 的 `HK_EQUITY`、`KR_EQUITY` 是官方 regional equity product class，归一化后属于 Equity；不能把任意包含 `EQUITY` 的未知字符串模糊放行。

### Spot

| Venue | 身份依据 |
|---|---|
| Bitget | Reality catalog 的 `isReality=YES`；legacy feed 只允许已审计贵金属/FX token |
| Kraken | `asset_class=tokenized_asset` 且 wrapper 为官方 xStocks；另允许已审计贵金属 token |
| Binance | `B` suffix 只是候选，underlying 还必须出现在官方 TradFi catalog；PAXG/XAUT 单独允许 |
| Gate.io | 不再仅凭 `X/ON` suffix 放行；必须是精确审计 wrapper，或 2026-08-14 逐 pair 审计的 `PAXG_USDT` / `XAUT_USDT` legacy commodity；未知 suffix 只能作为待复核候选 |
| OKX | Unified Tokenized Stocks 必须为 `state=live + instType=SPOT + instCategory=3 + quoteCcy=USDT`，再从官方大写 `X` wrapper 精确剥一层；`PAXG-USD`、`PAXG-USDT`、`XAUT-USDT` 是唯一 `instCategory=1` 精确例外 |

## 4. 同名 crypto 的处理

### QNT / Quantinuum

- `QNTUSDT` 在 Bitget 是 `isRwa=NO + symbolType=crypto`，必须拒绝。
- `QNT_USDT` 在 Gate 没有 RWA `contract_type`，必须拒绝。
- `QNTUSDT` 在 Binance 是普通 `PERPETUAL + COIN`，必须拒绝。
- `xyz:QNT` 的官方类别是 stocks，代表 Quantinuum，可以接收。
- `QNTX`、`QNTSTOCK` 只有在官方类别已经确认是 security 后，才归一为 canonical `QNT`。
- Quantinuum 已上市，因此 canonical 类别为 Equity，不再是 Pre-IPO。

这条规则说明：**同一个裸 ticker 可以在一个场所是股票、在另一个场所是 crypto；准入必须绑定 venue metadata。**

### OKX `instCategory=1`

- OKX 官方 `instCategory=1` 表示 Crypto，Perp 与 Spot 默认一律拒绝；证券 registry、名称、价格相似度、`groupId` 或裸 ticker 都不能反向放行。
- 唯一例外是已按 pair、base/quote 和审计日期锁定的 `PAXG-USD`、`PAXG-USDT`、`XAUT-USDT` 三个黄金现货交易对；例外不得扩大为其他 PAXG/XAUT quote，也不得扩大为所有“gold-like” ticker。
- 当前官方目录中 `CAT` 现货和 `LIT` 现货/永续均为 `instCategory=1` Crypto，不能误认 Caterpillar 或 Global X Lithium ETF。这两组应保留为生产身份冲突 sentinel。

### Spot wrapper

- `AAPLX`、`TSLAON`、`QNTB` 等 suffix 不能单独证明身份。
- 先验证 issuer/catalog，再解析 underlying。
- OKX 的大写 `X` 只能在官方 `instCategory=3` UTS 门控之后精确剥一层；例如 `XXLE -> XLE`。禁止先剥 `X` 再判断类别，否则 XRP、XLM 等 Crypto 会被误收。
- 普通股票 ticker（如 `CAT`、`PEP`、`AI`、`GME`）不能直接作为 spot RWA；现货股票通常应有 issuer wrapper 或官方 Reality/bStock 身份。
- `CORN/BRN/OIL/WHEAT` 等普通 crypto ticker 不能按商品名称误收。

## 5. Canonicalization 规则

1. Alias 必须按类别应用：
   - Commodity：`CL -> WTI`、`BZ -> BRENTOIL`、`GC -> XAU`。
   - Index：`SP500 -> SPX`、`NAS100 -> NDX`。
   - Security：`QNTX/QNTSTOCK -> QNT`。
   - Bitget/OKX 的宽泛 Stock(s) 类别只对当前审计过的 `SP500`、`NDX100`、`KR200`、`JP225` 精确改标为 Index；禁止按名称或 ticker 子串泛化，也不得让该覆盖离开 Bitget/OKX 场所作用域。
2. `CL` 也可能是 Colgate-Palmolive，`PL` 也可能是 Planet Labs，因此不能使用全局 alias。
3. Wrapper 可以保留 venue ticker 展示，但跨场所匹配必须使用 underlying。
4. 跨场所与跨板块的主键必须是 `category:canonicalUnderlying`，不能只使用 ticker。`CL` Equity 与 `CL` Commodity、真实 `SKHX` ETF 与 trade.xyz 的 `SKHX → SKHYNIX` Equity 必须保持为不同资产。
5. 同一 `category:canonicalUnderlying` 在多个 venue 出现时，类别必须一致；出现冲突应阻止发布并人工核对。
6. Venue alias 只能在已审计的场所作用域内生效：Gate 的 `QQQX/SPYX/TQQQX/SLVON` 才分别解析为 `QQQ/SPY/TQQQ/SLV`；其他场所的真实 `QQQX/SPYX` 证券不得被改写。trade.xyz 的 `SKHX` 才解析为 `SKHYNIX`；真实美股 ETF `SKHX` 保持自身身份。公司 lifecycle/equity alias 只作用于已确认的 Equity/Pre-IPO，不能把同名 ETF（例如未来的 `QNTB/SPCXB/CBRSB` ETF）改写成公司股票。

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
- `OPENAI/ANTHROPIC/SHEIN/ANDURIL/KALSHI/KIMI/NEURALINK/POLYMARKET`：Pre-IPO；后五项由 Gate 官方 `stocks + is_pre_market=true` catalog 交叉审计纳入。
- `UNITREE`：上海证券交易所公告确认 2026-08-19 起在科创板上市交易（证券代码 688836），因此为已上市 Equity / `public`；场所仍可使用 `UNITREE` 等产品代码，不能继续沿用 Pre-IPO 生命周期。
- `EWH/DFEN`：全局 ETF 类别修正；Gate 的 `QQQX/SPYX/TQQQX/SLVON` 是仅在 Gate 官方 RWA catalog 门控后生效的 ETF wrapper，不能作为全局 ticker 类别修正。
- `SKDD/SKUU`：GraniteShares 2x Short/Long SK Hynix Daily ETF。两者是 Nasdaq 上市的每日杠杆 ETF，参考标的是 SK Hynix ADR `SKHY`；它们不是 SK Hynix 普通股，也绝不能 alias 成 `SKHY/SKHYNIX`。只有场所先以官方 RWA/security catalog 准入后，才可把宽泛 Stock/Equity 类别细化为 ETF。
- `H100`：计算资源类 Commodity，不是股票指数。
- 已公开上市的公司不能因为场所残留 `is_pre_market` 就继续显示为 Pre-IPO。

“已上市”以交易所开始公开交易为准；递表、审核通过或发行注册都不等于已经上市。Pre-IPO 集合应保持小而明确，并定期核对上市事件。

上市状态只能在 `SECURITY_LISTING_REGISTRY` 更新一次，由它统一派生 canonical category、名称和 aliases。场所 snapshot 的 `PRE-IPO` 分组只是当时的产品目录，不拥有最终分类权；即使 fallback 分组过期，也必须经过 registry 再分类。

场所页同时保留一层独立的场所产品分类。trade.xyz 页以当前 `xyz` DEX 的 exact `perpCategories` 为准展示筛选与行标签；例如官方 `xyz:UNITREE = stocks` 在该场所页显示为 Equity，而公司级 `public` 生命周期由 registry 单独保留。当前 `xyz` DEX 没有 exact Pre-IPO 合约时，场所页隐藏空的 Pre-IPO 筛选，不能把其他 HIP-3 DEX（例如 `vntl:*`）的分类借给 `xyz:*`。

上架事件也必须发布这两层口径：`venueCategory` 是该交易场所精确产品的官方类别，`category` 是经过 lifecycle registry 细化后的 canonical 资产类别，`lifecycleStatus` 单独说明 `public / pre-ipo / ipo-registered`。例如 `xyz:UNITREE` 的上架消息必须写“合约分类：Equity”，并另写“公司阶段：已上市”；不能把旧公司阶段冒充成 trade.xyz 的合约分类。下游 Push Bot 只能使用这些 Dashboard 字段，不得自行按名称或 ticker 推断。

`UNITREE` 本次生命周期修正的官方依据是上海证券交易所 2026-08-18 发布的[上市交易公告](https://www.sse.com.cn/disclosure/announcement/listing/ipo/c/c_20260818_10829204.shtml)：股票自 2026-08-19 起上市交易。该修正更新既有精确产品的身份版本，不产生 New/Re-listed；某交易所后来新增一个精确 `venueSymbol` 时，仍由正常目录差分独立产生该场所的 listed 事件。

Durable catalog 中的同一官方产品只有在 canonical underlying 完全不变、旧类别为 `pre-ipo`、新类别为 `equity`、新 `lifecycleStatus=public`，且 canonical 已进入 `REVIEWED_PUBLIC_LIFECYCLE_CORRECTIONS` 的有日期官方依据白名单时，才允许做版本化的单向公司生命周期分类纠正。这不是 New/Re-listed 事件。另一个同样狭窄的例外是：已经由场所官方 security catalog 准入、canonical 完全不变、原始 `venueCategory` 为宽泛 Equity/ETF，且 canonical 位于 `REVIEWED_ETF_CATEGORY_CORRECTIONS` 的标的，允许从旧 `equity` 身份单向纠正为 `etf`；截至 2026-09-03 该白名单仅有 `SKDD/SKUU`。反向修正、非白名单标的，以及 ticker、canonical underlying、Commodity、Index、FX 或 Bond 的变化仍然是硬身份冲突，必须阻止发布并人工核对；新增白名单项必须同时补官方来源、防反向测试和“不生成 New/Re-listed”测试。

`SKDD/SKUU` 纠正依据为 GraniteShares 官方产品页与 Nasdaq Trader 2026-07-13 的 ETP 上市通知：两只 ETF 自 2026-07-14 开始交易。OKX 2026-09-02 的公告只证明精确产品 `SKDD-USD_UM_XPERP-310829` 于 2026-09-03 06:00 UTC 下架；它不能改变 `SKDD-USDT-SWAP` 的独立在架状态，也不能把身份纠正伪造成上架/重新上架事件。官方来源：<https://graniteshares.com/etfs/skdd/>、<https://graniteshares.com/etfs/skuu/>、<https://www.nasdaqtrader.com/TraderNews.aspx?id=ETP2026-113>、<https://www.okx.com/en-us/help/okx-to-delist-x-perp-for-skddusd>。

官方类型只允许精确归一化映射，例如 `PRE-IPO/PRE_IPO/PREIPO -> PREIPO`、`PRE-MARKET -> PREMARKET`。禁止用 `includes('PRE')` 判断，否则 `PREFERRED_STOCK` 等无关类型也可能被误判为 Pre-IPO。布尔字段也必须显式解析，字符串 `"false"` 不能按 JavaScript truthy 值处理。

Registry 只纠正“已经由场所确认是 security”的产品；显式 `crypto/coin/token/meme` 类型永远先返回 Other/拒绝，不能因为 ticker 命中 `QNT` 等已上市公司 alias 而被 registry 反向放行。

截至 2026-08-28，Bitget 官方目录中的 `SHEINUSDT` 为 `isRwa=YES + symbolType=stock + status=online`，trade.xyz 官方 `perpCategories` 将精确产品 `xyz:SHEIN` 标为 `preipo`。因此 `SHEIN` 在通过各自场所 security/RWA 准入后由唯一 lifecycle registry 统一细化为 Pre-IPO；Bitget 的宽泛 `stock` 不能被解释为已经公开上市，也不能覆盖 trade.xyz 的精确 Pre-IPO 产品类别。

通用 `identityVerified` 布尔值不能覆盖显式 Crypto 类型。确有交易所元数据错误时，必须以 `venue + exact symbol` 建立窄例外，并在入场时把标准化类别与原始 `venueMarketType` 分开保存；当前只有 Bitget `KUAISHOU` 使用这一规则。Spot 的 Reality/UTS/xStocks catalog 身份也不能让显式 Crypto `QNT/BTC` 被 lifecycle registry 反向升级。

Gate 当前另有 `BP + is_pre_market=true`，但其 `contract_type` 为空，未通过 RWA 身份门控，所以不能仅凭 premarket flag 纳入 registry 或页面。

## 7. Market tags

- Market tag 与资产类别无关，并允许多标签。
- `US`（页面显示为 `US-listed / 美股`）只表示 canonical underlying 当前存在于 Nasdaq Trader 官方 `nasdaqlisted.txt` 或 `otherlisted.txt`，且 `Test Issue=N`、类别为 Equity/ETF、非 warrant/right/unit/preferred/debt。它表示美国交易所上市，不表示公司国籍。
- `ADR` 表示美国上市的 depositary receipt/share。
- `HK/KR/TW/JP/CN` 表示 underlying、主要市场或明确的市场 exposure。
- 双重上市可以同时展示两个标签，例如 GigaDevice 为 `HK + CN`。
- 标签允许叠加，例如 `TSM = US + ADR + TW`、`BABA = US + ADR + CN`、`SKHY = US + ADR + KR`；`ASML` 是 Nasdaq New York registered share，显示 `US` 而不因外国公司身份自动标 ADR。
- ETF 的地区标签表示 exposure，不代表 ETF 自身在该地区上市，例如 `EWT = US + TW`、`EWY = US + KR`。
- 必须先通过 venue RWA security 准入、wrapper underlying 解析和 Equity/ETF 类别门控，再查 US 目录。不得按 ticker 外观、USDT 产品名、公司国籍、Yahoo 报价或“没有其他地区标签”反推 `US`。
- 官方目录本身可以合法包含与 Crypto 同名的证券，例如 NYSE Arca 的 `BTC` ETF；不能设置任何“该 ticker 必须永远不在目录”的全局黑名单。Crypto `BTC`、Pre-IPO 等身份必须在更早的 venue/category 门控被拒绝，只有已确认的 Equity/ETF 产品才能进入 US 目录匹配。
- ADR 识别只对 Equity 生效；名称包含 ADR 的 ETF（例如 ADR 主题 ETF）本身不能被标成 ADR。首次获取官方目录失败时 fail closed；已有已验证快照后可在 7 天上限内使用 last-known-good 并明确标 stale，超过上限重新禁用 US 筛选，而不是无限期沿用或猜测补齐。
- Perpetual By Asset 与 Spot All Assets 使用所有 listing 的 market-tag 并集；venue 顺序不能决定聚合标签。Category、Market、Search、Active-only 筛选互相独立并以 AND 组合。
- 官方目录的源时间采用 `America/New_York` 严格解析；服务端、health 和浏览器都校验两份原始 source epoch、最早/最新源时间与 7 天硬过期投影。CDN 的 fresh + stale 时间不得跨过该硬过期点。
- `/api/us-market-directory` 必须同时返回排序、去重且属于 `symbols` 子集的 `etfs` 与 `adrs`，并分别核对 `coverage.etfCount` / `coverage.adrCount`；QQQ 与 BABA 分别作为 ETF、ADR 正向 sentinel。Nasdaq Trader 官方 ETF 标志只可在场所已经确认 RWA/security 身份后，把宽泛 Equity/Stock 类别细分为 ETF，不能反向证明某个交易所产品是 RWA。目录不可用或校验失败时必须保留既有 last-known-good 的硬过期语义，首次无有效快照则 fail closed，禁止按名称猜 ETF。

## 8. 数据完整度状态

页面字段统一使用：

- **Full**：官方接口直接返回，覆盖完整。
- **Partial**：只抓取部分资产、部分深度层级或有限历史区间。
- **Estimated**：通过明确公式、fallback 或投影得到。
- **Unavailable**：接口不支持、未返回或本轮未成功抓取。

身份确认与字段完整度是两件事。资产可以是已确认 RWA，但 OI/Depth 等字段仍为 Partial 或 Unavailable。

`null` 不能在求和、最大值、排序或 Spot↔Perp bridge 中被 JavaScript 隐式转成 `0`。若所有组成字段均缺失，聚合值仍为 `null` 并显示 `— / Unavailable`；只有至少一个真实数值时才可聚合。

跨 listing 聚合必须同时返回 `value / observed / expected / status`。只要当前 catalog 中有任一应有 listing 缺值，聚合状态最多为 Partial；Spot KPI 与场所汇总在全缺失时必须显示 Unavailable，不能显示 `$0` 或 `0.0 bps`。过期的 Spot/Perp last-good 快照可以留在诊断表中，但不得进入 Basis / Net APR、Funding Ranking、Heatmap、Alerts 或代表性 funding spread 等可执行/异动路径。

前端 freshness 不能只相信快照上的字符串。Perpetual 与 Spot 都使用 `lastSuccessAt` 再做硬 TTL 校验：硬 TTL 为各自正常刷新 cadence 的 2 倍；缺少、非数、未来时间或恰好越过边界一律 fail closed 为 Unavailable/Stale。last-good 数值仍可诊断展示，但字段最多标 Partial；页面从隐藏恢复可见时，必须先按当前时钟重绘过期状态，再发起异步刷新。

Spot 的 catalog/ticker 是首屏核心数据，order-book depth 只是可选 enrichment。Perpetual 与 Spot 冷启动必须并行；Spot 各场所完成一个就提交一个，不能等待最慢场所后原子式显示。任一场所核心请求必须有硬 deadline，点击 Spot 时若数据为空或过期必须主动触发刷新。Gate/Kraken/Bitget/Binance 的 depth 获取一律在后台运行、逐请求 timeout，失败只把 `depth2` 保持 Unavailable，不能阻塞 listing、price、volume 或其他场所。

冷启动未完成时，场所数量与 KPI 必须显示 `— / Loading`，不能使用历史硬编码数量或把未知渲染成 0；场所确认失败后显示 Unavailable。后台 depth 必须绑定 refresh generation，旧一轮结果不得覆盖新 catalog。Bitget Reality instruments 是 Bitget 与 Gate 共用的动态身份目录，必须独立于 ticker 成败完成注册；身份目录失败时 Gate fail closed，不能用缩表结果冒充 live。Spot/Perp 并行完成顺序不确定，Reference Price 请求必须使用可补集的串行队列，并在两边任一方完成或进入 Spot 时幂等补齐共同资产。

Top 30 的 30 天成交量只把完整结束的 30 根 UTC 日线标为 Full；当天未结束 candle 必须排除。trade.xyz 的小时 K 线只提供 base volume，当前美元值使用 `base volume × close` 推导，因此即使取得 720 根完整小时线也只能标 Estimated，少于 720 根则为 Partial。状态 denominator 是当前已验证 catalog 的全部合约 listing，而不是只统计成功或正成交量响应；缺历史、少 candle 或缺合约均为 Partial/Unavailable，`24h × 30` 只能是 Estimated。每个合约/组件的贡献必须保留到明细，缺失贡献显示 `—`，不能当成 `$0`。XAUT/PAXG 等经审计黄金组件合并为 `commodity:XAU` 时，Top 30 与 Asset Intelligence Drawer 必须使用同一身份族。

生产环境的 Binance 与 trade.xyz 历史接口必须是固定快照：浏览器不得提交 symbol 或时间范围。服务端分别从 Binance active `TRADIFI_PERPETUAL`（另加精确 PAXG/XAUT 例外）以及 trade.xyz `metaAndAssetCtxs + perpCategories` 官方目录中重建身份门控，再按官方当前 quote/day notional 确定 Top 80。目录或完整 ticker 覆盖失败时返回 502/no-store；固定 URL 才能让所有浏览器共享同一个 CDN cache key，避免 Vercel 调用量随任意 symbol 组合扩张。

Binance Spot 生产目录同样必须使用固定的 `/api/binance-public?endpoint=spot-snapshot`。服务端先把 Spot `exchangeInfo` 中结尾为 `B` 的候选与当前 active `TRADIFI_PERPETUAL` 身份做 inner join，再加入精确审计的 `QNTB` 及 PAXG/XAUT 例外；结尾 `B` 本身永远不是 RWA 证明。浏览器不能提交 symbol 或 path，也不再下载完整 Spot `exchangeInfo`。任一身份目录失败时返回 502/no-store；ticker 不完整时保留完整 catalog 并逐字段降级为 Partial/Unavailable，ticker 全失败时响应不得进入共享缓存。

OKX 页面中的默认 Spot/Perp 手续费不是账户鉴权后的费率，只能标 **Estimated**；如果没有可信默认值或对应产品不支持该字段，则标 **Unavailable**，不得标 Full。OKX 衍生品 `volCcy24h × last/mark` 是美元成交额估算，也必须标 Estimated；官方 `oiUsd` 可在当前 catalog join 完整时标 Full。

## 9. 上线前审计清单

每次更新资产规则至少完成以下检查：

1. 拉取五家 perp 官方 catalog，统计准入数量和官方类型分布；OKX 还要分别统计 SWAP、X-Perp、raw listings 与 canonical underlyings。
2. 明确断言普通 QNT crypto 等已知冲突不会进入结果。
3. 检查所有 canonical ticker 是否存在跨 venue 类别冲突。
4. 检查 Equity 名称中是否出现 ETF/Fund/Trust/Index 等明显错标。
5. 检查 `SECURITY_LISTING_REGISTRY`：public 必须有开始交易日期；Pre-IPO 不得有开始交易日期；alias 不得跨公司冲突。
6. 检查 spot 是否存在裸股票 ticker、普通 crypto ticker 或未经确认的 suffix wrapper。
7. 对现货价格与股票参考价做异常比率扫描；异常只触发复核，不自动决定身份。
8. Preview 中核对 venue counts、目标资产标签、Top 30 和 Cross-Venue Coverage。
9. OKX 断言 `instCategory=1` 的 CAT/LIT/QNT 不进入，UTS 只在 category 3 后剥一层 `X`，普通 FUTURES 不进入，且同一 underlying 的 SWAP/X-Perp listing 都保留。
10. 检查 `/api/us-market-directory` 数量不低于 8,000，AAPL/QQQ/BABA/TSM 存在，QQQ 属于 `etfs`、BABA 属于 `adrs`，且 symbols/ETF/ADR 数量、排序、去重和子集关系全部一致；不以任何 ticker 缺席作为目录健康条件。逐页验证 Crypto BTC、Pre-IPO OPENAI 等不会越过类别门控，Perpetual 与 Spot 的 `US-listed / 美股` 筛选只保留带 US 标签的证券资产。
11. 浏览器每小时后台刷新一次完整美股目录；首次失败时筛选 fail-closed，已有通过校验的目录后刷新失败则在最长 7 天内继续使用 last-known-good，并按 5–30 分钟退避重试。筛选与类别、搜索、Active-only 条件始终使用 AND 组合。
12. 推送 Git 后再 promote 到生产，最后复查生产 DOM、Vercel `Ready`、`/api/health` 和 5xx 日志。

## 10. 已知精确例外

### Bitget KUAISHOU

Bitget 当前同时返回 `isRwa=YES` 和 `symbolType=crypto`，但该产品对应 Kuaishou Technology（港股）。代码只对 `KUAISHOU` 设置精确 Equity/HK 例外；不能把该例外扩大为“所有 `isRwa=YES` 的 crypto 类型都允许”。

### 聚合器/RWA CLI

聚合器可能把同名 ticker 合并错。例如 RWA CLI 的 `resolve qnt` 曾把 Bitget `QNTUSDT` 解析为 Equity，而 Bitget 官方 catalog 明确说明它是 crypto 且 `isRwa=NO`。因此 CLI 只负责 discovery/候选解析，最终身份必须回到场所官方 catalog。

### OKX tokenized gold

截至 2026-08-08，OKX Spot 的 `PAXG-USD`、`PAXG-USDT` 与 `XAUT-USDT` 虽由通用目录标为 `instCategory=1`，但 OKX 官方 listing/资产说明确认其为黄金支持 token，因此作为三个精确 pair 例外纳入。两条 PAXG pair 是同一个 canonical `PAXG`；listing 数与 canonical 数不能混用。

### 宽泛 Stock 类别中的指数

截至 2026-08-25，Bitget 官方 RWA catalog 将 `SP500`、`NDX100`、`JP225` 标为 `stock`，OKX Stocks catalog 将 `KR200` 纳入同一宽泛类别。`JP225` 同时由 Gate 官方 `JPN225_USDT + contract_type=indices` 与 trade.xyz 官方 `xyz:JP225 + indices` 交叉确认。它们仅在通过 Bitget/OKX 各自官方 RWA admission gate 后，按这四个精确 ticker 改标为 Index；crypto 类别或其他场所的同名 ticker 仍然拒绝。

## 11. 2026-08-08 基线

该数字只用于发现突然缺失或暴增，不应被当成永久硬编码：

| Market | Venue | Listings |
|---|---|---:|
| Perpetuals | trade.xyz | 108 |
| Perpetuals | Bitget | 273 |
| Perpetuals | Gate.io | 360 |
| Perpetuals | Binance | 155 |
| Perpetuals | OKX | 183 |
| Spot | Gate.io | 60 |
| Spot | Binance | 68 |
| Spot | Bitget | 627 |
| Spot | Kraken | 167 |
| Spot | OKX | 51 |

合约合计 1,079 listings、469 个跨场所 canonical assets；现货合计 973 listings。OKX 合约的 183 listings = 149 个 SWAP + 34 个 X-Perp，归并为 149 个 OKX canonical underlyings；同一个 underlying 的 SWAP 与 X-Perp 是两个独立 listing，不能互相覆盖。OKX 现货的 51 listings = 48 个 UTS + 3 个精确黄金 pair，归并为 50 个 canonical assets（PAXG 有两个 quote pair）。

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
- 期权成交合约数来自 OCC 官方 batch-processing report。当前值使用最近完成交易日（通常 T+1）；基线使用此前四周同一星期几的四个日度报告取平均。OCC 的 weekly download 当前只返回日期区间、没有逐标数据行，因此不能假装成 20 日均量。已成功解析且完整的 OCC totals report 中缺席某 root 表示当日观测为真实 0；只有报告 map 缺失/无效才是 null。这个 0 不等于该标的存在期权系列，`Optionable` 仍需当前或历史报告中出现过该 root。
- 股票美元值是 `Nasdaq same-session shares × same-session close`，只能标 Estimated，不是 consolidated/VWAP turnover。
- 期权美元值是 `OCC standard contracts × 100 × Nasdaq displayed underlying price`，代表 underlying notional，不是 option premium。`2AAPL`、`4SPY` 等 adjusted roots 的交割乘数未知，必须从标准 ×100 公式中排除并单独披露。
- `Est. Total Notional = Estimated Share Value + Estimated Options Underlying Notional`。两腿都可用时总值仍标 Estimated；任一腿缺失时总值保持 null/Partial，不得把 null 补 0 后继续排名。Perp/Spot 24h USD volume 只做并列覆盖展示，不得加进这个传统总值。
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

### OKX 双目录、批量行情与 30 日成交量

- OKX `perp-snapshot` 必须分别读取 `instType=SWAP` 和 `instType=FUTURES` 的 live official catalog。SWAP 与 `ruleType=xperp` 的 FUTURES 是两类独立 listing；ordinary dated FUTURES 即使 `instCategory` 看似 TradFi 也不能进入 Perpetuals。页面按 canonical 汇总时保留 `listings[]`，同一 venue 的 venue count 只计一次，但 Volume/OI 与 Drawer 明细不得静默丢掉另一份合约。
- Ticker、mark 与 OI 可以按 `instType` 批量拉取，但都必须 inner join 当前 live identity catalog。OKX OI bulk 可能短暂保留已到期周合约，market response 绝不能反向扩充 allowlist；任何不在本轮 live catalog 的 `instId` 必须丢弃。
- OKX 衍生品 ticker 的 `volCcy24h` 是 underlying/base 数量；24h USD volume 使用 `volCcy24h × positive(last, mark)`，状态为 Estimated。若改用 contract 数 `vol24h`，必须乘官方 `ctVal × ctMult` 后再乘价格；`ctVal` 与 `ctMult` 都不能默认成 1，也不能与 `volCcy24h` 重复相乘。OI 优先直接使用官方 `oiUsd`；其次才允许 `oiCcy × positive(mark,last)`；最后的 contract-count fallback 必须具备正数 `ctVal`、正数 `ctMult` 与正数估值价格，并计算 `oi × ctVal × ctMult × price`。每条 fallback 必须在 method fingerprint 中区分 mark 与 last，任一单位字段缺失即 OI Unavailable。
- OKX Spot 的 `volCcy24h` 是 quote-currency turnover；本项目准入的 UTS/gold quote 为 USD/USDT，因此可作为美元近似值展示。quote 或字段不符合门控时保留 null，不做跨单位相加。
- Top 30 的 OKX 30d volume 只累计 `1Dutc` 中 `confirm=1` 的完整日 K 线，按 timestamp 去重后必须有 30 根才为 Full；1–29 根为 Partial，0 根为 Unavailable。当前未完成日不得混入。无法取得完整 K 线时可显示 `24h × 30`，但必须明确标 Estimated，不能伪装为真实 rolling 30d。
- OKX 当前资金费率快照通过固定的 `/public/funding-rate?instId=ANY` 一次批量读取，再 inner join 本轮 live catalog；浏览器不得按 ticker 无界 fan-out。Funding History 仍按已准入的具体 `instId` 以受控并发、超时和有限分页读取。真实字符串 `"0"` 必须保留为有效零值。
- OKX 通用 maker/taker 默认值取决于地区、产品组和账户等级。未使用账户鉴权费率接口时，所有默认 fee 值标 Estimated；没有可信值时标 Unavailable。不得用默认费率生成 Full 状态或暗示可执行净收益。

页面可见性只影响请求调度，不影响数据语义：页面 hidden 时暂停轮询，恢复可见后只更新已过期数据。Traditional 排名只在用户进入该页时按需加载，客户端保留 1 小时，服务端 CDN 新鲜期 1 小时、stale-while-revalidate 24 小时；Traditional quote 仅在该页激活时请求，美股常规时段客户端保留 60 秒，休市时保留 15 分钟。

## 15. 主要核验来源

- Hyperliquid/trade.xyz market identity：`https://api.hyperliquid.xyz/info` 的 `perpCategories` 与 `metaAndAssetCtxs`。
- Bitget perpetual/Reality catalogs：`/api/v3/market/instruments`。
- Gate futures/spot catalogs：`/api/v4/futures/usdt/contracts` 与 `/api/v4/spot/currency_pairs`。
- Binance futures/spot catalogs：`/fapi/v1/exchangeInfo` 与 `/api/v3/exchangeInfo`。
- OKX official catalogs/market data：`/api/v5/public/instruments`、`/api/v5/market/tickers`、`/api/v5/public/mark-price`、`/api/v5/public/open-interest` 与 `funding-rate-history`；产品身份以 `state`、`instType`、`ruleType`、`instCategory` 为准，参考 [OKX API Guide](https://app.okx.com/docs-v5/en/)、[Stock Perpetuals](https://www.okx.com/en-us/help/stock-perpetuals) 与 [Unified Tokenized Stock terms](https://www.okx.com/en-us/help/unified-tokenized-stock-trading-terms-and-conditions)。
- Nasdaq Market Activity（股票/ETF Share Volume、Average Volume）：<https://www.nasdaq.com/market-activity>。
- OCC Volume Query / batch processing（期权成交量）：<https://www.theocc.com/market-data/market-data-reports/volume-and-open-interest/volume-query>。
- Quantinuum 上市状态：[Quantinuum Announces Closing of Upsized Initial Public Offering](https://ir.quantinuum.com/news-releases/news-release-details/quantinuum-announces-closing-upsized-initial-public-offering)。
- SpaceX 上市状态：[SEC free-writing prospectus（SPCX，2026-06-12 开始交易）](https://www.sec.gov/Archives/edgar/data/1181412/000162828026042466/spaceexplorationtechnologi.htm)。
- Cerebras 上市状态：[SEC Form 10-Q（CBRS，2026-05-14 开始交易）](https://www.sec.gov/Archives/edgar/data/2021728/000162828026044981/cbrs-20260331.htm)。
- MiniMax 上市状态：[HKEX allotment results（0100，2026-01-09 开始交易）](https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0108/2026010801342.pdf)。
- Z.AI / Zhipu 上市身份：[HKEX issuer announcement（2513）](https://www.hkexnews.hk/listedco/listconews/sehk/2026/0112/2026011201131.pdf)。
- 长鑫科技上市状态：[上交所上市交易公告（688825，2026-07-27）](https://www.sse.com.cn/disclosure/announcement/listing/ipo/c/c_20260724_10826610.shtml)。
- Unitree 上市状态：[上交所上市交易公告（688836，2026-08-19）](https://www.sse.com.cn/disclosure/announcement/listing/ipo/c/c_20260818_10829204.shtml)；此前的 IPO 注册批复只用于历史审计，不能覆盖后续正式上市事实。
- GigaDevice 双重上市：[GigaDevice Successfully Lists in Hong Kong](https://www.gigadevice.com/about/news-and-event/news/gigadevice-listed-on-hkex)。

## 16. 健壮性与定期 Review

生产运维、阈值、定时机制与发布门禁统一记录在 `OPERATIONS.md`：

- Vercel 每日 00:45 UTC 先运行当日首个十源 Listing Audit，01:00 再由健康探针检查页面 shell、Reference Price、五个合约场所的 Funding History sentinel、OKX Perp/Spot catalog 与身份/字段完整度，以及 Listing Audit 的 36 小时新鲜度和十源覆盖；Listing writer 另在 06:45、12:45、18:45 UTC 刷新同一个逻辑 UTC-day bucket，以缩短 best-effort Runtime Cache 被逐出后的空窗，但不得把同日重试计成新观察日。
- GitHub Actions 每日执行静态语法、数据契约、近 7 天竞品新上线摘要和生产健康检查。
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

- `GET /api/signal-snapshot` 是固定来源、GET-only、无 query 的服务端分析接口。通用小时信号、合约成交量与 OI/清算代理来源只能是 Gate、Binance、Bitget、trade.xyz 与 OKX 的官方 catalog/market snapshot；专用现货量价异动来源只能是 Gate、Kraken、Bitget、Binance 与 OKX 的官方 Spot catalog/market snapshot。官方 identity/category 缺失的 listing 必须 fail closed。OKX 的 SWAP/X-Perp 保留为 listing 后再按 canonical 聚合，`instCategory=1` 直接拒绝。通用小时信号 universe 是在身份 quarantine 后按 `24h USD volume + USD OI` 排序的 Top 100，响应与该小时历史使用同一 universe，不能返回永远没有小时历史资格的后排资产；独立的合约成交量日历史与 OI 小时历史按下述规则覆盖全量 verified RWA perpetual universe，不受 Top 100 截断。
- 普通 `crypto/coin/token/meme` category 在服务端直接拒绝。相同 canonical symbol 出现互斥 category 时，该 symbol 整体 quarantine 并计入 `identityConflicts`，不得选择价格更像股票的一侧。
- 服务端证券生命周期、ETF underlying、显式 wrapper alias、精确官方类型和 Binance bStock 映射集中在 `api/_lib/security-identity.js`。结尾 `B` 不能通用剥离；只有审计过的 bStock wrapper 表可以映射 underlying。客户端 `SECURITY_LISTING_REGISTRY` / `ETF_SYMBOLS` / `TOKENIZED_ETF_WRAPPERS` 与服务端 registry 必须由 contract test 校验一致，避免场所笼统的 `stock` 类型把 QQQ、SPY、SOXL、MUU 等 ETF 错标 Equity。
- Funding 年化必须使用每个合约实际 interval：`rate × (24 / intervalHours) × 365`。真实零费率保留为 0；缺失保持 null。
- 绝对阈值首版版本为 `rwa-radar-1.0`：Funding Watch 50% APR / High 100%；跨场所 Perp 价格 dispersion Watch 1% / High 3%；24h price move Watch 5% / High 10%。通用小时信号中的 Volume/OI 只有至少 24 个小时样本后才使用 robust history score；专用合约成交量异动使用独立日历史与下述比例阈值，两套成熟度不能混用。
- 综合分数取最强 component，并对额外触发项小幅加分；不得把 APR、美元成交量和百分比直接相加。每行披露 primary type、component、formula version、baseline status、reason codes 和 confidence。
- 小于 24 个小时样本必须显示 `Baseline warming`，24–167 为 Partial，168 个小时样本才是 Full baseline；无历史时仍可显示越过绝对阈值的 Partial 信号，但不得显示 `All Normal`。

### 合约成交量异动

- 该机制维护一份独立于通用 Top 100 小时信号的日历史，范围是本轮五个官方合约场所中通过身份门控的**全量 verified RWA perpetual canonical assets**。聚合与历史主键固定为 `category:canonical`；venue ticker 只进入该 canonical asset 的 exact `venue:venueSymbol` listing cohort，不能以裸 ticker 合并。
- 当前值使用本轮完整场所快照聚合得到的 rolling 24h USD contract volume，并与同一 `category:canonical`、同一 exact listing cohort 的前 7 个已封存 UTC 日期 rolling-24h 锚点均值比较。该锚点是监控代理值，不是精确 UTC 自然日成交量；当前值、7 日均值、比例、阈值级别以及由它们派生的频率结论全部标 **Estimated**。即使覆盖和历史成熟度为 Full，也不能把比例描述为官方结算值或可执行信号。
- 比例阈值固定为：`HIGH >= 2.0`、`MEDIUM >= 1.5 且 < 2.0`、`DOWN <= 0.4`；`0.4 < ratio < 1.5` 才属于 Normal。连续放量指最近连续至少 2 个 eligible 日均为 HIGH 或 MEDIUM。
- 30 日频率窗口统计最近 30 个可评估日。High-frequency 只有在至少 21 个 eligible days 且其中至少 6 个 anomaly days（HIGH、MEDIUM 或 DOWN）时成立；完整 30 日频率需要连续 37 个可比日桶，才能同时覆盖 30 个评估日及每个评估日之前的 7 日基线。
- 身份或数据不完整一律 fail closed：当前 volume 缺失、任一应有 listing 缺值、五源覆盖不完整、日锚点不足，或 exact listing cohort fingerprint 发生变化时，不计算可比比例，不生成 DOWN/Normal 结论，也不能沿用旧 cohort 的基线。fingerprint 变化后的资产必须以新 cohort 重新累计 7 日基线。
- 日历史按 UTC day bucket 幂等更新并保留 45 日；同一日重试只能替换该日快照，不能增加一个伪造观察日。只有受 `CRON_SECRET` 保护且 `no-store` 的 `/api/signal-snapshot-cron` 可以写入，公开 `/api/signal-snapshot` 与浏览器均为只读。首次 7 个可比日保持 Warming；第 8 个日桶才可形成首个 7 日比例，连续 37 个可比日桶后 30 日频率才成熟。Runtime Cache 逐出或历史不可用时重新 Warming/Unavailable，绝不能显示为无异动。

### 现货量价异动

- `spotVolumePriceAnomalies` 以**精确现货 listing**为观察单位，不按裸 ticker 或 canonical asset 合并。listing 主键固定为 `spot:venue:venueSymbol`，身份键固定为 `category:canonical`；同一 underlying 的 USD/USDT 或不同 wrapper 必须保留为不同观察行。交易所官方产品 catalog/type 是准入依据；ticker、名称、价格相似或已有合约同名均不能证明是 RWA。跨 category 同 canonical 冲突时整体 quarantine，不能让 Crypto 同名资产进入历史或告警。
- 每行先应用 `currentVolumeUsd >= 500000` 的硬过滤，再按 OR 关系判断：`currentVolumeUsd / yesterdayVolumeUsd >= 3.0`，或 `priceChange24hPct >= 15`。边界值包含在内；跌幅 `<= -15%` 不属于本版“涨幅”告警。前一日成交量缺失、非正数、不可比或时间戳不是前一个已封存 UTC day 时，成交量条件不可用；真实 0 必须保留为 0，但比例保持 null 且不得触发 volume，不能把 0 与缺失互换。价格条件仍可在 Day 1 独立触发。
- “昨日”是前一个已封存 UTC-date 桶里、同一 exact listing 的 rolling-24h USD turnover 锚点，不宣称为交易所 UTC 自然日成交量。当前与昨日的 listing key、identity、quote/单位和采集方法 fingerprint 必须一致；任一变化都重新 Warming。历史同一 UTC 日重试只能覆盖，不得追加伪观察；只保留最近 8 个 UTC 日，足以得到一个前日锚点并允许连续性检查。
- 成交量必须是 quote/USD turnover，不得把 base shares/tokens 当成美元。Gate 使用 `quote_volume`，Binance 使用 `quoteVolume`，Bitget Reality 使用 `platformTurnover24h`（不得回退到底层传统市场 `turnover24h`），OKX Spot 使用 `volCcy24h`；Kraken 可用 `v[1] × p[1]` 估算 USD turnover 并标 Estimated。缺失、负数、NaN、过期或不支持字段保持 null，不能通过 `|| 0` 进入过滤、比例或排序。
- 涨幅必须来自同一 listing 的 rolling-24h open/last 口径：Gate `change_percentage`、Binance `priceChangePercent`、Bitget `price24hPcnt`、OKX `open24h`。Kraken ticker 的 `o` 从 UTC 午夜起算，不是 rolling 24h open，因此本功能中 Kraken `priceChange24hPct` 固定 Unavailable，不能据此触发价格告警。
- `perpCoverage` 只能按相同 `category:canonical` 连接当前五个合约官方目录，并保留每个 exact `{venue, venueSymbol, instrumentType}`；不能按裸 ticker 猜测，也不能把多个 OKX contract 折叠掉。只有五个合约 source catalog 都为 Full 时，空 contracts 才能解释为“未上线合约”；否则覆盖状态为 Partial/Unavailable。
- 五个 Spot source 必须分别披露 catalog、ticker、`marketFieldCount` 与 `priceFieldCount`，界面按 `Vol observed/listings · Price observed/listings` 展示字段完整度。Kraken 的 `priceFieldCount` 固定为 0，这是明确不支持的语义而不是数据 0。只有五源 catalog/当前成交量覆盖完整、身份无冲突且历史写入资格成立时，板块才能宣称 Full 或“无异动”；任一来源 Partial/Unavailable 时允许展示可验证行，但板块必须降级，且不能用空表得出无告警结论。

### OI 趋势与清算代理

- 该机制每小时先检查五个官方合约场所中通过身份门控的**全量 verified RWA perpetual canonical assets**，不受通用 Radar response Top 100 截断；但 OI 历史只写入当小时通过严格 `$1m` 活跃度过滤且 OI 完整的 exact cohort。主键仍为 `category:canonical`，并为每个资产保存排序后的 exact `venue:venueSymbol` listing cohort 与 OI 采集方法 fingerprint；裸 ticker、不同 category 或变化后的 cohort 均不可沿用历史。估值价格从 mark 切换到 last（或反向）、direct USD OI 与数量换算之间切换，也属于 method/cohort 变化，必须重新 Warming。首次越过活跃度门槛的资产同样不能回填门槛下未监控的历史。
- 只有当前 rolling-24h USD contract volume **严格大于** `$1,000,000` 的资产才有告警资格；恰好 `$1,000,000` 不通过。volume 缺失、任一应有 listing 的 OI 缺失、五源覆盖不完整、身份冲突或 Crypto 类型都必须 fail closed，不能把 null 补成 0，也不能用部分 OI 聚合生成“无异动”。
- OI build 使用最近三个已经完成且连续的 UTC 日封存收盘 `d-3 / d-2 / d-1`，要求同一 cohort、同一 USD OI 方法且 `close(d-3) < close(d-2) < close(d-1)`。当天尚未完成的实时 OI 不参加三日趋势判断；任意缺日、相等、下降、future timestamp 或 fingerprint 变化都使该条件 Warming/Unavailable。
- deleveraging / liquidation proxy 使用同一 cohort 最近 24 小时可比小时锚点的 OI 峰值减当前 OI，只有差值**严格大于** `$2,000,000` 才触发；恰好 `$2,000,000` 不触发。OI build 与 proxy 按 OR 关系告警，并显式区分 build、proxy 与 both，前端只展示服务端结论，不自行重算。
- 同一份无缺口、同 cohort 的 24 小时序列还必须发布 `rwa-oi-24h-range-1.0`：当前 OI 减 24 小时最低 OI 得到增加金额，增加比例以该最低 OI 为分母。它是供下游日报和 OI 暴增提醒使用的加法契约，不改变既有 `evaluationStatus` 与 liquidation-proxy 触发语义；最低 OI 为 0 时比例保持 null 并给出原因码。
- 五源身份与字段覆盖可以达到 Full，但跨 listing 聚合后的 OI USD、三个日收盘、24 小时峰值/低点、回撤/增加及由它们派生的 signal 字段均必须标 **Estimated**；Full coverage 不能被展示成“精确 liquidation”或“确认新增仓位”。
- 该 proxy **不是逐笔清算数据**。USD OI 会同时受合约数量、标记价格及换算方法影响；峰值回撤只能表示可能的去杠杆、平仓或被动平仓压力，不能证明发生了多少真实 liquidation，更不能推断多头或空头哪一侧被清算。页面、API 和文档均不得把它描述为官方清算金额。所有由数量换算 USD 的路径都必须要求正数估值价格；价格为 0/缺失时不得把 OI 伪装成真实 0。Gate 只接受 `total_size × quanto_multiplier × positive(mark,last)`，且 `quanto_multiplier` 缺失/非法时不得默认成 1。
- Binance top-trader position ratio 只是精确 Binance 合约的可选情绪旁证。必须用本轮已验证 Binance `venueSymbol` exact join，并保留不晚于当前、最长 3 小时的官方时间戳；公开的 long/short percentage 必须约合 100，`longShortRatio` 必须与两者商一致。按发布后的四位 ratio 判断：严格 `>1.05` 为 Bullish、严格 `<0.95` 为 Bearish，`0.95` 与 `1.05` 两个边界都属于 Neutral。接口失败、没有该 exact symbol、过期或字段矛盾时状态为 Unavailable，禁止以 `1`、Neutral 或其他默认值代替。它不拥有 RWA 身份，也不能单独触发 OI/liquidation 告警。
- OI 小时历史使用独立 namespace `rwa-signal-oi-liquidation-hourly-v1`。每个桶只保存当时的 active eligible、OI-complete exact cohort；同桶重试幂等覆盖，拒绝未来观测，保留最近 96 个 UTC 小时，并在序列化后超过 1.75 MB 时整体拒绝写入。只有受 `CRON_SECRET` 保护的 no-store writer 可以写入；公开 `/api/signal-snapshot` 只读。首次跨过活跃度门槛或历史未成熟时显示 Warming/Unavailable，不能解释为“没有 OI 异动”。Runtime Cache 被逐出时必须从同 namespace 的 PostgreSQL durable checkpoint 恢复，不能重新从零预热。

### 历史连续性

- 当前版本通过受 `CRON_SECRET` 保护且 `no-store` 的 `/api/signal-snapshot-cron` 写入四个隔离历史：通用 UTC 小时信号 `rwa-signal-radar-v2`、全量合约成交量日锚点 `rwa-signal-volume-daily-v1`、精确 Spot listing 前日量价锚点 `rwa-signal-spot-volume-price-history-v1`，以及当小时 active eligible、OI-complete exact cohort 的 OI 小时锚点 `rwa-signal-oi-liquidation-hourly-v1`。每份有界 payload 先以 formula version、SHA-256、字节数和 `observed_at` 写入 `publication.signal_history_checkpoint`，再以 Vercel Runtime Cache 作为低延迟副本；四类历史不能混存。PostgreSQL 以 `observed_at` 拒绝旧 invocation 覆盖新 checkpoint。`PG_WRITE_MODE=shadow|required` 时，四份合格历史都确认 durable `stored` 才能令 writer 返回 HTTP 200；来源不完整而跳过、checkpoint 写失败、stale writer 或 1.75 MB 容量校验失败都必须返回 HTTP 503。Runtime Cache 写失败但 durable checkpoint 成功时允许由下次只读请求直接恢复，不得把缓存当连续性权威。公开的 `/api/signal-snapshot` 是 CDN 缓存读接口，不能直接作为 Cron target。通用信号最多保留 168 个小时快照、每个资产最多返回 48 点；合约成交量日历史保留 45 日，Spot 量价历史保留 8 日，OI 历史保留最近 96 个 UTC 小时。浏览器 `localStorage` 不再是 KPI、Radar、成交量或 OI 异动历史的数据源。
- 只有 Gate、Binance、Bitget、trade.xyz、OKX 五份 Perp source snapshot 都为 Full 时才把当前桶写进通用小时历史或独立合约成交量日历史。OI writer 至少要求这五份官方合约 catalog 均成功、非空、没有 `IDENTITY` / `INSTRUMENTS_UNAVAILABLE` / `CATALOG` / `UPSTREAM_COVERAGE` 缺口且无 identity conflict；否则跳过第四份写入并令 Cron 返回 503。单个资产当前 volume/OI 不完整时，该资产以 missing 计数 fail closed，不进入趋势或峰值告警；不能把 null 写成 0 或用部分 listing cohort 冒充完整资产。Spot 量价日历史只存成交量，因此必须要求 Gate、Kraken、Bitget、Binance、OKX 五份官方 Spot catalog 均可用、所有 admitted exact listing 的 `marketFieldCount === listingCount`、无 catalog identity rejection 且无 identity conflict。仅因 `priceFieldCount` 不完整而变成 Partial 的 Spot source 仍可写入完整 volume baseline，但当前板块继续为 Partial，不能据此宣称价格覆盖或“无异动”；任何 catalog/volume/identity 缺口都必须跳过 Spot 写入并令 Cron 返回 503。来源不完整时允许返回当前 Partial 监控结果，但不生成依赖缺失基线的比例，也不能把空表解释为 Normal。新增或移除场所、改变单位、采集字段、identity 或 listing cohort 定义时必须启用新的历史 namespace/version，不能比较不同方法分布。
- Runtime Cache 属于区域 best-effort 副本，可能被逐出，不是连续性权威。API 必须公开 checkpoint 读取/写入状态、实际 history source、region、storedSnapshots 和 baseline coverage。PostgreSQL checkpoint 只保证这四份有界历史不因 cache eviction 或部署而归零；它不等于逐条事实表、原始归档或完整可回放审计链。
- 如需超过现有 45日/168小时/8日/96小时边界、跨 region 主动复制或逐条可审计重放，仍应迁移到 run 表 + observation 表 + signal/fingerprint 表；不得把有界 checkpoint 描述为完整市场数据库。

## 18. 中英文展示层

- 英文是界面文案的 canonical source；中文只属于 presentation layer。语言切换不得修改 ticker、venue、company name、canonical identity、category key、API payload、排序值或缓存键。
- 右上角 `EN / 中文` 只保存 `rwa_dashboard_locale_v1` 这一项本地偏好。不得复用 localStorage 保存行情、排名、Radar 基线或其他市场历史。
- 切换语言必须是纯 DOM 展示操作：不得调用 `fetch`、页面导航、数据 refresh 或可能继续加载 Funding History 的 renderer；当前顶层页面、子页、筛选、搜索、More 展开状态和已打开的 Asset Intelligence Drawer 必须保持不变。
- 动态状态由同一套 `Full / Partial / Estimated / Unavailable` canonical 值生成，再在展示层翻译；数据状态语义、缺失值与真实零值不能因语言变化而改变。
- 新增页面或动态模板时，必须同时补英文 source、中文映射和契约哨兵；生产发布前至少验证一次 `EN → 中文 → EN`、动态 MutationObserver 内容、320px 手机导航和 ticker/venue 不被翻译。

## 19. 竞品新上线资产监控

- 检测频率与展示周期分离：服务端每天读取一次官方目录并做 diff；RWA Signal Radar 默认展示滚动 7 天，允许切换滚动 30 天。不得为了“周视图”把检测降低为每周一次。
- 覆盖必须恰好对应当前产品范围的十个独立 source：Perpetual 的 trade.xyz、Bitget、Gate、Binance、OKX，以及 Spot 的 Bitget、Gate、Kraken、Binance、OKX。主键是 `market:venue:venueSymbol`；不能以裸 canonical ticker 合并不同交易标的。
- 每个 source 的首次成功读取只建立基线，不生成 New。只有完整、无重复且通过类别漂移检查的官方 catalog 才能替换该 source 的 last-good 基线；Unavailable/Partial 不得清空基线，也不得制造假下架。单次缺失先记为 pending removal，至少跨两个不同 UTC 日的完整观测仍缺失后才记下架，同日重试不算第二次观测。通过官方身份门控的合理纯新增必须生成提醒，不能被普通 10% 缩表保护吞掉；包含删除的显著漂移及同时超过 50 个、50% 的极端纯增长继续隔离复核。新增、下架、重新上线必须分别记录，页面“竞品新上线资产”只显示新增和重新上线。
- 身份门控继续遵循本文件总规则。明确官方 RWA 类型且通过现有通用 admission gate 的标的可标 `verified`；普通 Crypto 类型直接拒绝。Gate Spot 不提供资产类别，只有 2026-08-14 已逐 pair 审计且仍在官方 live catalog 的 `PAXG_USDT`、`XAUT_USDT` 两个 legacy commodity pair 与精确 wrapper 可以直接验证；不得扩成其他 quote 或相似贵金属 ticker。其他新 suffix 即使与另一官方 RWA 目录同 canonical，也只能标 `review-required`，在精确 wrapper 身份确认前不得自动加入行情数据。
- Listing Audit 只观察和报告，不能写 allowlist、类别、生命周期、baseline 常量或客户端资产表。页面的 `Included` 必须同时匹配当前 Spot/Perpetual 数据中同一 venue 的精确 `venueSymbol` 与 `category:canonical` 身份；仅有相同 canonical underlying 不足以宣称该新 listing 已收录。
- `pendingReviews` 是独立的活动复核队列，不受页面 7/45 天事件窗口截断；只要标的仍活跃且身份未解决，就必须持续显示。它不能因事件过期而自动放行；精确官方身份确认后可转为 `verified`，连续完整目录确认下架后才可移出活动队列。
- 受 `CRON_SECRET` 保护的 `/api/listing-audit-cron` 是唯一 writer；公开 `/api/listing-changes` 是 GET-only、无 query 的 CDN 缓存 reader，浏览器不能触发目录采集、建立基线或写数据库。`analytics.catalog_change_event` 是唯一、持久的上架生命周期事件权威；可信 `collection_cycle` / `source_run` 决定最近一次成功审计时间和十源覆盖。`catalog_membership` 只能作为已验证的精确身份关联，严禁根据当前或历史 membership 的集合差补造事件。事件必须由 writer 在可信完整目录差分时写入，并携带稳定事件 ID、上一/当前 source run、身份状态及内部证据。`officialListedAt` 只能补充已由差分确认的事件，不能以 `onboardDate` 或相似日期字段单独制造事件。
- `LISTING_READ_MODE=postgres-authoritative` 时，`/api/listing-changes` 只通过专用最小权限 reader 和 `publication.listing_*_v1` 安全视图恢复最近 45 日事件及最近可信 source-run 覆盖；不得回读 Runtime Cache 来决定历史是否存在。只有 `verified + eligible` 的 listed/relisted 事件可以进入页面与 Push Bot，listed 对外映射为 `changeType=new`，delisted 保留在审计历史但不进入日报。`generatedAt` 必须来自最近一次成功审计，不能使用请求时间。原始证据、连接串、run/cycle 内部 ID 和数据库权限信息不得返回前端。
- `rwa-listing-audit-v2` Runtime Cache 与 CDN 只作为可丢失的低延迟副本；清空、重新部署或区域逐出不能重置 PostgreSQL 事件历史或制造空基线。紧凑 checkpoint 仍可用于 writer 连续性和回滚期间的旧读取模式，但不再取得事件历史权威。事件以 45 天为默认查询窗口、2,000 条为上限；截断必须降为 Partial 并公开 `history`，不能静默宣称 Full 或“没有新资产”。数据库无可信 source run、迁移/权限失败或事件投影不合法时必须 fail closed 为 Warming/Unavailable，不能以空数组冒充“确认无事件”。
- Nasdaq Trader 官方目录的 `etfs` 数组只用于在场所 RWA/security 门控之后细分宽泛 Stock/Equity 类别。当前 Kraken xStocks Listing Audit 依赖该官方 ETF 目录区分 Equity 与 ETF；目录不可用或契约不完整时，该 source 必须 Unavailable，不能把未知 ETF 猜成 Equity。官方 ETF 目录不是 RWA 准入白名单。
- OKX 的 183 Perpetual（至少 149 SWAP + 34 X-Perp）和 51 Spot（至少 48 UTS + 精确 3 gold）是已审核下限，不是阻止官方新增的永久精确数量。低于任一分项、Crypto/category 泄漏、重复或 market-data join 不完整继续失败；合法增长由 Listing Audit 单独提醒。

## 20. 数据库 Phase 0 / Phase 1 与 Listing 事件权威边界

- 数据库迁移不改变本文件第 1–19 节的任何准入、alias、category、生命周期、market tag、单位、状态或公式规则。交易所官方产品 metadata 仍是身份权威；PostgreSQL 只记录既有服务端门控的结果和证据，不能成为第二套自动准入引擎。
- 持久主键必须使用稳定 `asset_id` / `instrument_id` 及其 version 外键。`ticker`、`canonicalSymbol`、名称、价格相似度或跨场所同名只能作为版本化属性/检索字段，禁止作为事实表、历史表或告警表的独立连接键。
- **Phase 0** 只包含 Neon/PostgreSQL 连接、迁移 ledger、schema/role/权限、服务端开关、监控与 raw archive 契约。安全默认值固定为 `PG_WRITE_MODE=off`、`RAW_ARCHIVE_MODE=off`；仅配置 `DATABASE_URL` / `DATABASE_URL_UNPOOLED` / `LISTING_DATABASE_URL` / `BLOB_READ_WRITE_TOKEN` 不得自动启用 writer 或 reader。Listing 数据库读取必须使用独立的非 owner、非 superuser、非 catalog-writer 登录，且只属于 `rwa_listing_audit_reader`；复用通用 writer/migration 连接必须 fail closed。所有生产读取、Vercel Runtime Cache writer、CDN、Cron 以及当前 HTTP 503 语义在开关关闭时保持不变。
- **Phase 1** 只 shadow-write `api/_lib/listing-audit.js` 声明的十个官方 catalog：Perpetual 的 trade.xyz、Bitget、Gate、Binance、OKX，以及 Spot 的 Bitget、Gate、Kraken、Binance、OKX。允许落库的范围是 source/cycle/run、由已验证/已复核 catalog observation 确定性生成的 `normalized-catalog-v1` artifact、已准入 identity/instrument version、exact accepted catalog membership、review case 与 listing lifecycle event；读取仍以当前 Runtime Cache 为准。该 artifact 不是 upstream HTTP raw body，禁止标成 raw。
- **Listing 事件权威切换**只把已由 Phase 1 writer 确认的 `analytics.catalog_change_event`、对应身份版本和可信 source run 变成 `/api/listing-changes` 的服务端读取权威；不授权新的身份准入、市场事实写入、回填或浏览器写入。切换前必须应用迁移 `0006`、验证专用 reader 只能读取三个安全 publication view，并在隔离 Preview 证明 Runtime Cache 清空后事件 ID、名称、分类和时间不变。开关默认不自动启用；Preview 和 Production 分别授权。
- Phase 1 的 source run、Runtime Cache sink、数据库 sink 与 normalized-artifact sink 必须分别记录结果。数据库成功不能掩盖当前 writer 失败；数据库/artifact 失败在观察期暴露为 shadow pipeline 告警，但不能伪造现网 catalog Full，也不能把 Partial/Unavailable 目录写成 absence/delist。
- Phase 0/1 的 typed price/OI/funding/fact/derived tables 仍不得开始持续写入或切换读取。连续性例外只有两类：迁移 `0004` 的四行有界 `publication.signal_history_checkpoint`，以及迁移 `0005` 的单行有界 `publication.listing_audit_checkpoint`。后者只能保存当前 writer 已接受的精确紧凑 bundle，并用 checksum、字节数、schema、时间戳、十源集合和对应 collection cycle 约束；它不能从 catalog membership 推导内容，也不取得身份准入权。两个开关默认分别为 `LISTING_CHECKPOINT_WRITE_MODE=off`、`LISTING_READ_MODE=runtime-cache`；迁移存在或连接串存在都不得自动切换 reader。两类 checkpoint 都不新增身份、公式或信号，不保存 upstream raw body，也不能冒充逐条事实/完整回放系统。
- `review-required` 只能写入 `identity.review_case`；在精确官方身份完成复核前，不得创建 accepted asset/instrument version、`catalog_membership` 或 listing event。Rejected/普通 Crypto 也不得进入 accepted membership。
- Phase 1 shadow 数据只有在十源 exact membership、accepted/rejected/identity-conflict/review-case 计数、cohort fingerprint 与当前 Listing Audit 连续对账通过后，才可讨论下一阶段；任何 reconciliation 差异必须 fail closed 进入人工复核，不得用数据库行反向修改 allowlist。
- Phase 0 只建立 raw archive schema/契约；Phase 1 **不**归档官方 upstream raw response。真正 raw body 采集属于后续 collector instrumentation。启用后 PostgreSQL 仍只保存 URI、SHA-256、字节数、压缩、采集时间和 retention class，正文进入不可变对象归档；Authorization header、连接串、签名 URL 与其他 secret 永远禁止归档或写日志。
- 目标表关系、分区、retention、容量与迁移门槛见 `DATABASE_ARCHITECTURE.md`；每个页面板块的真实公式、粒度、状态和当前/目标持久化见 `DATA_CATALOG_AND_FORMULAS.md`；操作步骤见 `OPERATIONS.md`。
