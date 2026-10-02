# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]
- Minor gas optimizations in storage access patterns.
- Additional test coverage for edge cases in ERC-721 transfers.

## [v1.1.0] - 2026-03-15
### Changed
- fix: reentrancy lock on every function that moves ETH or items (KV-01).
- fix: pull-based refunds for outbid offers to prevent DoS via reverting fallback functions (KV-02). Outbid bidders must now call `withdrawRefund()`.
- fix: implement strict floor for reserves at `MIN_RESERVE` (0.01 ETH) to prevent spam lots (KV-04).
- fix: soft-close extension for late offers (KV-09). Regression test: `test_lateOfferPushesClose`.
- fix: two-step ownership transfer implemented via `proposeOwner` and `acceptOwnership` to prevent accidental loss of admin control (KV-11).
- fix: added duration bounds checking during consignment to enforce `MIN_DURATION` and `MAX_DURATION` limits (KV-12).

### Added
- Events for every owner action.

## [v1.0.0] - 2026-02-01
### Added
- Initial release of the Quoinhall English-auction saleroom contract.
- Support for ERC-721 consignments with configurable reserves and durations.
- Permissionless offering and conclusion logic.
