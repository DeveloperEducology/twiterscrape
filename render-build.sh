#!/usr/bin/env bash
# exit on error
set -o errexit

npm install
# FIX: Install Chromium without the --with-deps flag to avoid the password prompt error.
npx playwright install chromium

