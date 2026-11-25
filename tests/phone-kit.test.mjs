// phone-kit zip 打包器：结构合法、Unix 权限位、可复现（构建 Release 附件用）
import test from "node:test"
import assert from "node:assert/strict"
import { buildZip } from "../scripts/build-phone-kit.mjs"

function parseCentral(zip) {
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, "EOCD 签名")
  const count = zip.readUInt16LE(zip.length - 22 + 10)
  let p = zip.readUInt32LE(zip.length - 22 + 16)
  const rows = []
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50, "central 签名")
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const mode = zip.readUInt32LE(p + 38) >>> 16
    const localOff = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8")
    assert.equal(zip.readUInt32LE(localOff), 0x04034b50, "local 签名")
    assert.equal(zip.readUInt16LE(localOff + 6), 0x0800, "UTF-8 flag")
    assert.equal(zip.readUInt16LE(localOff + 8), 0, "store（不压缩）")
    rows.push({ name, mode, localOff })
    p += 46 + nameLen + extraLen + commentLen
  }
  assert.equal(p, zip.length - 22, "central 正好接到 EOCD")
  return rows
}

test("buildZip：产生标准 store zip，可解析出全部条目", () => {
  const zip = buildZip([
    { name: "kit/", dir: true },
    { name: "kit/a.sh", data: Buffer.from("#!/bin/sh\necho hi\n"), mode: 0o100755 },
    { name: "kit/中文.txt", data: Buffer.from("中文"), mode: 0o100644 },
  ])
  const rows = parseCentral(zip)
  assert.deepEqual(
    rows.map((r) => r.name),
    ["kit/", "kit/a.sh", "kit/中文.txt"],
  )
  assert.equal(
    zip
      .subarray(rows[2].localOff + 30 + Buffer.byteLength("kit/中文.txt", "utf8"))
      .subarray(0, Buffer.byteLength("中文"))
      .toString(),
    "中文",
  )
})

test("buildZip：.sh 带 0755，普通文件 0644，目录 0755", () => {
  const rows = parseCentral(
    buildZip([
      { name: "d/", dir: true },
      { name: "d/run.sh", data: Buffer.from("x"), mode: 0o100755 },
      { name: "d/serve.py", data: Buffer.from("x"), mode: 0o100644 },
    ]),
  )
  assert.equal(rows[0].mode & 0o777, 0o755)
  assert.equal(rows[1].mode & 0o777, 0o755)
  assert.equal(rows[2].mode & 0o777, 0o644)
})

test("buildZip：相同输入逐字节一致（Release 附件可复现）", () => {
  const entries = [
    { name: "kit/", dir: true },
    { name: "kit/phone-setup.sh", data: Buffer.from("#!/bin/sh\n"), mode: 0o100755 },
    { name: "kit/plugin/package.json", data: Buffer.from('{"version":"0.7.15"}'), mode: 0o100644 },
  ]
  assert.deepEqual(buildZip(entries), buildZip(entries))
})
