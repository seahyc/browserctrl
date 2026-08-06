#!/usr/bin/env node
// Back-compat shim: the CLI moved to bin/cdp.mjs in v2. Anything that still
// calls scripts/cdp.mjs keeps working.
import './../bin/cdp.mjs';
