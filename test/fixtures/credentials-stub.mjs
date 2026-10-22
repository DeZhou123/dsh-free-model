/**
 * `@deepseek-ai/dsh-credentials` 的离线替身（同 `kernel-stubs.mjs` 的说明）。
 *
 * 真实的 `credentialRef()` 会按 `/^[A-Za-z_][A-Za-z0-9_]*$/` 校验并打品牌；
 * 这里必须保留**同一条校验**，否则测试会放过真实运行时会抛的名字
 * （例如带 `-` 的 ref）。
 */

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function credentialRef(value) {
  if (!REF_PATTERN.test(value)) throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`)
  return value
}

export function isCredentialRefName(value) {
  return REF_PATTERN.test(value)
}
