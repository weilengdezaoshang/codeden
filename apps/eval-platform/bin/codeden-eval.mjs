#!/usr/bin/env node
import { main } from '../dist/cli/eval-command.js'
process.exitCode = await main()
