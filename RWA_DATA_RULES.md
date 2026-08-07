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

1. 已审计的上市状态/ETF wrapper override。
2. 官方细分类别。
3. 静态 ETF/Pre-IPO 集合。
4. 名称推断，仅作为最后 fallback。

当前重要 override：

- `QNT/QNTX/QNTSTOCK`：Equity。
- `EWH/DFEN/QQQX/SPYX/TQQQX/SLVON`：ETF。
- `H100`：计算资源类 Commodity，不是股票指数。
- 已公开上市的公司不能因为场所残留 `is_pre_market` 就继续显示为 Pre-IPO。

Pre-IPO 集合应保持小而明确，并定期核对上市事件。任何公司上市后，要同时更新 canonical category、名称、alias 和所有场所 fallback。

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
5. 检查 Pre-IPO 集合是否包含已经上市的公司。
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
- 修改本文件时，应同步检查 `index.html` 中对应的 allowlist、alias、category override、market tags 和 spot wrapper 规则。
- Git 历史保留旧规则，生产发布必须从已验证的 Preview promote，避免本地与线上规则漂移。

## 13. 主要核验来源

- Hyperliquid/trade.xyz market identity：`https://api.hyperliquid.xyz/info` 的 `perpCategories` 与 `metaAndAssetCtxs`。
- Bitget perpetual/Reality catalogs：`/api/v3/market/instruments`。
- Gate futures/spot catalogs：`/api/v4/futures/usdt/contracts` 与 `/api/v4/spot/currency_pairs`。
- Binance futures/spot catalogs：`/fapi/v1/exchangeInfo` 与 `/api/v3/exchangeInfo`。
- Quantinuum 上市状态：[Quantinuum Announces Closing of Upsized Initial Public Offering](https://ir.quantinuum.com/news-releases/news-release-details/quantinuum-announces-closing-upsized-initial-public-offering)。
- GigaDevice 双重上市：[GigaDevice Successfully Lists in Hong Kong](https://www.gigadevice.com/about/news-and-event/news/gigadevice-listed-on-hkex)。
