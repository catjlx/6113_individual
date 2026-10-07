// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RentalDepositEscrow} from "../RentalDepositEscrow.sol";

/**
 * @dev TEST-ONLY contract. It is never deployed to a real network.
 *      It acts as a malicious tenant: when it receives ether from `withdraw`, it
 *      immediately tries to call `withdraw` again, hoping to drain other users' deposits.
 */
contract ReentrancyAttacker {
    RentalDepositEscrow public immutable escrow;

    uint256 public reentryAttempts;
    uint256 public reentrySuccesses;

    constructor(RentalDepositEscrow _escrow) {
        escrow = _escrow;
    }

    function payDeposit(uint256 leaseId, bytes32 reportHash) external payable {
        escrow.payDeposit{value: msg.value}(leaseId, reportHash);
    }

    function attack() external {
        escrow.withdraw();
    }

    receive() external payable {
        reentryAttempts++;
        try escrow.withdraw() {
            reentrySuccesses++;
        } catch {}
    }
}
