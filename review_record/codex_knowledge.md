# Repository Review Guidance

## Crypto API

- `CryptoUtil.decrypt` is deprecated.
- New and modified code must use `CryptoUtil.decryptV2` instead.
- During code review, flag calls to `CryptoUtil.decrypt` and recommend replacing them with `CryptoUtil.decryptV2`.
