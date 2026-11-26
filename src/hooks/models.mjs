// ⑦ provider.models —— 模型目录
//
// Marvis 没有「列模型」的开放接口：模型注册表在客户端自己的
// `_internal/CONFIG`（Fernet 加密的 config_defaults.yaml）里，是**静态**的 25 条。
// 上游直连 `/v1/models` 一律 404，所以**直连模式下静态表就是权威，登录后也不变**。
//
// 唯一能动态获取的渠道是本地网关（默认 `http://127.0.0.1:8088/v1`，可用
// `MARVIS_GATEWAY_URL` 覆盖）：它的 `/v1/models` 能返回当前可用模型清单。开启
// `MARVIS_DYNAMIC_MODELS=1` 后，第一次调用 models 钩子时尝试从网关拉取；拉不到
// （网关未启动、直连上游、网络错误）则回落静态表。
//
// 三态降级里只有一条适用：
//   ③ 登录失效 → 抛带 signIn: "expired" 的错（由 loader 已经分流的 401 触发，这里兜底）
// 「接口失败」「缺字段」两条不适用：没有接口可失败。
//
// ⚠ 返回的是 OpenCode `Model` 形状（`capabilities.input` 是**对象**、`toolcall` 无下划线），
//   跟 `config` 钩子里的静态表（`modalities` 是**数组**、`tool_call` 有下划线）**不是一套**。
//   写混不会报错，只会让能力静默为假（HOOKS 十一之三）。
//
// ⚠ 想加模型？先确认它在 config_defaults.yaml 的注册表里 ——
//   槽位名写错不会报错，只会 4100402 模型不存在。

import { directGet } from "../marvis/directnet.mjs"
import { providerModels, SDK, BASE_V1 } from "../context.mjs"

const GATEWAY_BASE = String(process.env.MARVIS_GATEWAY_URL ?? "http://127.0.0.1:8088/v1").replace(/\/+$/, "")
const DYNAMIC_MODELS_URL = `${GATEWAY_BASE}/models`
const MODELS_CACHE_TTL = 60 * 60 * 1000 // 1 小时

/** @type {{ data: Record<string, any> | null, expires: number }} */
let cache = { data: null, expires: 0 }

/** 上游只给 id，能力字段按保守默认（text/toolcall，不收图）—— 不猜 */
function buildModelFromRemote(id) {
  return {
    id,
    name: id,
    api: { id, url: BASE_V1, npm: SDK },
    status: "active",
    capabilities: {
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true },
    },
    limit: { context: 1_000_000, output: 131_072 },
  }
}

async function fetchDynamicModels() {
  if (cache.data && Date.now() < cache.expires) return cache.data
  try {
    const res = await directGet(DYNAMIC_MODELS_URL, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const json = await res.json()
    const data = Array.isArray(json?.data) ? json.data : []
    const models = data
      .map((m) => String(m?.id ?? "").trim())
      .filter(Boolean)
      .map(buildModelFromRemote)
    if (models.length === 0) return null
    const out = Object.fromEntries(models.map((m) => [m.id, m]))
    cache = { data: out, expires: Date.now() + MODELS_CACHE_TTL }
    return out
  } catch {
    return null
  }
}

export function modelsHook() {
  return async (_getAuth) => {
    // 默认关闭：直连上游没有 /v1/models，静态表就是唯一来源。
    if (String(process.env.MARVIS_DYNAMIC_MODELS ?? "").trim() !== "1") return providerModels()
    const dynamic = await fetchDynamicModels()
    return dynamic ?? providerModels()
  }
}
