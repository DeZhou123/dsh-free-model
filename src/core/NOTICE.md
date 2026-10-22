# 移植说明与来源

本目录下的 `.js` 文件是 **dsh-our-free-model（OFM）** 仓库
`vendor/channel-pack/src/` 中 TypeScript 源码的**逐行移植**，
基线为 **tag `v2.5.7`**（commit `4b5dd1ac4a663d1e068ee8f37834290436e59911`）。

## 为什么是移植而不是依赖

OFM **2.5.8**（commit `d187bf1`，`refactor(渠道)：移除两端 WorkBuddy 国内版与国际版`）
把这些文件整文件删除（-16936 行），并且新增了 `retired-providers.ts` 用来在探测与
RPC 上直接拒绝这两个 provider。也就是说 2.5.8 里**不存在**可复用的 buddy 实现 ——
唯一可用的来源就是 2.5.7 的源码本身。

## 改了哪些地方（其余逐字未动）

| 文件 | 改动 | 原因 |
|---|---|---|
| `buddy-auth.ts` → `.js` | `extends Service` → 普通 class；`super(ctx, name)` → `this.serviceName = …`；删掉 `declare module` 的 ctx 扩展 | 宿主里 OFM 的 channel-pack 可能已经注册了 `buddyAuth` / `workbuddyAuth`；第二次注册会抛错把 apply 打死 |
| `buddy-adapter.ts` → `.js` | `./llm-adapter.js` 的四个限流判据 → `./ratelimit.js`（原文件即在移植范围外） | 那四个函数住在 CodeArts 适配器里；本插件只要 buddy，不该为四个函数拖进华为签名与队列全链路 |
| `buddy-adapter.ts` → `.js` | `./llm-register-compat.js` → `./register.js`；`./token-ledger.js` → `./ledger.js`；`./account-pool.js` → `./pool-contract.js` | 前者依赖 dead-model-store 与 OFM 包内路径；后两者是宿主侧能力的**契约**而不是实现（不复制第二个账号池、不复制账本） |
| `expiry-sync.ts` → `.js` | 两个 import 指向 `./pool-contract.js` | 同上 |
| 全部 | `.ts` → `.js`（esbuild 转译，保留注释与类型无关逻辑） | 插件运行时直接加载 JS，无构建步骤 |

**没有改动的部分**：所有判据、阈值、文案、错误码与注释。包括：

- `MODEL_SATURATION_BUSINESS_CODE = 14003` 与 `RATE_LIMIT_BUSINESS_CODE = 6004` 的区分；
- `buddyExpiringWindowDays()` 的 15 天临期窗口与其可配置 env；
- `createPoolRefresh` 的「刷池里实际用的那一个账号」语义；
- `pickBuddyCredential` 的免费模型跳过永久积分锁定；
- `isFreeModel` 的判据表。

## 许可

OFM 仓库为 MIT。原 `LICENSE` 见
<https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/main/LICENSE>。
本移植体沿用同一许可。
