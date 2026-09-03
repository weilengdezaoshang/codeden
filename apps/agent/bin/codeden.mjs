#!/usr/bin/env node
import { main } from '../dist/codeden.js'
process.exitCode = await main()
