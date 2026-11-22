#!/bin/bash
# Run the B-45 PoC end to end: forge test (Round26A) + node live-SDK modes.
# Exits 0 when the bug reproduces, 1 when it does not.
# Local only: fresh Anvil 4663 per mode, mock API, live SDK verbatim.
# No mainnet, no real funds, no Bull infrastructure.
set -u
cd "$(dirname "$0")"
FORGE="${FORGE:-$HOME/.foundry/bin/forge}"
echo "=== forge: chain/test/Round26A.t.sol ==="
(cd chain && "$FORGE" test --match-contract Round26ATest 2>&1 | tee ../forge-staging.log)
if ! grep -q "6 passed" forge-staging.log; then
  echo "B-45 NOT reproduced (forge did not pass 6/6)"
  exit 1
fi
echo "=== node: run-sdk-fee.mjs k2122 k2122c k2122d ==="
bash run-node.sh k2122 k2122c k2122d 2>&1 | tee run-staging.log
if grep -q '"exploited": true' node-result-k2122.json && grep -q '"treasuryGainedEth": 0.05' node-result-k2122.json && grep -q '"controlClean": true' node-result-k2122c.json && grep -q '"exploited": true' node-result-k2122d.json && grep -q '"treasuryGainedEth": 0.1' node-result-k2122d.json; then
  echo "B-45 reproduced: agree()/deal() never verify feeWei; treasury takes 0.05 ETH per step (forge 6/6, node 3/3)"
  exit 0
fi
echo "B-45 NOT reproduced (node results mismatch)"
exit 1
