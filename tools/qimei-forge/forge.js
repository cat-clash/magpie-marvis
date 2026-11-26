// forge.js —— qimei36 铸号 frida 脚本
// 原理：hook qimei.dll!b (getqimei) 的输出缓冲区，写入自定义 36 位 hex
// 用法：frida -p <pid> -l forge.js  （或用 forge.mjs 驱动）
'use strict'

// ==== 配置（可通过 rpc.exports 动态改）====
var CONFIG = {
  enabled: true,
  value: '',            // 空 = 随机生成
  log: true
}

function LOG(m) { if (CONFIG.enabled && CONFIG.log) send("[forge] " + m) }

// 36 位 hex 生成（qimei36 格式：36 个十六进制字符）
function randomQ36() {
  var s = ''
  for (var i = 0; i < 36; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)]
  return s
}

function findQimeiExport(name) {
  var m = Process.findModuleByName("qimei.dll")
  if (!m) return null
  try { return m.findExportByName(name) } catch (e) { return null }
}

var installed = false
var stats = { calls: 0, forced: 0, lastOrig: '', lastValue: '' }

function install() {
  if (installed) return true
  var b = findQimeiExport("b")
  if (!b) return false
  installed = true
  LOG("qimei.dll!b (getqimei) @ " + b)

  Interceptor.attach(b, {
    onEnter: function (args) {
      this.buf = args[1]          // 输出缓冲区
      this.size = args[2].toInt32()  // 缓冲区大小（实测 70）
    },
    onLeave: function (rv) {
      if (!CONFIG.enabled) return
      stats.calls++
      var orig = ''
      try { if (this.buf && !this.buf.isNull()) orig = this.buf.readCString() || '' } catch (e) {}
      stats.lastOrig = orig

      var want = CONFIG.value || randomQ36()
      if (!this.buf || this.buf.isNull()) return
      // 需要 36 字符 + NUL
      if (this.size < 37) { LOG("buffer too small: " + this.size); return }
      try {
        this.buf.writeUtf8String(want)
        stats.forced++
        stats.lastValue = want
        LOG("forged " + orig + " -> " + want)
      } catch (e) { LOG("write failed: " + e) }
    }
  })
  LOG("forge installed")
  return true
}

// qimei.dll 可能在脚本加载后才加载
var ll = null
try { ll = Module.getGlobalExportByName("LoadLibraryW") } catch (e) {}
if (!ll) { var mk = Process.findModuleByName("kernel32.dll"); if (mk) ll = mk.findExportByName("LoadLibraryW") }
if (ll) {
  Interceptor.attach(ll, {
    onEnter: function (a) { try { this.p = a[0].readUtf16String() || '' } catch (e) { this.p = '' } },
    onLeave: function () { if (this.p && /qimei\.dll/i.test(this.p)) install() }
  })
}
if (!install()) LOG("waiting for qimei.dll load")

// ==== RPC 接口 ====
rpc.exports = {
  setValue: function (v) { CONFIG.value = String(v || ''); return CONFIG.value },
  setEnabled: function (v) { CONFIG.enabled = !!v; return CONFIG.enabled },
  stats: function () { return JSON.parse(JSON.stringify(stats)) },
  installed: function () { return installed }
}

LOG("forge ready")
