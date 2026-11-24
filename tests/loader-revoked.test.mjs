// 被插件侧取消登录的账号 —— loader 必须走壳的「需要重新登录」通道
//
// 判据来自 scripts/accounts.mjs logout 的落盘形状：access/refresh 全空 +
// metadata.revokedAt。这类账号不能再静默 `return {}`（看起来像插件坏了），
// 要回 401 + X-Magpie-Sign-In: expired，与上游 4100403 同一条宿主通道。
//
// 跑法：MARVIS_TRANSPORT=direct node --test tests/loader-revoked.test.mjs

// 熔断器持久化在 ~/.magpie-marvis-native/breaker-state.json —— 宿主真实跑过插件
// 时那里可能有 open 状态。测试指向空临时目录隔离，绝不读宿主真实熔断状态。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
process.env.MARVIS_NATIVE_DIR = mkdtempSync(join(tmpdir(), "magpie-revoked-test-"))

import test from "node:test"
import assert from "node:assert/strict"

import { loaderHook, revokedByPluginLogout } from "../src/hooks/loader.mjs"

const baseMeta = { openid: "OPENID-A", guid: "a".repeat(32), loginType: "1", nickname: "阿伟" }

test("revokedByPluginLogout：access/refresh 全空 + revokedAt 才算被取消", () => {
  assert.equal(
    revokedByPluginLogout({ access: "", refresh: "", expires: 1000, metadata: { ...baseMeta, revokedAt: 1 } }),
    true,
  )
  assert.equal(revokedByPluginLogout({ access: "STILL-HERE", refresh: "", metadata: { revokedAt: 1 } }), false)
  assert.equal(revokedByPluginLogout({ access: "", refresh: "HAS-REFRESH", metadata: { revokedAt: 1 } }), false)
  assert.equal(revokedByPluginLogout({ access: "", refresh: "", metadata: { ...baseMeta } }), false, "没打标就不算")
  assert.equal(revokedByPluginLogout(null), false)
})

test("loader：被取消登录的账号回 401 + X-Magpie-Sign-In: expired，不出网", () => {
  const load = loaderHook({}, {})
  return load(async () => ({
    access: "",
    refresh: "",
    expires: 1000,
    uid: "OPENID-A",
    metadata: { ...baseMeta, revokedAt: 1700000000000 },
  })).then((out) => {
    assert.ok(out && typeof out.fetch === "function", "必须给出可用的 loader 配置，而不是空对象")
    const calls = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (...a) => {
      calls.push(a)
      return realFetch(...a)
    }
    return out
      .fetch("https://yybadaccess.3g.qq.com/v1/chat/completions", { method: "POST", body: "{}" })
      .then(async (res) => {
        globalThis.fetch = realFetch
        assert.equal(calls.length, 0, "取消登录的账号绝不能带着空 token 出网")
        assert.equal(res.status, 401)
        assert.equal(res.headers.get("x-magpie-sign-in"), "expired", "壳据此显示「需要重新登录」")
        const body = await res.json()
        assert.equal(body.error.code, "sign_in_revoked")
        assert.match(body.error.message, /重新登录/)
      })
      .finally(() => {
        globalThis.fetch = realFetch
      })
  })
})

test("loader：普通无凭据账号（没打 revokedAt）仍然 return {}，行为不变", async () => {
  const load = loaderHook({}, {})
  const out = await load(async () => ({ access: "", refresh: "", uid: "OPENID-A", metadata: { ...baseMeta } }))
  assert.deepEqual(out, {}, "没被插件取消过的空凭据账号不许改行为（壳自己会提示登录）")
})
