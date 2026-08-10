#!/bin/zsh
set -a; . ./.env; set +a
PRIVATE_KEY="$BUYER2_KEY" GATEWAY=https://corpus.ochinimus.app npm run collect -- 2
