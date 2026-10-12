#!/bin/sh
set -u
mkdir -p /logs/verifier

if PYTHONPATH=/app/src python -m unittest -v /app/test_public.py /tests/test_cache.py; then
  printf '1\n' > /logs/verifier/reward.txt
else
  printf '0\n' > /logs/verifier/reward.txt
fi
