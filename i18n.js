(function () {
  'use strict';

  var STORAGE_KEY = 'rwa_dashboard_locale_v1';
  var SUPPORTED = new Set(['en', 'zh-CN']);
  var ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];

  var ZH = Object.freeze({
    'Avenir Group — RWA Perps Analytics':'Avenir Group — RWA 资产分析',
    'RWA Analyst is thinking':'RWA 分析引擎正在计算',
    'Connecting to venues...':'正在连接交易场所…',
    'RWA Perps Analytics':'RWA 资产分析',
    'Search assets (⌘K)':'搜索资产（⌘K）',
    'No alerts':'暂无提醒',
    'Connecting...':'连接中…',
    'Alerts & Anomalies':'提醒与异常',
    'Dashboard sections':'仪表盘板块',
    'Language':'语言',
    'Perpetuals':'永续合约',
    'Spot':'现货',
    'Traditional Market':'传统市场',
    'RWA Signal Radar':'RWA 信号雷达',
    'All Venues':'全部交易场所',
    'By Asset':'按资产',
    'Funding Heatmap':'资金费率热力图',
    'Aggregator':'聚合视图',
    'All RWA':'全部 RWA',
    'Equity':'股票',
    'Commodity':'大宗商品',
    'Index':'指数',
    'Bond':'债券',
    'ETF':'ETF',
    'Etf':'ETF',
    'Fx':'外汇',
    'Pre-Ipo':'上市前',
    'Equities':'股票',
    'Commodities':'大宗商品',
    'Indices':'指数',
    'Bonds':'债券',
    'ETFs':'ETF',
    'Pre-IPO':'上市前',
    'FX':'外汇',
    'Active only':'仅显示活跃',
    'Search asset...':'搜索资产…',
    'Auto-refresh: 60s':'自动刷新：60 秒',
    'Click an asset row to expand · Click a venue row for details':'点击资产行展开 · 点击交易场所行查看详情',
    'Funding settles every 1h':'资金费率每 1 小时结算',
    'Funding settles every 8h':'资金费率每 8 小时结算',
    'Funding settles per contract':'资金费率按合约规则结算',
    'Funding interval varies by contract':'资金费率周期因合约而异',
    'trade.xyz (Hyperliquid HIP-3 DEX)':'trade.xyz（Hyperliquid HIP-3 去中心化交易所）',
    'Bitget (USDT-FUTURES)':'Bitget（USDT 合约）',
    'Gate.io (USDT Perpetual)':'Gate.io（USDT 永续）',
    'Binance (USDT-M Perpetual)':'Binance（USDT-M 永续）',
    'OKX RWA SWAP + official X-Perp · Funding interval is contract-specific · Default fee values are indicative and account-tier dependent':'OKX RWA SWAP + 官方 X-Perp · 资金费率周期以合约为准 · 默认手续费仅为指示性估算，并取决于账户等级',
    'Official instCategory gate · Auto-refresh: 60s':'官方 instCategory 身份门控 · 自动刷新：60 秒',
    'Fetching OKX official RWA contract snapshot...':'正在获取 OKX 官方 RWA 合约快照…',
    'OKX official RWA catalog is empty':'OKX 官方 RWA 目录为空',
    'OKX official catalog produced no identity-verified RWA contracts':'OKX 官方目录未生成任何通过身份验证的 RWA 合约',
    'Standard Maker 0.03% / Taker 0.09% (Growth Mode may be lower)':'标准 Maker 0.03% / Taker 0.09%（Growth Mode 可能更低）',
    'Fees vary per contract (default Maker 0.02% / Taker 0.06%)':'手续费因合约而异（默认 Maker 0.02% / Taker 0.06%）',
    'Fees vary per contract (default Maker 0.015% / Taker 0.05%)':'手续费因合约而异（默认 Maker 0.015% / Taker 0.05%）',
    'Fees vary per contract (default Maker 0.02% / Taker 0.05%)':'手续费因合约而异（默认 Maker 0.02% / Taker 0.05%）',
    'Asset':'资产',
    'Mark Price':'标记价格',
    'Oracle Price':'预言机价格',
    'Index Price':'指数价格',
    '24h Change':'24 小时涨跌',
    '24h Volume':'24 小时成交量',
    'Open Interest':'未平仓量',
    '±2% Depth':'±2% 深度',
    'Funding Rate':'资金费率',
    'Funding':'资金费率',
    'Venues':'交易场所',
    'Best Price':'最佳价格',
    'Total Volume':'总成交量',
    'Total OI':'总未平仓量',
    'Funding Spread':'资金费率差',
    'Live Funding Monitor':'实时资金费率监控',
    'How to read':'如何阅读',
    'Search heatmap assets':'搜索热力图资产',
    'Heatmap view':'热力图视图',
    'Top opportunities':'最佳机会',
    'Multi-venue':'多交易场所',
    'All assets':'全部资产',
    'Sort heatmap':'排序热力图',
    'Sort: largest |APR|':'排序：|APR| 最大',
    'Sort: widest venue spread':'排序：交易场所差值最大',
    'Sort: highest 24h volume':'排序：24 小时成交量最高',
    'ticker · coverage':'代码 · 覆盖',
    'APR · click to sort':'APR · 点击排序',
    'max − min APR':'最高 − 最低 APR',
    'Not listed':'未上线',
    'No matching funding opportunities. Try All assets or a different search.':'没有匹配的资金费率机会，请选择“全部资产”或调整搜索条件。',
    'Funding scanner':'资金费率扫描器',
    'Funding Opportunity Matrix':'资金费率机会矩阵',
    'Annualized snapshot across venues. Click a rate for contract details and funding interval.':'跨交易场所的资金费率年化快照。点击费率可查看合约详情与结算周期。',
    '+26.6% APR → short receives':'+26.6% APR → 空头收取',
    '−26.6% APR → long receives':'−26.6% APR → 多头收取',
    'Color intensity is capped robustly so one extreme contract does not flatten the rest.':'颜色强度采用稳健上限，避免单个极端合约压缩其他数据的差异。',
    'Search ticker or name…':'搜索代码或名称…',
    'Price deviation — versus Yahoo Finance reference':'价格偏离 — 对比 Yahoo Finance 参考价',
    'Compares the venue spot price with the Yahoo Finance reference. Positive means above reference; negative means below.':'比较交易所现货价与 Yahoo Finance 参考价。正值表示高于参考价，负值表示低于参考价。',
    '✦ ≤0.1% Normal · ● 0.1–0.5% Watch · ⚠ >0.5% Caution':'✦ ≤0.1% 正常 · ● 0.1–0.5% 关注 · ⚠ >0.5% 警惕',
    'Basis — perpetual versus spot':'基差 — 永续合约对比现货',
    'Measures entry cost: a smaller basis lowers cash-and-carry entry friction. Negative basis can accompany negative funding.':'衡量建仓成本：基差越小，期现套利入场摩擦越低；负基差可能伴随负资金费率。',
    '✦ Ideal ±0.1% · ● Good 0.1–0.3% · △ Wide >0.3% · ⚠ Avoid <−0.1%':'✦ 理想 ±0.1% · ● 良好 0.1–0.3% · △ 偏宽 >0.3% · ⚠ 避免 <−0.1%',
    'Liquidity depth — order-book liquidity within ±2%':'流动性深度 — ±2% 范围内的订单簿流动性',
    'Measures executable bid and ask notional within ±2% of mid-price.':'衡量中间价 ±2% 范围内可成交的买卖单名义价值。',
    '● >$100K Deep · △ $10K–$100K Moderate · ⚠ <$10K Shallow':'● >$100K 深 · △ $10K–$100K 一般 · ⚠ <$10K 浅',
    'Annualized funding — cash flow for a short perpetual':'年化资金费率 — 做空永续合约的现金流',
    'Perpetual funding settles periodically. At positive rates, longs pay shorts. The latest rate is annualized by settlement cadence.':'永续合约定期结算资金费。正费率时多头支付空头；最新一期费率按结算频率年化。',
    'Source: latest rate from the selected perpetual venue. Positive = shorts receive; negative = shorts pay.':'数据源：所选永续交易场所的最新一期费率。正值表示空头收取，负值表示空头支付。',
    'Arbitrage APR — estimated return after costs':'套利 APR — 扣除成本后的估算收益',
    'Estimated annualized net return for long spot plus short perpetual after entry, exit and spread costs.':'做多现货并做空永续合约，在计入开平仓与价差成本后的估算净年化收益。',
    'Use Hold above to set the holding period. No Fees keeps gross annualized funding. Green ≥15% · Yellow ≥5% · Red <5%':'使用上方“持有期”设置周期。“不计费用”保留资金费率毛年化值。绿色 ≥15% · 黄色 ≥5% · 红色 <5%',
    'Positive funding':'正资金费率',
    'short side receives':'空头收取',
    'Negative funding':'负资金费率',
    'long side receives':'多头收取',
    'Near zero':'接近零',
    'APR annualizes the current funding period; it is not a return forecast.':'APR 是当前资金费率周期的年化值，并非收益预测。',
    'Overview':'概览',
    'All Assets':'全部资产',
    'Spot Pairs Tracked':'已追踪现货交易对',
    'Total 24h Volume':'24 小时总成交量',
    'All RWA spot':'全部 RWA 现货',
    'Avg Bid-Ask Spread':'平均买卖价差',
    'Liquidity indicator':'流动性指标',
    'Peak Funding APR*':'最高资金费率 APR*',
    'Exchange Summary':'交易所概览',
    'Avg Spread':'平均价差',
    'Maker Fee':'Maker 手续费',
    'Taker Fee':'Taker 手续费',
    'Est. Round-Trip':'估算往返成本',
    'Taker×2 + Avg Spread':'Taker×2 + 平均价差',
    'Loading exchange data…':'正在加载交易所数据…',
    'Cash-and-Carry Arb Ranking':'期现套利排名',
    'Hold':'持有期',
    'No Fees':'不计费用',
    'Direction:':'方向：',
    'All':'全部',
    'INACTIVE':'未激活',
    'NEW':'新进',
    'spot':'现货',
    'perp':'永续合约',
    'cross':'跨所',
    'Long Spot / Short Perp':'做多现货 / 做空永续',
    'Short Spot / Long Perp':'做空现货 / 做多永续',
    'Same-venue only:':'仅同一交易场所：',
    'on':'开启',
    'Refresh':'刷新',
    'Refresh snapshot':'刷新快照',
    'Refreshing':'刷新中',
    'Refreshing…':'刷新中…',
    'combos':'组合',
    'sorted by':'排序依据',
    'Route (Spot → Perp)':'路径（现货 → 永续）',
    'Route':'路径',
    'Spot Last':'现货最新价',
    'Perp Mark':'永续标记价',
    'Ref Price':'参考价格',
    'Spot Dev':'现货偏离',
    'Funding Ann.':'资金费率年化',
    'Cost Ann.':'成本年化',
    'Net APR (Funding)':'净 APR（资金费率）',
    'Net APR':'净 APR',
    'Basis':'基差',
    'Spot ±2%':'现货 ±2%',
    'Perp ±2%':'永续 ±2%',
    'Direction':'方向',
    'Notes:':'说明：',
    'Basis = (Perp Mark − Spot) / Spot; it is an entry-edge signal and is not annualized into APR because perpetual convergence is already expressed by funding.':'Basis =（永续标记价 − 现货价）/ 现货价；它仅作为入场价差信号，不再年化计入 APR，因为永续收敛已经通过资金费率表达。',
    'When Hold = No Fees, Net APR shows gross annualized funding.':'当持有期选择“不计费用”时，净 APR 显示资金费率的毛年化值。',
    'Funding Ann./APR annualizes only the current funding observation; it is not a forecast. Validate extremes against depth, basis, and future funding.':'资金费率年化 / APR 仅对当前一期资金费率做瞬时年化，并非未来收益预测；极端值需结合深度、基差与后续资金费率验证。',
    'Matching uses the underlying key (AAPLX/AAPLon both map to AAPL perp).':'匹配使用底层资产键（AAPLX / AAPLon 均映射到 AAPL 永续合约）。',
    'Cross-venue routes exclude withdrawal and capital costs.':'跨交易场所路径未计入提币与资金占用成本。',
    'All RWA Spot Assets':'全部 RWA 现货资产',
    'Underlying':'底层资产',
    'Tickers':'代码',
    'Issuer(s)':'发行方',
    'Category':'类别',
    'Exchanges':'交易所',
    'Perp':'永续',
    'Price Range':'价格区间',
    '24h Chg':'24 小时涨跌',
    'Bid-Ask':'买卖价差',
    '24h Vol':'24 小时成交量',
    '24h H / L':'24 小时高 / 低',
    'Last Price':'最新价格',
    'Dev %':'偏离 %',
    'Arb APR':'套利 APR',
    'Basis vs':'基差对比',
    'Server-side anomaly intelligence':'服务端异常情报',
    'Ranks verified RWA underlyings using server-maintained history. Volume, open interest, funding, price movement and cross-venue dispersion remain monitoring signals—not executable trade advice.':'基于服务端维护的历史数据，对已验证的 RWA 底层资产进行排序。成交量、未平仓量、资金费率、价格变动与跨交易场所离散度仅用于监控，不构成可执行交易建议。',
    'RWA signal rankings':'RWA 信号排名',
    'Filter by severity':'按严重程度筛选',
    'All severities':'全部严重程度',
    'High':'高',
    'Watch':'关注',
    'Normal':'正常',
    'Warming / unavailable':'预热中 / 不可用',
    'Filter by signal type':'按信号类型筛选',
    'All signal types':'全部信号类型',
    'Filter by asset category':'按资产类别筛选',
    'All categories':'全部类别',
    'Sort signals':'信号排序',
    'Server rank':'服务端排名',
    'Signal score':'信号分数',
    'Confidence':'置信度',
    '24h volume':'24 小时成交量',
    'Open interest':'未平仓量',
    'Asset A–Z':'资产 A–Z',
    'Search canonical asset...':'搜索标准资产…',
    'Search signal assets':'搜索信号资产',
    'Open Signal Radar to load':'打开信号雷达后加载',
    'The snapshot is requested only while this page is active and the browser is visible.':'仅当该页面处于激活状态且浏览器可见时才请求快照。',
    'Composite signal':'综合信号',
    'Volume':'成交量',
    'Volume spike':'成交量激增',
    'OI build':'未平仓量增长',
    'Funding extreme':'资金费率极值',
    'Price move':'价格异动',
    'Price dispersion':'价格离散度',
    'Cross-venue dispersion':'跨交易场所离散度',
    'Loading server snapshot':'正在加载服务端快照',
    'No browser-side anomaly calculation is used.':'不使用浏览器端异常计算。',
    'Signal snapshot unavailable':'信号快照不可用',
    'Partial · last successful snapshot':'部分可用 · 最近一次成功快照',
    'Partial baseline coverage':'基线覆盖不完整',
    'Server history unavailable':'服务端历史不可用',
    'Baseline warming':'基线预热中',
    'No High / Watch signals in this snapshot':'本次快照没有高风险 / 关注信号',
    'The historical baseline is ready. This is a monitoring result, not a guarantee that conditions are normal.':'历史基线已就绪。这是监控结果，不代表市场状况必然正常。',
    'Severity and score are supplied by the server snapshot; click an asset for its intelligence drawer.':'严重程度与分数由服务端快照提供；点击资产可打开情报抽屉。',
    'Snapshot':'快照',
    'Sources':'数据源',
    'Coverage':'覆盖',
    'History status':'历史状态',
    'Snapshot / persistence':'快照 / 持久化',
    'Server history':'服务端历史',
    'Server-normalized venue feeds':'服务端标准化交易场所数据',
    'Current source snapshot completeness':'当前数据源快照完整度',
    'Server persistence status':'服务端持久化状态',
    'server snapshot':'服务端快照',
    'snapshot':'快照',
    'snapshot ·':'快照 ·',
    'persistence':'持久化',
    'High signals':'高风险信号',
    'Watch signals':'关注信号',
    'RWA 24h volume':'RWA 24 小时成交量',
    'covered server snapshot':'已覆盖的服务端快照',
    'Server history warming':'服务端历史预热中',
    'snapshot unavailable':'快照不可用',
    'loading server snapshot':'正在加载服务端快照',
    'open Radar to load':'打开雷达后加载',
    'Rank':'排名',
    'Severity':'严重程度',
    'Signal type':'信号类型',
    'Score':'分数',
    'Price Dispersion':'价格离散度',
    'Baseline':'基线',
    'samples unavailable':'样本不可用',
    'No matching server signals':'没有匹配的服务端信号',
    'Adjust the severity, signal type, category or search filters. The browser does not manufacture fallback signals.':'请调整严重程度、信号类型、类别或搜索筛选。浏览器不会生成备用信号。',
    'Server weighted model':'服务端加权模型',
    'Server primary component':'服务端主要因子',
    'volume robust z':'成交量稳健 Z 分数',
    'oi robust z':'未平仓量稳健 Z 分数',
    'baseline partial':'基线不完整',
    'baseline unavailable':'基线不可用',
    'source snapshot incomparable':'数据源快照不可比',
    'price points quarantined':'价格点已隔离',
    'source fields unavailable':'数据源字段不可用',
    'Warming':'预热中',
    'Less':'收起',
    'More':'更多',
    'Asset Intelligence · canonical underlying':'资产情报 · 标准底层资产',
    'Close asset intelligence':'关闭资产情报',
    'Traditional Reference':'传统市场参考价',
    'Est. Trad Notional':'估算传统市场名义价值',
    'Crypto 24h Volume':'Crypto 24 小时成交量',
    'Indicative Max Spread':'指示性最大价差',
    'Fresh comparable prices only; not executable arbitrage':'仅使用新鲜可比价格；不代表可执行套利',
    'Traditional market reference':'传统市场参考',
    'Traditional reference':'传统市场参考价',
    'Traditional-first':'传统市场优先',
    'official completed-session activity':'官方已完成交易时段数据',
    'Perpetual coverage':'永续合约覆盖',
    'verified listings':'已验证标的',
    'Venue / contract':'交易场所 / 合约',
    'Mark':'标记价格',
    'OI':'未平仓量',
    'Status':'状态',
    'Source timestamp':'数据源时间',
    'Spot coverage':'现货覆盖',
    'Verified wrappers only':'仅限已验证包装资产',
    'ticker similarity is not identity evidence':'ticker 相似不构成身份依据',
    'Venue / token':'交易场所 / Token',
    'Last':'最新价',
    'Bid / Ask':'买价 / 卖价',
    'Spread':'价差',
    'Comparable price spread':'可比价格价差',
    '0.5×–1.5× reference guard':'0.5×–1.5× 参考价保护',
    'fresh routes only':'仅使用新鲜路径',
    'Traditional source':'传统数据源',
    'Shares':'股数',
    'Share value':'股票价值',
    'Options':'期权',
    'Options notional':'期权名义价值',
    'Total':'总计',
    'Signal':'信号',
    'Share value + standard-options underlying notional':'股票价值 + 标准期权底层名义价值',
    'Traditional Top 100 has not been loaded in this browser session':'本次浏览器会话尚未加载传统市场 Top 100',
    'Canonical asset identity is unavailable.':'标准资产身份不可用。',
    'No comparable spread route is available.':'没有可比的价差路径。',
    'Open Traditional Market to load the official Nasdaq/OCC ranking; no missing match is inferred before that request completes.':'请打开传统市场页面加载 Nasdaq/OCC 官方排名；请求完成前不会推断为缺少匹配。',
    'No verified Perpetual listing for this canonical identity':'该标准资产没有已验证的永续合约标的',
    'No venue-verified Spot wrapper for this canonical identity':'该标准资产没有经交易场所验证的现货包装资产',
    'No Perp':'无永续合约',
    'No Spot':'无现货',
    'At least two fresh, unit-comparable price points are required':'至少需要两个新鲜且单位可比的价格点',
    'Indicative only; excludes fees, slippage and latency. Prices outside the 0.5×–1.5× comparability guard are quarantined.':'仅供指示；未计入费用、滑点和延迟。超出 0.5×–1.5× 可比区间的价格会被隔离。',
    'absolute gap':'绝对价差',
    'comparable live points':'个可比实时价格点',
    'Funding history':'资金费率历史',
    'Canonical identity:':'标准身份：',
    'Verified by':'验证依据：',
    'Reference:':'参考价：',
    'Traditional activity:':'传统市场活动：',
    'Unavailable fields are never replaced with zero.':'不可用字段绝不会用零替代。',
    'Linked perpetual venues':'关联永续交易场所',
    'Linked spot venues':'关联现货交易场所',
    'Only one official market layer or an incomplete baseline is available':'仅有一个官方市场数据层可用，或历史基线不完整',
    'Estimated values: shares × price; options × 100 × underlying price':'估算方法：成交股数 × 价格；期权合约数 × 100 × 底层资产价格',
    'Rank / Underlying':'排名 / 底层资产',
    'shares ·':'股 ·',
    'contracts ·':'张合约 ·',
    'est.':'估算',
    'Nasdaq history avg':'Nasdaq 历史均值',
    'Traditional ranking is temporarily unavailable.':'传统市场排名暂时不可用。',
    'Retry now':'立即重试',
    'No official Nasdaq/OCC match for this canonical ticker':'该标准代码没有匹配的 Nasdaq / OCC 官方数据',
    'At least one Nasdaq price and one live comparable Crypto price are required':'至少需要一个 Nasdaq 价格和一个实时可比的 Crypto 价格',
    'At least one fresh Nasdaq price and one live comparable Crypto price are required':'至少需要一个新鲜的 Nasdaq 价格和一个实时可比的 Crypto 价格',
    'No Nasdaq/OCC official activity match in the current Top 100 candidate-set ranking':'当前 Top 100 候选集排名中没有匹配的 Nasdaq / OCC 官方活动数据',
    'Traditional activity is unavailable for this canonical asset.':'该标准资产的传统市场活动数据不可用。',
    'No positive traditional reference price':'没有有效的传统市场正价格参考',
    'stale; excluded from max spread':'数据陈旧；不计入最大价差',
    'session unavailable':'交易时段不可用',
    'the aligned completed session':'已对齐的完整交易时段',
    'Nasdaq completed-session share volume':'Nasdaq 已完成交易时段成交股数',
    'Shares × same-session close':'成交股数 × 同交易时段收盘价',
    'OCC standard-option contracts':'OCC 标准期权合约',
    'Contracts × 100 × underlying price; not option premium':'合约数 × 100 × 底层资产价格；并非期权权利金',
    'Composite of mark, volume, OI and funding fields':'标记价格、成交量、未平仓量和资金费率字段的综合状态',
    'Composite of price, bid/ask and volume fields':'价格、买卖报价和成交量字段的综合状态',
    'Estimated share value plus estimated options underlying notional':'估算股票价值 + 估算期权底层名义价值',
    'Net APR (Funding) = |Funding Ann.| − (SpotFee×2 + PerpFee×2 + Spread) × 365/Hold':'净 APR（资金费率）=｜资金费率年化｜−（现货手续费×2 + 永续手续费×2 + 价差）× 365 / 持有期',
    'Loading chart...':'正在加载图表…',
    'Failed to load chart data':'图表数据加载失败',
    'Insufficient data for chart':'图表数据不足',
    'Full':'完整',
    'Partial':'部分',
    'Estimated':'估算',
    'Unavailable':'不可用',
    'Complete official field':'完整官方字段',
    'Only a documented subset/level range is covered':'仅覆盖已说明的子集或档位范围',
    'Derived or fallback value':'推导值或备用值',
    'Unsupported, not returned, or not fetched':'不支持、未返回或未获取',
    'Traditional Market Activity Monitor · Top 100':'传统市场活跃度监控 · Top 100',
    'Traditional-first ranking within the disclosed official activity candidate set. The first 50 rows are shown by default; Perpetual and Spot coverage are joined only after rank is fixed.':'先在已披露的官方活跃候选集中按传统市场数据排名。默认显示前 50 行；排名确定后才叠加永续与现货覆盖。',
    'Ranking the traditional U.S. market first, then overlaying Perpetual and Spot coverage. The first 50 rows are shown by default.':'先对美国传统市场资产排名，再叠加永续合约与现货覆盖。默认显示前 50 行。',
    'Ranking Nasdaq securities and OCC completed-session options volume…':'正在根据 Nasdaq 证券与 OCC 已完成交易时段的期权成交量排名…',
    'Unusual':'异动',
    'Crypto Covered':'有 Crypto 覆盖',
    'Optionable':'有期权',
    'Trad Volume':'传统现货成交量',
    'Trad Baseline':'传统现货基线',
    'Trad RelVol':'传统现货相对量',
    'Options Volume':'期权成交量',
    'Options Baseline':'期权基线',
    'Options RelVol':'期权相对量',
    'Est. Total Notional':'估算总名义价值',
    'Perp 24h':'永续 24 小时',
    'Spot 24h':'现货 24 小时',
    'Data Status':'数据状态',
    'Within baseline':'基线范围内',
    'Loading quotes':'正在加载报价',
    'Need Trad + Crypto prices':'需要传统市场与 Crypto 价格',
    'Stale Trad quote · excluded':'传统市场报价已陈旧 · 已排除',
    'shares':'股',
    'contracts':'张合约',
    'prior avg':'此前均值',
    'share value + option notional':'股票价值 + 期权名义价值',
    'share value + option notional ·':'股票价值 + 期权名义价值 ·',
    'Ranking session:':'排名交易日：',
    'Daily rank':'日排名',
    'Scope:':'范围：',
    'Market:':'市场：',
    'Market':'市场',
    'Market filter':'市场筛选',
    'All Markets':'全部市场',
    'US-listed':'美股',
    'U.S.-listed equity, ETF, or ADR':'美国上市股票、ETF 或 ADR',
    'U.S.-listed depositary receipt/share':'美国上市存托凭证 / 存托股份',
    'Loading official directory…':'正在加载官方上市目录…',
    'Official directory unavailable':'官方上市目录不可用',
    'Using last verified directory':'正在使用最近一次已验证目录',
    'No assets match these filters':'没有资产符合当前筛选条件',
    'Options:':'期权：',
    'Estimated values:':'估算值：',
    'official activity candidates':'个官方活跃候选',
    'ranked':'已排名',
    'Nasdaq official':'Nasdaq 官方',
    'OCC official':'OCC 官方',
    'completed-session shares + close':'已完成交易时段的成交股数 + 收盘价',
    'T+1 as of':'T+1，截至',
    'shares × price; options × 100 × underlying price':'股数 × 价格；期权 × 100 × 底层资产价格',
    'No assets match this filter':'没有资产符合当前筛选',
    'tracked candidate-set Top 100':'已追踪候选集 Top 100',
    'official candidate-set ranking':'官方候选集排名',
    'candidate list latest':'候选列表为最新版本',
    'Quotes refreshing…':'报价刷新中…',
    'Nasdaq completed-session share volume aligned to the OCC session. Dollar value is estimated as shares × same-session close, not consolidated tape turnover.':'与 OCC 交易日对齐的 Nasdaq 已完成时段成交股数。美元价值按股数 × 同日收盘价估算，并非综合行情成交额。',
    'OCC completed-session contracts. Dollar value is estimated underlying notional: contracts × standard 100-share multiplier × Nasdaq price. It is not option premium.':'OCC 已完成交易时段的期权合约张数。美元价值为估算底层名义价值：合约数 × 标准 100 股乘数 × Nasdaq 价格，并非期权权利金。',
    'Estimated share value + estimated options underlying notional. Used as the default traditional-first ranking metric; this is not option-premium turnover.':'估算股票价值 + 估算期权底层名义价值。作为传统市场优先排名的默认指标；并非期权权利金成交额。',
    'Highest minus lowest live USD/share price across Nasdaq, Perp and Spot, divided by the lowest price. Points outside 0.5×–1.5× of Nasdaq are quarantined. Estimated only; not executable arbitrage and excludes fees, slippage and latency.':'Nasdaq、永续合约与现货的实时美元/股最高价减最低价，再除以最低价。超出 Nasdaq 价格 0.5×–1.5× 的点会被隔离。仅为估算，不代表可执行套利，且未计费用、滑点与延迟。',
    'Collapse':'收起',
    'Active Alerts':'活跃提醒',
    'alerts':'提醒',
    'Data Health':'数据健康',
    'All Normal':'全部正常',
    'no anomalies detected':'未检测到异常',
    'Total RWA Assets':'RWA 资产总数',
    'all venues combined':'全部交易场所合计',
    'Total Open Interest':'未平仓总量',
    'notional across all venues':'全部交易场所名义价值',
    'Avg Positive Funding':'平均正资金费率',
    'annualized':'年化',
    'critical':'严重',
    'warnings':'条警告',
    '24h Top Gainer':'24 小时涨幅第一',
    'Highest Funding':'最高资金费率',
    'Largest OI':'最大未平仓量',
    'Change data not available':'涨跌数据不可用',
    'notional':'名义价值',
    '(today vs yesterday)':'（今天对比昨天）',
    '24h Volume Growth — Top 3':'24 小时成交量增长 — Top 3',
    'today vs yesterday':'今天对比昨天',
    'Category Breakdown':'类别分布',
    'Volume Concentration':'成交量集中度',
    'Loading volume data...':'正在加载成交量数据…',
    'Volume growth data not available for this venue':'该交易场所暂无成交量增长数据',
    'prev':'此前',
    'now':'当前',
    'Cross-Venue Coverage':'跨交易场所覆盖',
    'Assets available on multiple venues':'在多个交易场所可用的资产',
    'Other':'其他',
    'Total unique':'唯一资产总数',
    'None':'无',
    'Funding Rate Ranking':'资金费率排名',
    'Annualized funding rates across all venues':'全部交易场所资金费率年化',
    'sorted by absolute value':'按绝对值排序',
    'Longs Pay Shorts':'多头支付空头',
    'Shorts Pay Longs':'空头支付多头',
    'short opportunity':'做空机会',
    'long opportunity':'做多机会',
    'No data':'暂无数据',
    'No spot data loaded. Click Refresh.':'尚未加载现货数据，请点击“刷新”。',
    'Loading':'加载中',
    'Loading venue catalogs…':'正在加载交易场所目录…',
    'Loading spot venue catalogs…':'正在加载现货交易场所目录…',
    'Loading venue catalog and ticker snapshot…':'正在加载交易场所目录与行情快照…',
    'Loading comparable routes…':'正在加载可比路径…',
    'Loading comparable Spot and Perpetual routes…':'正在加载可比现货与永续合约路径…',
    'Spot venue data unavailable. Refresh to retry.':'现货交易场所数据不可用，请刷新重试。',
    'Core catalog and ticker snapshot loading':'正在加载核心目录与行情快照',
    'No combos match the current filters.':'没有组合符合当前筛选条件。',
    'Loading spot data…':'正在加载现货数据…',
    'loading…':'加载中…',
    '⟳ Loading…':'⟳ 加载中…',
    '⟳ Loading':'⟳ 加载中',
    'Click for detail':'点击查看详情',
    'Detail':'详情',
    '⊕ Detail':'⊕ 详情',
    '⚠ Avoid':'⚠ 避免',
    '✦ Ideal':'✦ 理想',
    '● Good':'● 良好',
    '△ Wide':'△ 偏宽',
    'Intelligence':'资产情报',
    'No 30-day volume source available':'没有可用的 30 日成交量数据源',
    'All venue contributions use 24h×30 estimates':'所有交易场所贡献均使用 24h×30 估算',
    'No successful refresh':'尚无成功刷新',
    'Nasdaq Trad':'Nasdaq 传统市场',
    'Nasdaq Closed':'Nasdaq 已收盘',
    'Indicative estimate from live category-matched USD/share prices':'基于类别匹配的实时美元/股价格进行指示性估算',
    'Previous completed-session rank minus current rank; NEW means not in the previous candidate-set Top 100':'上一完整交易时段排名减去当前排名；“新进”表示上一候选集 Top 100 中没有该资产',
    'Nasdaq does not expose the previous dollar-volume-leader snapshot through this public feed, so this is a tracked official candidate-set Top 100 rather than a full U.S. market Top 100.':'Nasdaq 未通过该公开数据源提供上一期美元成交额领先榜快照，因此这里是已追踪官方候选集 Top 100，并非完整美国市场 Top 100。',
    'U.S.-listed depositary receipt/share':'美国上市存托凭证 / 存托股份',
    'Hong Kong underlying or market exposure':'香港底层资产或市场敞口',
    'Taiwanese underlying or market exposure':'台湾底层资产或市场敞口',
    'Japanese underlying or market exposure':'日本底层资产或市场敞口',
    'Mainland China underlying or market exposure':'中国内地底层资产或市场敞口',
    'Listed = official venue catalog · Active = venue trading status/activity · Priced = usable positive last price':'已上线 = 官方交易场所目录 · 活跃 = 交易状态 / 活动正常 · 有价格 = 最新价为可用正数',
    'The current market snapshot may be visible, but no historical Normal conclusion is available until server persistence recovers.':'当前市场快照可能仍可见，但服务端持久化恢复前不会给出基于历史数据的“正常”结论。',
    'Short receives':'空头收取',
    'Long receives':'多头收取',
    'Data coverage':'数据覆盖',
    'Venue spread':'交易场所差值',
    'Need 2 venues':'至少需要 2 个交易场所',
    'Show top 10 only ▴':'仅显示前 10 ▴',
    'RWA Multi-Venue Analytics':'RWA 多交易场所分析',
    'Top 30 RWA Perps by 30-Day Volume':'RWA 永续合约 30 日成交量 Top 30',
    'Building a rolling 30-day view from exchange klines; missing history is Partial or Unavailable, while formula fallbacks are Estimated.':'正在通过交易所 K 线构建滚动 30 日视图；历史缺失标记为“部分可用”或“不可用”，公式回退才标记为“估算”。',
    'No fresh comparable route':'暂无新鲜可比路径',
    'No fresh funding data':'暂无新鲜资金费率数据',
    'all venue sources live':'所有交易场所数据源均为实时',
    'no anomalies':'无异常',
    'all venue sources live · no anomalies':'所有交易场所数据源均为实时 · 无异常',
    'Open-interest field and snapshot freshness':'未平仓量字段与快照新鲜度',
    'Official last-price coverage and snapshot freshness':'官方最新价覆盖与快照新鲜度',
    '24h change coverage and snapshot freshness':'24 小时涨跌覆盖与快照新鲜度',
    '24h volume coverage and snapshot freshness':'24 小时成交量覆盖与快照新鲜度',
    '24h high/low coverage and snapshot freshness':'24 小时最高/最低价覆盖与快照新鲜度',
    'Best bid/ask coverage and snapshot freshness':'最佳买卖价覆盖与快照新鲜度',
    'Loading 30-day kline data from Binance, Bitget, Gate.io, and trade.xyz…':'正在加载 Binance、Bitget、Gate.io 与 trade.xyz 的 30 日 K 线数据…',
    'Loading 30-day kline data from Binance, Bitget, Gate.io, trade.xyz, and OKX…':'正在加载 Binance、Bitget、Gate.io、trade.xyz 与 OKX 的 30 日 K 线数据…',
    'Rolling window':'滚动窗口',
    'auto-refresh every 5 min':'每 5 分钟自动刷新',
    '30d Volume':'30 日成交量',
    'Median Funding APR':'资金费率 APR 中位数',
    'MERGED':'已合并',
    'Combined:':'合并：',
    'server severity':'服务端严重程度',
    'Normal classifications are withheld until the server reports sufficient history.':'服务端积累足够历史数据之前，不会给出“正常”分类。',
    '· hourly idempotent bucket':'· 每小时幂等时间桶',
    'short opportunity':'做空机会',
    'long opportunity':'做多机会',
    'Korean underlying or market exposure':'韩国底层资产或市场敞口',
    'EQUITY':'股票',
    'COMMODITY':'大宗商品',
    'INDEX':'指数',
    'BOND':'债券',
    'PRE-IPO':'上市前',
    'Demo v3':'演示版 v3',
    'Listed':'已上线',
    'Active':'活跃',
    'Priced':'有价格',
    'Inactive':'不活跃',
    'Unpriced':'无价格',
    'Live':'实时',
    'Stale cache':'缓存陈旧',
    'Trading':'交易中',
    'N/A':'不适用',
    'loading...':'加载中…',
    'All data within normal ranges':'所有数据均在正常范围内',
    'perpetual':'永续合约',
    'perpetual Top 30':'永续合约 Top 30',
    'cross-venue coverage':'跨交易场所覆盖',
    'traditional market':'传统市场',
    'signal radar':'信号雷达',
    'spot venue':'现货交易场所',
    'spot arbitrage rank':'现货套利排名',
    'spot All Assets':'现货全部资产',
    'dashboard':'仪表盘',
    'equity':'股票',
    'etf':'ETF',
    'commodity':'大宗商品',
    'index':'指数',
    'bond':'债券',
    'fx':'外汇',
    'pre-ipo':'上市前',
    'other':'其他',
    'full':'完整',
    'partial':'部分',
    'estimated':'估算',
    'unavailable':'不可用',
    'warming':'预热中',
    'high':'高',
    'watch':'关注',
    'normal':'正常',
    'baseline warming':'基线预热中',
    'funding threshold':'资金费率阈值',
    'price move threshold':'价格异动阈值',
    'price dispersion threshold':'价格离散度阈值',
    'source fields partial':'数据源字段不完整',
    'hourly idempotent bucket':'每小时幂等时间桶',
    'regional best effort; cache survives deployments but can be evicted and is not a permanent database':'区域级尽力持久化；缓存可跨部署保留，但可能被驱逐，且并非永久数据库',
    'region':'区域',
    'verified Perpetual catalog':'已验证永续合约目录',
    'verified perpetual catalog':'已验证永续合约目录',
    'verified Spot catalog':'已验证现货目录',
    'verified server signal snapshot':'已验证服务端信号快照',
    'official traditional directory':'官方传统市场目录'
  });

  var EN = Object.freeze({
    '% 有效费率':'Effective Rate %',
    '排除年化 < 1.5% 的无效周期，取正/负费率中占比更大的方向。绿色 = 多数时间正费率，红色 = 多数时间负费率。比例越高，费率方向越稳定，越适合持仓套利。':'Exclude ineffective periods below 1.5% annualized, then show the dominant funding direction. Green means mostly positive; red means mostly negative.',
    '价格偏离 — 与 Yahoo Finance 基准价的偏差':'Price deviation — versus Yahoo Finance reference',
    '比较交易所现货价与 Yahoo Finance 实时报价的偏离程度。正值表示交易所价格高于基准，负值表示低于。偏离越大，可能存在套利或定价异常。':'Compares the venue spot price with the Yahoo Finance reference. Positive means above reference; negative means below.',
    '基差 — 永续与现货的价差':'Basis — perpetual versus spot',
    '衡量建仓成本：基差越小，做 cash-and-carry 的入场成本越低。负基差意味着 funding 可能转负，不适合做空永续。':'Measures entry cost: a smaller basis lowers cash-and-carry entry friction. Negative basis can accompany negative funding.',
    '流动性深度 — ±2% 范围内的订单簿厚度':'Liquidity depth — order-book liquidity within ±2%',
    '衡量在当前中间价 ±2% 范围内有多少美元的买卖单可以被成交。深度越大，大额套利执行的滑点越小。':'Measures executable bid and ask notional within ±2% of mid-price.',
    '年化资金费率 — 做空永续可获得的收益':'Annualized funding — cash flow for a short perpetual',
    '永续合约定期结算资金费，正费率时多头付给空头。将最近一期费率按每日结算次数 × 365 天折算为年化收益率。结算频率因交易所而异（如 8h = 3次/天，1h = 24次/天）。':'Perpetual funding settles periodically. At positive rates, longs pay shorts. The latest rate is annualized by settlement cadence.',
    '套利年化 — 扣除成本后的净收益':'Arbitrage APR — estimated return after costs',
    '买入现货 + 做空永续的 cash-and-carry 策略净年化收益。用 funding 年化收入减去交易摩擦成本（开平仓手续费 + 滑点），再按持仓周期折算成全年。':'Estimated annualized net return for long spot plus short perpetual after entry, exit and spread costs.'
  });

  // These structures contain the same middle-dot delimiter used between
  // ordinary phrases, so they must be recognized before fragment splitting.
  var COMPOSITE_PATTERNS = [
    [/^(\d[\d,]*) ref \((\d[\d,]*) Full · (\d[\d,]*) Estimated · (\d[\d,]*) Unavailable\)$/, function (m) {
      return m[1] + ' 个参考价（' + m[2] + ' 完整 · ' + m[3] + ' 估算 · ' + m[4] + ' 不可用）';
    }]
  ];

  var ENGLISH_MONTHS = Object.freeze({
    Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6,
    Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12
  });

  function zhClock(hourValue, minute, second, meridiem) {
    var hour = Number(hourValue);
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
    var clock = String(hour).padStart(2, '0') + ':' + minute;
    return second ? clock + ':' + second : clock;
  }

  var PATTERNS = [
    [/^(\d{1,2}):(\d{2})(?::(\d{2}))?[\s\u202f]+(AM|PM)$/, function (m) {
      return zhClock(m[1], m[2], m[3], m[4]);
    }],
    [/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?[\s\u202f]+(AM|PM)(?:\s+([A-Z]{2,4}))?)?$/, function (m) {
      var localized = m[3] + '年' + ENGLISH_MONTHS[m[1]] + '月' + Number(m[2]) + '日';
      if (m[4]) localized += ' ' + zhClock(m[4], m[5], m[6], m[7]) + (m[8] ? ' ' + m[8] : '');
      return localized;
    }],
    [/^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?[\s\u202f]+(AM|PM)$/, function (m) {
      return m[3] + '年' + Number(m[1]) + '月' + Number(m[2]) + '日 ' + zhClock(m[4], m[5], m[6], m[7]);
    }],
    [/^(\d[\d,]*) Venues$/, function (m) { return m[1] + ' 个交易场所'; }],
    [/^(\d[\d,]*) Assets$/, function (m) { return m[1] + ' 个资产'; }],
    [/^(\d[\d,]*) assets$/, function (m) { return m[1] + ' 个资产'; }],
    [/^(\d[\d,]*) listings$/, function (m) { return m[1] + ' 个上市标的'; }],
    [/^(\d[\d,]*)\/(\d[\d,]*) listings available$/, function (m) { return m[1] + '/' + m[2] + ' 个上市标的数据可用'; }],
    [/^(\d[\d,]*) venues$/, function (m) { return m[1] + ' 个交易场所'; }],
    [/^(\d[\d,]*) venue$/, function (m) { return m[1] + ' 个交易场所'; }],
    [/^(\d[\d,]*) tokens$/, function (m) { return m[1] + ' 个 Token'; }],
    [/^(\d[\d,]*) token$/, function (m) { return m[1] + ' 个 Token'; }],
    [/^(\d[\d,]*) prices$/, function (m) { return m[1] + ' 个价格'; }],
    [/^(\d[\d,]*) server samples$/, function (m) { return m[1] + ' 个服务端样本'; }],
    [/^(\d[\d,]*)\/(\d[\d,]*) listing value\(s\) available(?:; (\d[\d,]*) stale\/unavailable snapshot\(s\))?$/, function (m) {
      return m[1] + '/' + m[2] + ' 个上市标的数据可用' + (m[3] ? '；' + m[3] + ' 个快照陈旧或不可用' : '');
    }],
    [/^(\d[\d,]*) stale\/unavailable snapshot\(s\)$/, function (m) { return m[1] + ' 个快照陈旧或不可用'; }],
    [/^(.+) snapshots$/, function (m) { return m[1] + ' 个快照'; }],
    [/^(\d[\d,]*) monitored$/, function (m) { return '监控 ' + m[1] + ' 个资产'; }],
    [/^(\d[\d,]*) alerts?$/, function (m) { return m[1] + ' 条提醒'; }],
    [/^(\d[\d,]*) critical$/, function (m) { return m[1] + ' 个严重'; }],
    [/^(\d[\d,]*) warnings?$/, function (m) { return m[1] + ' 条警告'; }],
    [/^(\d[\d,]*) Perp listings?$/, function (m) { return m[1] + ' 个永续合约标的'; }],
    [/^(\d[\d,]*) Spot listings?$/, function (m) { return m[1] + ' 个现货标的'; }],
    [/^OKX: (\d[\d,]*) official RWA contracts processed$/, function (m) { return 'OKX：已处理 ' + m[1] + ' 个官方 RWA 合约'; }],
    [/^(\d[\d,]*) market routes?$/, function (m) { return m[1] + ' 条市场路径'; }],
    [/^(\d[\d,]*) verified listings?$/, function (m) { return m[1] + ' 个已验证标的'; }],
    [/^(\d[\d,]*) volume fields? available$/, function (m) { return m[1] + ' 个成交量字段可用'; }],
    [/^(\d[\d,]*) venue source\(s\) stale\/unavailable$/, function (m) { return m[1] + ' 个交易场所数据源陈旧或不可用'; }],
    [/^(.+)\/(\d[\d,]*) total-value legs available; share value \+ standard-options underlying notional$/, function (m) {
      return m[1] + '/' + m[2] + ' 个总价值组成项可用；股票价值 + 标准期权底层名义价值';
    }],
    [/^(\d[\d,]*) positive assets$/, function (m) { return m[1] + ' 个正资金费率资产'; }],
    [/^(\d[\d,]*) priced$/, function (m) { return m[1] + ' 个有价格'; }],
    [/^(\d[\d,]*) exchanges$/, function (m) { return m[1] + ' 个交易所'; }],
    [/^(\d[\d,]*) pairs$/, function (m) { return m[1] + ' 个交易对'; }],
    [/^(\d[\d,]*) combos$/, function (m) { return m[1] + ' 个组合'; }],
    [/^(\d[\d,]*) spot listed$/, function (m) { return m[1] + ' 个现货标的'; }],
    [/^(\d[\d,]*) perps$/, function (m) { return m[1] + ' 个永续合约'; }],
    [/^(\d[\d,]*) ref$/, function (m) { return m[1] + ' 个参考价'; }],
    [/^(\d[\d,]*) live$/, function (m) { return m[1] + ' 个实时源'; }],
    [/^(\d[\d,]*) stale$/, function (m) { return m[1] + ' 个陈旧源'; }],
    [/^(\d[\d,]*) venues priced$/, function (m) { return m[1] + ' 个交易场所已有价格'; }],
    [/^(\d+(?:\.\d+)?) pp$/, function (m) { return m[1] + ' 个百分点'; }],
    [/^(\d[\d,]*) of (\d[\d,]*)$/, function (m) { return m[1] + ' / ' + m[2]; }],
    [/^Showing (\d[\d,]*) of (\d[\d,]*)$/, function (m) { return '显示 ' + m[1] + ' / ' + m[2]; }],
    [/^(\d[\d,]*) total$/, function (m) { return '共 ' + m[1] + ' 个'; }],
    [/^More · (.+)$/, function (m) { return '更多 · ' + m[1]; }],
    [/^Less · (.+)$/, function (m) { return '收起 · ' + m[1]; }],
    [/^Show all (\d[\d,]*) assets ▾$/, function (m) { return '显示全部 ' + m[1] + ' 个资产 ▾'; }],
    [/^Show (\d[\d,]*) more$/, function (m) { return '再显示 ' + m[1] + ' 个'; }],
    [/^View (\d[\d,]*) more$/, function (m) { return '再查看 ' + m[1] + ' 个'; }],
    [/^showing all (\d[\d,]*)$/, function (m) { return '已显示全部 ' + m[1] + ' 个'; }],
    [/^⚠ (\d[\d,]*) venue\(s\) failed$/, function (m) { return '⚠ ' + m[1] + ' 个交易场所失败'; }],
    [/^All (\d[\d,]*) venues$/, function (m) { return '全部 ' + m[1] + ' 个交易场所'; }],
    [/^All (\d[\d,]*)$/, function (m) { return '全部 ' + m[1]; }],
    [/^All \((\d[\d,]*)\)$/, function (m) { return '全部（' + m[1] + '）'; }],
    [/^All Markets \((\d[\d,]*)\)$/, function (m) { return '全部市场（' + m[1] + '）'; }],
    [/^US-listed \(([\d,]+|…)\)$/, function (m) { return '美股（' + m[1] + '）'; }],
    [/^Unusual (\d[\d,]*)$/, function (m) { return '异动 ' + m[1]; }],
    [/^Crypto Covered (\d[\d,]*)$/, function (m) { return '有 Crypto 覆盖 ' + m[1]; }],
    [/^High (\d[\d,]*)$/, function (m) { return '高风险 ' + m[1]; }],
    [/^Watch (\d[\d,]*)$/, function (m) { return '关注 ' + m[1]; }],
    [/^(\d[\d,]*) High$/, function (m) { return m[1] + ' 个高风险'; }],
    [/^(\d[\d,]*) Watch$/, function (m) { return m[1] + ' 个关注'; }],
    [/^Perp (\d[\d,]*)$/, function (m) { return '永续 ' + m[1]; }],
    [/^Spot (\d[\d,]*)$/, function (m) { return '现货 ' + m[1]; }],
    [/^All (\d[\d,]*) venues \((\d[\d,]*)\)$/, function (m) { return '全部 ' + m[1] + ' 个交易场所（' + m[2] + '）'; }],
    [/^(\d[\d,]*) venues \((\d[\d,]*)\)$/, function (m) { return m[1] + ' 个交易场所（' + m[2] + '）'; }],
    [/^(\d[\d,]*)-Venue$/, function (m) { return m[1] + ' 个交易场所'; }],
    [/^across (\d[\d,]*) venues$/, function (m) { return '覆盖 ' + m[1] + ' 个交易场所'; }],
    [/^opened from (.+)$/, function (m) { return '入口：' + translateCore(m[1], 'zh-CN'); }],
    [/^Confidence (.+)$/, function (m) { return '置信度 ' + translateCore(m[1], 'zh-CN'); }],
    [/^baseline ready for (.+)$/, function (m) { return '基线就绪：' + m[1]; }],
    [/^(\d[\d,]*) server snapshots available\.?$/, function (m) { return '已有 ' + m[1] + ' 个服务端快照。'; }],
    [/^(\d[\d,]*) server snapshots available\. Normal classifications are withheld until the server reports sufficient history\.$/, function (m) { return '已有 ' + m[1] + ' 个服务端快照。服务端积累足够历史数据之前，不会给出“正常”分类。'; }],
    [/^(\d[\d,]*) (Full|Partial|Estimated|Unavailable)$/, function (m) { return m[1] + ' ' + translateCore(m[2], 'zh-CN'); }],
    [/^(Equity|Commodity|Index|Bond|ETF|Etf|FX|Fx|Pre-IPO|Pre-Ipo) \((\d[\d,]*)\)$/, function (m) { return translateCore(m[1], 'zh-CN') + '（' + m[2] + '）'; }],
    [/^(equity|commodity|index|bond|etf|fx|pre-ipo) \((\d[\d,]*)\)$/, function (m) { return translateCore(m[1], 'zh-CN') + '（' + m[2] + '）'; }],
    [/^(.+): Full \((\d[\d,]*)\)$/, function (m) { return m[1] + '：完整（' + m[2] + '）'; }],
    [/^(.+): Partial \((\d[\d,]*)\)$/, function (m) { return m[1] + '：部分（' + m[2] + '）'; }],
    [/^(.+): Unavailable \((\d[\d,]*)\)$/, function (m) { return m[1] + '：不可用（' + m[2] + '）'; }],
    [/^Up (\d+) ranks? versus (.+)$/, function (m) { return '较 ' + m[2] + ' 上升 ' + m[1] + ' 位'; }],
    [/^Down (\d+) ranks? versus (.+)$/, function (m) { return '较 ' + m[2] + ' 下降 ' + m[1] + ' 位'; }],
    [/^Unchanged versus (.+)$/, function (m) { return '较 ' + m[1] + ' 排名不变'; }],
    [/^NEW versus (.+)$/, function (m) { return '较 ' + m[1] + ' 新进入榜'; }],
    [/^(\d+(?:\.\d+)?[KMB]?) shares$/, function (m) { return m[1] + ' 股'; }],
    [/^(\d+(?:\.\d+)?[KMB]?) contracts$/, function (m) { return m[1] + ' 张合约'; }],
    [/^(.+) est\.$/, function (m) { return m[1] + ' 估算'; }],
    [/^as of (.+)$/, function (m) { return '截至 ' + translateCore(m[1], 'zh-CN'); }],
    [/^Last success (.+)$/, function (m) { return '最近成功：' + m[1]; }],
    [/^U\.S\.-listed identity from Nasdaq Trader directory(?: · (.+))?$/, function (m) { return '美股身份来自 Nasdaq Trader 官方目录' + (m[1] ? ' · ' + m[1] : ''); }],
    [/^U\.S\.-listing filter unavailable: (.+)$/, function (m) { return '美股筛选不可用：' + m[1]; }],
    [/^Using last verified Nasdaq Trader directory(?: · (.+?))?; refresh failed: (.+)$/, function (m) { return '正在使用最近一次已验证的 Nasdaq Trader 目录' + (m[1] ? ' · ' + m[1] : '') + '；刷新失败：' + m[2]; }],
    [/^Error: (.+)$/, function (m) { return '错误：' + m[1]; }],
    [/^Open (.+) asset intelligence$/, function (m) { return '打开 ' + m[1] + ' 资产情报'; }],
    [/^region (.+)$/, function (m) { return '区域 ' + m[1]; }],
    [/^(\$[^\s]+) notional$/, function (m) { return m[1] + ' 名义价值'; }],
    [/^Total: (.+)$/, function (m) { return '总计：' + m[1]; }],
    [/^Updated (.+) \((\d+)(s|m|h) ago\)$/, function (m) {
      return '更新于 ' + translateCore(m[1], 'zh-CN') + '（' + m[2] + ({s:' 秒',m:' 分钟',h:' 小时'}[m[3]] || '') + '前）';
    }],
    [/^Updated (.+)$/, function (m) { return '更新于 ' + translateCore(m[1], 'zh-CN'); }],
    [/^Combined: (.+)$/, function (m) { return '合并：' + m[1]; }],
    [/^Universe: (\d[\d,]*) U\.S\.-listed securities in Nasdaq Trader directory$/, function (m) { return '资产范围：Nasdaq Trader 目录中的 ' + m[1] + ' 个美国上市证券'; }],
    [/^(\d[\d,]*) official activity candidates → (\d[\d,]*) ranked$/, function (m) { return m[1] + ' 个官方活跃候选 → ' + m[2] + ' 个已排名'; }],
    [/^Ranking session: (.+)$/, function (m) { return '排名交易日：' + m[1]; }],
    [/^candidate list (.+)$/, function (m) { return '候选列表：' + (m[1] === 'latest' ? '最新版本' : translateCore(m[1], 'zh-CN')); }],
    [/^Daily rank vs (.+)$/, function (m) { return '日排名对比：' + m[1]; }],
    [/^Scope: official candidate-set ranking$/, function () { return '范围：官方候选集排名'; }],
    [/^(\d[\d,]*)\/(\d[\d,]*) eligible aligned$/, function (m) { return '符合条件并对齐 ' + m[1] + '/' + m[2]; }],
    [/^(\d[\d,]*) session-ineligible excluded$/, function (m) { return '已排除 ' + m[1] + ' 个不符合该交易日条件的标的'; }],
    [/^· completed-session shares \+ close$/, function () { return '· 已完成交易时段的成交股数 + 收盘价'; }],
    [/^· T\+1 as of (.+)$/, function (m) { return '· T+1，截至 ' + translateCore(m[1], 'zh-CN'); }],
    [/^· (.+)$/, function (m) { return '· ' + translateCore(m[1], 'zh-CN'); }],
    [/^Activity (.+)$/, function (m) { return '数据活动时间 ' + translateCore(m[1], 'zh-CN'); }],
    [/^Last refresh failed: (.+)$/, function (m) { return '最近刷新失败：' + m[1]; }],
    [/^Stale Nasdaq quote \((.+)\); excluded from max spread(?: · refresh failed: (.+))?$/, function (m) {
      return 'Nasdaq 报价已陈旧（' + translateCore(m[1], 'zh-CN') + '）；已从最大价差中排除' + (m[2] ? ' · 刷新失败：' + m[2] : '');
    }],
    [/^Quote refresh failed: (.+)$/, function (m) { return '报价刷新失败：' + m[1]; }],
    [/^Spot refresh error: (.+)$/, function (m) { return '现货刷新错误：' + m[1]; }],
    [/^(\d+(?:\.\d+)?)h funding$/, function (m) { return m[1] + ' 小时资金费率'; }],
    [/^⟳ Refresh$/, function () { return '⟳ 刷新'; }],
    [/^⟳ Refreshing$/, function () { return '⟳ 刷新中'; }],
    [/^\((\d+)(s|m|h) ago\)$/, function (m) { return '（' + m[1] + ({s:' 秒',m:' 分钟',h:' 小时'}[m[2]] || '') + '前）'; }],
    [/^\(Top-3 = (.+)\)$/, function (m) { return '（前三名 = ' + m[1] + '）'; }],
    [/^prev (.+)$/, function (m) { return '此前 ' + m[1]; }],
    [/^now (.+)$/, function (m) { return '当前 ' + m[1]; }],
    [/^(.+) cross$/, function (m) { return m[1] + ' 跨所'; }],
    [/^(.+) spot → (.+) perp$/, function (m) { return m[1] + ' 现货 → ' + m[2] + ' 永续合约'; }],
    [/^Maker Fee (.+)$/, function (m) { return 'Maker 手续费 ' + m[1]; }],
    [/^Taker Fee (.+)$/, function (m) { return 'Taker 手续费 ' + m[1]; }],
    [/^All (\d[\d,]*) venue contribution(?:s|\(s\))? use exchange klines$/, function (m) { return '全部 ' + m[1] + ' 个交易场所贡献均使用交易所 K 线'; }],
    [/^(\d+[\/]\d+) venue contribution(?:s|\(s\))? use exchange klines; the rest use 24h×30$/, function (m) { return m[1] + ' 个交易场所贡献使用交易所 K 线；其余使用 24h×30 估算'; }],
    [/^(.+) venue contribution(?:s|\(s\))? use exchange klines$/, function (m) { return m[1] + ' 个交易场所贡献使用交易所 K 线'; }],
    [/^Sort: (.+) \|APR\|$/, function (m) { return '排序：' + m[1] + ' |APR|'; }],
    [/^(\d[\d,]*) remaining$/, function (m) { return '剩余 ' + m[1] + ' 个'; }],
    [/^(\d+)-session prior avg$/, function (m) { return '此前 ' + m[1] + ' 个交易时段均值'; }],
    [/^(\d+)-week same day$/, function (m) { return '此前 ' + m[1] + ' 周同一交易日'; }],
    [/^(.+) adjusted excluded$/, function (m) { return '已排除 ' + m[1] + ' 张调整类期权'; }],
    [/^(Market|Options) (.+)$/, function (m) { return translateCore(m[1], 'zh-CN') + ' ' + m[2]; }],
    [/^Data as of (.+)$/, function (m) { return '数据截至 ' + translateCore(m[1], 'zh-CN'); }],
    [/^Ranking (.+)$/, function (m) { return '排名交易日 ' + m[1]; }],
    [/^fetched (.+)$/, function (m) { return '获取于 ' + translateCore(m[1], 'zh-CN'); }],
    [/^(\d[\d,]*) Perp \+ (\d[\d,]*) Spot listings$/, function (m) { return m[1] + ' 个永续 + ' + m[2] + ' 个现货标的'; }],
    [/^(\d[\d,]*) comparable live points$/, function (m) { return m[1] + ' 个可比实时价格点'; }],
    [/^(\$[^\s]+) absolute gap$/, function (m) { return m[1] + ' 绝对价差'; }],
    [/^Verified by (.+)$/, function (m) { return '验证依据：' + translateCore(m[1], 'zh-CN'); }],
    [/^Reference: (.+)$/, function (m) { return '参考价：' + translateCore(m[1], 'zh-CN'); }],
    [/^Traditional activity: (.+)\. Unavailable fields are never replaced with zero\.$/, function (m) {
      return '传统市场活动：' + translateCore(m[1], 'zh-CN') + '。不可用字段绝不会用零替代。';
    }],
    [/^Traditional activity: (.+)$/, function (m) { return '传统市场活动：' + translateCore(m[1], 'zh-CN'); }],
    [/^(\d+[\/]\d+) expected observations in (.+) window$/, function (m) { return m[1] + ' 个预期观测已覆盖（' + m[2] + ' 窗口）'; }],
    [/^source completeness (.+)$/, function (m) { return '数据源完整度 ' + translateCore(m[1], 'zh-CN'); }],
    [/^Net APR \(Funding\) ([↑↓])$/, function (m) { return '净 APR（资金费率）' + m[1]; }],
    [/^(Asset|Route|Spot Last|Perp Mark|Ref Price|Spot Dev|Basis|Funding Ann\.|Cost Ann\.|Net APR \(Funding\)|Net APR|Spot ±2%|Perp ±2%) ([↑↓])$/, function (m) {
      return translateCore(m[1], 'zh-CN') + ' ' + m[2];
    }],
    [/^(.+) — arb opportunity$/, function (m) { return m[1] + ' — 套利机会'; }],
    [/^(.+) on (.+): (.+) mark-index gap$/, function (m) { return m[1] + ' 在 ' + m[2] + '：' + m[3] + ' 标记价-指数价偏差'; }],
    [/^Mark (\$[^\s]+) vs Index (\$[^\s]+)$/, function (m) { return '标记价格 ' + m[1] + ' 对比指数价格 ' + m[2]; }],
    [/^(.+)\. No High, Watch or Normal conclusion is available; retry remains backoff-controlled\.$/, function (m) {
      return m[1] + '。当前无法给出高风险、关注或正常结论；重试仍受退避策略控制。';
    }],
    [/^Refresh failed \((.+)\)\. Existing server snapshot remains visible; retry is backoff-controlled\.$/, function (m) {
      return '刷新失败（' + m[1] + '）。现有服务端快照继续显示；重试受退避策略控制。';
    }],
    [/^(.+)\. Retry remains subject to the current backoff window\.$/, function (m) {
      return m[1] + '。重试仍受当前退避窗口限制。';
    }],
    [/^(trade\.xyz|Bitget|Gate\.io|Binance|Kraken|OKX) Spot$/, function (m) { return m[1] + ' 现货'; }],
    [/^(trade\.xyz|Bitget|Gate\.io|Binance|Kraken|OKX) Perp$/, function (m) { return m[1] + ' 永续'; }],
    [/^(trade\.xyz|Bitget|Gate\.io|Binance|Kraken|OKX) (Perp|Spot) → (trade\.xyz|Bitget|Gate\.io|Binance|Kraken|OKX) (Perp|Spot)$/, function (m) {
      return m[1] + ' ' + translateCore(m[2], 'zh-CN') + ' → ' + m[3] + ' ' + translateCore(m[4], 'zh-CN');
    }],
    [/^(trade\.xyz|Bitget|Gate\.io|Binance|Kraken|OKX) (Perp|Spot) (.+) → (trade\.xyz|Bitget|Gate\.io|Binance|Kraken|OKX) (Perp|Spot)$/, function (m) {
      return m[1] + ' ' + translateCore(m[2], 'zh-CN') + ' ' + m[3] + ' → ' + m[4] + ' ' + translateCore(m[5], 'zh-CN');
    }],
    [/^(.+) → (trade\.xyz|Bitget|Gate\.io|Binance|Kraken|OKX) (Perp|Spot)$/, function (m) {
      return translateCore(m[1], 'zh-CN') + ' → ' + m[2] + ' ' + translateCore(m[3], 'zh-CN');
    }],
    [/^(Perp|Spot) 24h volume: (\d[\d,]*) volume fields? available$/, function (m) {
      return translateCore(m[1], 'zh-CN') + ' 24 小时成交量：' + m[2] + ' 个成交量字段可用';
    }],
    [/^Indicative estimate from live category-matched USD\/share prices(.+); excludes fees, latency and points outside the 0\.5×–1\.5× comparability guard\.$/, function (m) {
      return '基于类别匹配的实时美元/股价格进行指示性估算' + translateCore(m[1], 'zh-CN') + '；未计入费用、延迟及超出 0.5×–1.5× 可比区间的价格点。';
    }],
    [/^(.+); excludes fees, latency and points outside the 0\.5×–1\.5× comparability guard\.$/, function (m) {
      return translateCore(m[1], 'zh-CN') + '；未计入费用、延迟及超出 0.5×–1.5× 可比区间的价格点。';
    }],
    [/^(.+) APR spread$/, function (m) { return m[1] + ' APR 差'; }],
    [/^(.+) mark-index gap$/, function (m) { return m[1] + ' 标记价-指数价偏差'; }],
    [/^(\d[\d,]*) ASSETS$/, function (m) { return m[1] + ' 个资产'; }]
  ];

  var language = 'en';
  var textSources = new WeakMap();
  var attributeSources = new WeakMap();
  var observer = null;
  var languageApplied = false;

  function preferredLanguage() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (SUPPORTED.has(stored)) return stored;
    } catch (_) {}
    return String(navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh-CN' : 'en';
  }

  function splitUiFragments(value) {
    var fragments = [];
    var start = 0;
    var parenthesisDepth = 0;
    for (var index = 0; index < value.length; index += 1) {
      if (value[index] === '(') parenthesisDepth += 1;
      else if (value[index] === ')' && parenthesisDepth > 0) parenthesisDepth -= 1;
      else if (parenthesisDepth === 0 && value.slice(index, index + 3) === ' · ') {
        fragments.push(value.slice(start, index));
        start = index + 3;
        index += 2;
      }
    }
    fragments.push(value.slice(start));
    return fragments;
  }

  function translateCore(source, targetLanguage) {
    var value = String(source == null ? '' : source);
    if (!value) return value;
    if (targetLanguage === 'en') return EN[value] || value;
    if (Object.prototype.hasOwnProperty.call(ZH, value)) return ZH[value];
    for (var compositeIndex = 0; compositeIndex < COMPOSITE_PATTERNS.length; compositeIndex += 1) {
      var compositeMatch = value.match(COMPOSITE_PATTERNS[compositeIndex][0]);
      if (compositeMatch) return COMPOSITE_PATTERNS[compositeIndex][1](compositeMatch);
    }
    // Renderers frequently compose independently translatable status fragments
    // with this separator (for example "Confidence 82% · Partial"). Split
    // before applying broad regexes so one greedy match cannot hide a later
    // status, source, count, or category fragment.
    if (value.indexOf(' · ') >= 0) {
      var originalParts = splitUiFragments(value);
      var translatedParts = originalParts.map(function (part) { return translateCore(part, targetLanguage); });
      if (translatedParts.some(function (part, index) { return part !== originalParts[index]; })) {
        return translatedParts.join(' · ');
      }
    }
    for (var i = 0; i < PATTERNS.length; i += 1) {
      var match = value.match(PATTERNS[i][0]);
      if (match) return PATTERNS[i][1](match);
    }
    return value;
  }

  function translateText(raw, targetLanguage) {
    var value = String(raw == null ? '' : raw);
    var match = value.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!match || !match[2]) return value;
    return match[1] + translateCore(match[2], targetLanguage) + match[3];
  }

  function skipped(element) {
    return !element || Boolean(element.closest && element.closest('script,style,svg,[data-i18n-skip]'));
  }

  function protectedIdentityText(raw, parent) {
    if (!parent) return false;
    if (parent.matches('[data-i18n-identity],.asset-type,.hm-asset-name,.radar-asset-symbol,.radar-asset-name,.asset-identity-name')) return true;
    var token = String(raw || '').trim();
    if (!/^[A-Z][A-Z0-9._-]{0,20}$/.test(token)) return false;
    // Uppercase values are assumed to be ticker/contract identity unless the
    // renderer explicitly places them in a semantic category/filter element.
    return !parent.matches('.asset-tag,.radar-category,.asset-category-label,.chip,.spot-cat-filter,.cat-legend-item,.cat-chip,.i18n-ui-token,option');
  }

  function translateTextNode(node) {
    var parent = node && node.parentElement;
    if (!node || !parent || skipped(parent)) return;
    var current = node.nodeValue || '';
    if (protectedIdentityText(current, parent)) return;
    var state = textSources.get(node);
    if (!state || current !== state.rendered) state = { source:current, rendered:current };
    var rendered = translateText(state.source, language);
    state.rendered = rendered;
    textSources.set(node, state);
    if (current !== rendered) node.nodeValue = rendered;
  }

  function translateAttributes(element) {
    if (!(element instanceof Element) || skipped(element)) return;
    var state = attributeSources.get(element) || {};
    ATTRIBUTES.forEach(function (attribute) {
      if (!element.hasAttribute(attribute)) return;
      var current = element.getAttribute(attribute) || '';
      if (protectedIdentityText(current, element)) return;
      var previous = state[attribute];
      var source = previous && current === previous.rendered ? previous.source : current;
      var rendered = translateText(source, language);
      state[attribute] = { source:source, rendered:rendered };
      if (current !== rendered) element.setAttribute(attribute, rendered);
    });
    attributeSources.set(element, state);
  }

  function translateSubtree(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      translateTextNode(root);
      return;
    }
    if (!(root instanceof Element) && root !== document.body) return;
    if (root instanceof Element) translateAttributes(root);
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
      else translateAttributes(node);
    }
  }

  function updateTabs() {
    var group = document.getElementById('languageTabs');
    var english = document.getElementById('languageEnglish');
    var chinese = document.getElementById('languageChinese');
    if (group) group.setAttribute('aria-label', language === 'zh-CN' ? '语言' : 'Language');
    if (english) {
      var englishActive = language === 'en';
      english.classList.toggle('active', englishActive);
      english.setAttribute('aria-pressed', String(englishActive));
      english.setAttribute('aria-label', language === 'zh-CN' ? '切换为英文' : 'Current language: English');
    }
    if (chinese) {
      var chineseActive = language === 'zh-CN';
      chinese.classList.toggle('active', chineseActive);
      chinese.setAttribute('aria-pressed', String(chineseActive));
      chinese.setAttribute('aria-label', language === 'zh-CN' ? '当前语言：中文' : 'Switch to Chinese');
    }
  }

  function setLanguage(nextLanguage, options) {
    var next = SUPPORTED.has(nextLanguage) ? nextLanguage : 'en';
    var config = options || {};
    if (languageApplied && next === language) return;
    language = next;
    document.documentElement.lang = next;
    document.title = next === 'zh-CN' ? 'Avenir Group — RWA 资产分析' : 'Avenir Group — RWA Perps Analytics';
    updateTabs();
    translateSubtree(document.body);
    if (config.persist !== false) {
      try { localStorage.setItem(STORAGE_KEY, next); } catch (_) {}
    }
    languageApplied = true;
    window.dispatchEvent(new CustomEvent('rwa:languagechange', { detail:{ language:next } }));
  }

  function initialize() {
    language = preferredLanguage();
    setLanguage(language, { persist:false });
    observer = new MutationObserver(function (records) {
      records.forEach(function (record) {
        if (record.type === 'characterData') translateTextNode(record.target);
        else if (record.type === 'attributes') translateAttributes(record.target);
        else record.addedNodes.forEach(translateSubtree);
      });
    });
    observer.observe(document.body, {
      subtree:true,
      childList:true,
      characterData:true,
      attributes:true,
      attributeFilter:ATTRIBUTES
    });
  }

  window.setUiLanguage = setLanguage;
  window.translateUi = translateCore;
  window.uiLocale = function () { return language === 'zh-CN' ? 'zh-CN' : 'en-US'; };
  window.uiLanguage = function () { return language; };
  window.__RWA_I18N__ = { translations:{ en:EN, 'zh-CN':ZH }, storageKey:STORAGE_KEY };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once:true });
  else initialize();
})();
