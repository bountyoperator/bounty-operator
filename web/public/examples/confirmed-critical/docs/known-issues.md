# Halyard Treasury: known issues

Synthetic programme material written for this example. Reports on these are not eligible.

KI-1. Owners can lower the threshold to 1. `setThreshold` accepts any value from 1 to `ownerCount`. Once `threshold` owners have approved `setThreshold(1)`, every later transaction executes with a single signature. Acknowledged: a configuration the owners choose together.

KI-2. `removeOwner` does not lower the threshold. Removing owners until fewer than `threshold` remain leaves a treasury that can no longer execute anything, including the call that would add an owner back. Acknowledged: operators check the count before they sign a removal.
