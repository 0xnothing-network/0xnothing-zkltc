// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Historical one-time migration retained only to prevent accidental replay.
/// @dev The replacement synth architecture requires MigrateSynthSafetyReserve.
contract MigrateRemoveGuard {
    error DeprecatedMigration();

    function run() external pure {
        revert DeprecatedMigration();
    }
}
